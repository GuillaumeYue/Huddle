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
  }[];
}

export async function roomPayload(room: RoomRow): Promise<RoomPayload> {
  const { rows: participants } = await pool.query<ParticipantRow>(
    `SELECT rp.user_id, u.display_name, rp.joined_at
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

/** Fetch straight to wire shape by id (used by the broadcast path). */
export async function getRoomPayload(roomId: string): Promise<RoomPayload | null> {
  const { rows } = await pool.query<RoomRow>(
    "SELECT * FROM rooms WHERE id = $1",
    [roomId],
  );
  const room = rows[0];
  return room ? roomPayload(room) : null;
}
