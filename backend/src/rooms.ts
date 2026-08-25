import { Router } from "express";
import pg from "pg";
import { pool } from "./db.js";
import { dealDeck } from "./deck.js";
import { generateJoinCode } from "./joinCode.js";
import { hub } from "./live.js";
import { roomPayload, type RoomRow } from "./roomsData.js";
import { markActivity, resolvePick } from "./settlement.js";

const UNIQUE_VIOLATION = "23505";

/** Fire-and-forget push to everyone connected to the room. Deliberately
 *  not awaited: the HTTP response shouldn't wait on fan-out, and a
 *  broadcast failure must not fail the mutation that already committed. */
function notify(roomId: string): void {
  hub.broadcastRoom(roomId).catch((err) => {
    console.error("[live] broadcast failed:", err);
  });
}

/** Reject junk before it reaches pg as a 22P02 cast error → 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string): boolean => UUID_RE.test(s);

export const roomsRouter = Router();

/**
 * Create a room. The join-code collision is handled the honest way:
 * INSERT and let the partial unique index judge. Check-then-insert would
 * be a read-modify-write race across the network — the exact bug class
 * from weapon three of the architecture notes.
 *
 * Retry on 23505: with 31^6 codes the loop virtually never runs twice;
 * it exists because "virtually never" times enough users is "sometimes".
 */
roomsRouter.post("/rooms", async (req, res) => {
  const hostId: unknown = req.body?.hostId;
  if (typeof hostId !== "string" || hostId.length === 0) {
    res.status(400).json({ error: "hostId (string) is required" });
    return;
  }

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Room + host membership must appear together or not at all: a room
    // whose host isn't a participant is unrepresentable state.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<RoomRow>(
        "INSERT INTO rooms (join_code, host_id) VALUES ($1, $2) RETURNING *",
        [generateJoinCode(), hostId],
      );
      const room = rows[0]!;
      await client.query(
        "INSERT INTO room_participants (room_id, user_id) VALUES ($1, $2)",
        [room.id, hostId],
      );
      await client.query("COMMIT");
      res.status(201).json(await roomPayload(room));
      return;
    } catch (err) {
      await client.query("ROLLBACK");
      const isCodeCollision =
        err instanceof pg.DatabaseError &&
        err.code === UNIQUE_VIOLATION &&
        err.constraint === "rooms_live_join_code";
      if (!isCodeCollision) throw err; // FK violation (unknown host) etc.
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`join-code collision ${MAX_ATTEMPTS}x — inspect code-space health`);
      }
      // else: fresh random code next loop
    } finally {
      client.release();
    }
  }
});

/**
 * Join by code. LOBBY-only for now: joining a live (ACTIVE+) room is the
 * unresolved "definition of present" question — deliberately not
 * answered in phase 2.
 */
roomsRouter.post("/rooms/join", async (req, res) => {
  const code: unknown = req.body?.code;
  const userId: unknown = req.body?.userId;
  if (typeof code !== "string" || typeof userId !== "string") {
    res.status(400).json({ error: "code and userId (strings) are required" });
    return;
  }

  const { rows } = await pool.query<RoomRow>(
    "SELECT * FROM rooms WHERE join_code = $1 AND closed_at IS NULL",
    [code.toUpperCase()],
  );
  const room = rows[0];
  if (!room) {
    res.status(404).json({ error: "no live room with that code" });
    return;
  }
  if (room.state !== "LOBBY") {
    res.status(409).json({ error: "room already started" });
    return;
  }

  // Idempotent by declaration: rejoin/double-tap hits the (room_id,
  // user_id) primary key and becomes a no-op instead of an error.
  const { rowCount } = await pool.query(
    `INSERT INTO room_participants (room_id, user_id) VALUES ($1, $2)
     ON CONFLICT (room_id, user_id) DO NOTHING`,
    [room.id, userId],
  );
  // Broadcast only on actual change — the idempotent no-op moved nothing.
  if (rowCount === 1) notify(room.id);

  res.json(await roomPayload(room));
});

