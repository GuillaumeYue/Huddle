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

/** Poll a room (phase 2 stand-in for the phase-3 realtime push). */
roomsRouter.get("/rooms/:id", async (req, res) => {
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
