import { Router } from "express";
import pg from "pg";
import { pool } from "./db.js";
import { generateJoinCode } from "./joinCode.js";

/**
 * Row types are hand-written promises about what the SQL returns — the
 * compiler checks our USE of these fields, but cannot check the promise
 * itself against the schema. That gap is the price of raw SQL (the
 * Drizzle fork we consciously declined); keep these in one place and
 * update them with every migration.
 */
interface RoomRow {
  id: string;
  join_code: string;
  host_id: string;
  state: string;
  created_at: string;
}

interface ParticipantRow {
  user_id: string;
  display_name: string;
  joined_at: string;
}

const UNIQUE_VIOLATION = "23505";

/** Reject junk before it reaches pg as a 22P02 cast error → 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string): boolean => UUID_RE.test(s);

/** Wire shape for a room, camelCased at the boundary. */
async function roomPayload(room: RoomRow) {
  const { rows: participants } = await pool.query<ParticipantRow>(
    `SELECT rp.user_id, u.display_name, rp.joined_at
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
      WHERE rp.room_id = $1
      ORDER BY rp.joined_at`,
    [room.id],
  );
  return {
    id: room.id,
    joinCode: room.join_code,
    hostId: room.host_id,
    state: room.state,
    participants: participants.map((p) => ({
      userId: p.user_id,
      displayName: p.display_name,
      isHost: p.user_id === room.host_id,
    })),
  };
}

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
  await pool.query(
    `INSERT INTO room_participants (room_id, user_id) VALUES ($1, $2)
     ON CONFLICT (room_id, user_id) DO NOTHING`,
    [room.id, userId],
  );

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

  const { rows } = await pool.query<RoomRow>(
    `UPDATE rooms SET state = 'ACTIVE'
      WHERE id = $1 AND host_id = $2 AND state = 'LOBBY'
      RETURNING *`,
    [roomId, userId],
  );
  const room = rows[0];
  if (room) {
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
  // rowCount 0 here just means the target was already gone — fine.
  void rowCount;
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