/**
 * Host starts the room: LOBBY → ACTIVE.
 *
 * The interesting move: authorization (host_id) and the state
 * precondition (state = 'LOBBY') live INSIDE the UPDATE's WHERE — one
 * atomic conditional statement, Postgres's native CAS. A separate
 * SELECT-check-then-UPDATE would be a read-modify-write race: the host
 * double-taps on two devices, both checks pass, both updates run.
 * Here the second one simply matches zero rows.
 *
 * Act first, diagnose only on failure: the follow-up SELECT exists to
 * pick the right status code, not to make the decision.
 */
roomsRouter.post("/rooms/:id/start", async (req, res) => {
  const roomId = req.params.id;
  const userId: unknown = req.body?.userId;
  if (typeof userId !== "string" || !isUuid(userId) || !isUuid(roomId)) {
    res.status(400).json({ error: "valid roomId and userId are required" });
    return;
  }

  // CAS + deck generation in ONE transaction: a room in ACTIVE with no
  // deck is unrepresentable — either the transition and all ten
  // candidates land together, or neither does.
  const client = await pool.connect();
  let room: RoomRow | undefined;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<RoomRow>(
      `UPDATE rooms SET state = 'ACTIVE'
        WHERE id = $1 AND host_id = $2 AND state = 'LOBBY'
        RETURNING *`,
      [roomId, userId],
    );
    room = rows[0];
    if (room) {
      await dealDeck(client, room.id, room.round);
      // Freeze the roster — "present" is decided here, by fact: whoever
      // is in the room as the round starts IS the denominator, for the
      // whole round, regardless of what their WiFi does later.
      await client.query(
        `INSERT INTO round_roster (room_id, round, user_id)
         SELECT room_id, $2, user_id FROM room_participants WHERE room_id = $1`,
        [room.id, room.round],
      );
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (room) {
    await markActivity(room.id); // the inactivity clock starts with the round
    notify(room.id);
    res.json(await roomPayload(room));
    return;
  }

  const { rows: probe } = await pool.query<RoomRow>(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId],
  );
  const existing = probe[0];
  if (!existing) res.status(404).json({ error: "room not found" });
  else if (existing.host_id !== userId)
    res.status(403).json({ error: "only the host can start the room" });
  else res.status(409).json({ error: `room is ${existing.state}, not LOBBY` });
});

/**
 * Host removes a participant while still in LOBBY — the approval gate
 * doing its job. Kicking someone who already left is a no-op (idempotent
 * like join); kicking the host is refused.
 */
roomsRouter.post("/rooms/:id/kick", async (req, res) => {
  const roomId = req.params.id;
  const hostId: unknown = req.body?.hostId;
  const targetUserId: unknown = req.body?.targetUserId;
  if (
    typeof hostId !== "string" || typeof targetUserId !== "string" ||
    !isUuid(roomId) || !isUuid(hostId) || !isUuid(targetUserId)
  ) {
    res.status(400).json({ error: "valid roomId, hostId, targetUserId are required" });
    return;
  }
  if (hostId === targetUserId) {
    res.status(400).json({ error: "host cannot kick themselves (close the room instead)" });
    return;
  }

  // Same CAS shape as /start: the host/LOBBY preconditions are part of
  // the DELETE itself, via a subquery — no separate check to race with.
  const { rowCount } = await pool.query(
    `DELETE FROM room_participants
      WHERE room_id = $1 AND user_id = $2
        AND room_id IN (
          SELECT id FROM rooms
           WHERE id = $1 AND host_id = $3 AND state = 'LOBBY' AND closed_at IS NULL
        )`,
    [roomId, targetUserId, hostId],
  );

  const { rows } = await pool.query<RoomRow>(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId],
  );
  const room = rows[0];
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  if (room.host_id !== hostId) {
    res.status(403).json({ error: "only the host can kick" });
    return;
  }
  if (room.state !== "LOBBY") {
    res.status(409).json({ error: "room already started" });
    return;
  }
  // rowCount 0 just means the target was already gone — no broadcast.
  if (rowCount === 1) notify(room.id);
  res.json(await roomPayload(room));
});

