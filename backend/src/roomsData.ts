import { pool } from "./db.js";
import { isRoomState, type RoomState } from "./domain/roomState.js";

/**
 * Row types + the wire-payload translator, extracted from rooms.ts so
 * both the REST layer and the live (ws) layer can build payloads
 * without importing each other (rooms.ts → live.ts for broadcasting;
 * a payload import in the other direction would close a cycle).
 *
 * Row types are hand-written promises about what the SQL returns —
 * update them with every migration.
 */

export interface RoomRow {
  id: string;
  join_code: string;
  host_id: string;
  state: string;
  created_at: string;
}

export interface ParticipantRow {
  user_id: string;
  display_name: string;
  joined_at: string;
  completed: string; // count(*) comes back from pg as a bigint string
}

export interface CandidateRow {
  candidate_id: string;
  title: string;
  metadata: Record<string, string>;
}

/** The wire shape of a room — mirror of iOS RoomDTO, field for field. */
export interface RoomPayload {
  id: string;
  joinCode: string;
  hostId: string;
  state: RoomState;
  participants: {
    userId: string;
    displayName: string;
    isHost: boolean;
    /** Swipes recorded this round. In the snapshot ON PURPOSE: progress
     *  is also pushed as PROGRESS deltas, but any state delivered ONLY
     *  by delta is lost to whoever was disconnected when it fired. Rule:
     *  every delta-carried fact must also live in the snapshot — deltas
     *  are an accelerator, the snapshot is the truth. */
    completedCount: number;
  }[];
  /** The shared deck; present from ACTIVE onward, absent in LOBBY. */
  candidates?: {
    id: string;
    title: string;
    metadata: Record<string, string>;
  }[];
}

export async function roomPayload(room: RoomRow): Promise<RoomPayload> {
  const { rows: participants } = await pool.query<ParticipantRow>(
    `SELECT rp.user_id, u.display_name, rp.joined_at,
            (SELECT count(*) FROM swipes s
              WHERE s.room_id = rp.room_id AND s.user_id = rp.user_id) AS completed
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
      WHERE rp.room_id = $1
      ORDER BY rp.joined_at`,
    [room.id],
  );
  if (!isRoomState(room.state)) {
    // The CHECK constraint makes this unreachable; the guard keeps the
    // cast honest instead of silent.
    throw new Error(`row carries unknown state '${room.state}'`);
  }
  const { rows: candidates } = await pool.query<CandidateRow>(
    `SELECT candidate_id, title, metadata
       FROM room_candidates WHERE room_id = $1 ORDER BY position`,
    [room.id],
  );
  const payload: RoomPayload = {
    id: room.id,
    joinCode: room.join_code,
    hostId: room.host_id,
    state: room.state,
    participants: participants.map((p) => ({
      userId: p.user_id,
      displayName: p.display_name,
      isHost: p.user_id === room.host_id,
      completedCount: Number(p.completed),
    })),
  };
  if (candidates.length > 0) {
    payload.candidates = candidates.map((c) => ({
      id: c.candidate_id,
      title: c.title,
      metadata: c.metadata,
    }));
  }
  return payload;
}

/** Fetch straight to wire shape by id (used by the broadcast path). */
export async function getRoomPayload(roomId: string): Promise<RoomPayload | null> {
  const { rows } = await pool.query<RoomRow>(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId],
  );
  const room = rows[0];
  return room ? roomPayload(room) : null;
}