/**
 * Host ends the room at any time ("host may end anytime" — the
 * guaranteed exit). Sets closed_at, which releases the join code (the
 * partial unique index only guards live rooms). A room that already
 * reached a terminal state keeps it; anything else resolves NO_RESULT.
 */
roomsRouter.post("/rooms/:id/close", async (req, res) => {
  const roomId = req.params.id;
  const userId: unknown = req.body?.userId;
  if (typeof userId !== "string" || !isUuid(userId) || !isUuid(roomId)) {
    res.status(400).json({ error: "valid roomId and userId are required" });
    return;
  }

  const { rows } = await pool.query<RoomRow>(
    `UPDATE rooms
        SET closed_at = now(),
            state = CASE WHEN state IN ('MATCHED', 'NO_RESULT')
                         THEN state ELSE 'NO_RESULT' END
      WHERE id = $1 AND host_id = $2 AND closed_at IS NULL
      RETURNING *`,
    [roomId, userId],
  );
  const room = rows[0];
  if (room) {
    notify(room.id); // terminal broadcast: hub closes the channel after it
    res.json(await roomPayload(room));
    return;
  }

  const { rows: probe } = await pool.query<RoomRow>(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId],
  );
  const existing = probe[0];
  if (!existing) res.status(404).json({ error: "room not found" });
  else if (existing.host_id !== userId)
    res.status(403).json({ error: "only the host can close the room" });
  else res.json(await roomPayload(existing)); // already closed — idempotent
});

/**
 * The blind pick, decision C: EVERY roster member casts one hidden
 * pick; when the roster is complete (or the pick timeout fires) the
 * most-picked card wins, exact top ties broken by server random. A
 * member's first cast is final (PK); a second cast gets 409.
 */
roomsRouter.post("/rooms/:id/pick", async (req, res) => {
  const roomId = req.params.id;
  const userId: unknown = req.body?.userId;
  const candidateId: unknown = req.body?.candidateId;
  if (typeof userId !== "string" || !isUuid(userId) || !isUuid(roomId) ||
      typeof candidateId !== "string") {
    res.status(400).json({ error: "valid roomId, userId and candidateId are required" });
    return;
  }
  const { rows: member } = await pool.query(
    `SELECT 1 FROM round_roster rr JOIN rooms r ON r.id = rr.room_id
      WHERE rr.room_id = $1 AND rr.user_id = $2 AND rr.round = r.round`,
    [roomId, userId],
  );
  if (member.length === 0) {
    res.status(403).json({ error: "only members of this round may pick" });
    return;
  }
  const outcome = await resolvePick(
    roomId, userId, candidateId, (id) => hub.broadcastRoom(id));
  const { rows } = await pool.query<RoomRow>("SELECT * FROM rooms WHERE id = $1", [roomId]);
  const room = rows[0];
  if (!room) { res.status(404).json({ error: "room not found" }); return; }
  if (outcome === "invalid") {
    res.status(400).json({ error: "that candidate is not part of the tie" });
    return;
  }
  if (outcome === "already_picked") {
    res.status(409).json({ error: "you already picked" });
    return;
  }
  if (outcome === "closed") {
    res.status(409).json({ error: "the reveal is already decided" });
    return;
  }
  res.json(await roomPayload(room));
});

/** Poll a room (phase 2 stand-in for the phase-3 realtime push). */
roomsRouter.get("/rooms/:id", async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  const { rows } = await pool.query<RoomRow>(
    "SELECT * FROM rooms WHERE id = $1",
    [req.params.id],
  );
  const room = rows[0];
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  res.json(await roomPayload(room));
});
