import { pool } from "./db.js";
import { isRoomState, type RoomState } from "./domain/roomState.js";
import { redisPub } from "./redis.js";

export const presenceKey = (roomId: string, userId: string): string =>
  `presence:${roomId}:${userId}`;

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
  round: number;
  result_candidate_id: string | null;
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
  /** Current round; overtime bumps it. Swipes and the roster key on it. */
  round: number;
  /** Settled outcome, present only in MATCHED. pickedBy = how many
   *  hidden picks the winner received, when any were cast. */
  result?: { candidateId: string; pickedBy?: number };
  /** Consensus threshold (v1: the frozen roster size). From TALLY on. */
  threshold?: number;
  /** Yes-counts per candidate for the current round, most first. From
   *  TALLY on — never during ACTIVE, so nobody's ballot leaks before
   *  the reveal. */
  tally?: { candidateId: string; yes: number }[];
  /** Candidates that ALL reached consensus: the blind pick is pending.
   *  Present only in REVEALING while no result exists. */
  tie?: string[];
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
    /** Live-socket presence, read from Redis. Affects UX and (later)
     *  the inactivity timeout — NEVER the tally denominator; that
     *  decision is the "definition of present" fork. */
    connected: boolean;
    /** Has this member cast their hidden pick (REVEALING only). The
     *  pick itself stays secret until the verdict — only the fact. */
    hasPicked: boolean;
  }[];
  /** The CURRENT round's shared deck; present from ACTIVE onward. */
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
              WHERE s.room_id = rp.room_id AND s.user_id = rp.user_id
                AND s.round = $2) AS completed
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
      WHERE rp.room_id = $1
      ORDER BY rp.joined_at`,
    [room.id, room.round],
  );
  if (!isRoomState(room.state)) {
    // The CHECK constraint makes this unreachable; the guard keeps the
    // cast honest instead of silent.
    throw new Error(`row carries unknown state '${room.state}'`);
  }
  const { rows: candidates } = await pool.query<CandidateRow>(
    `SELECT candidate_id, title, metadata
       FROM room_candidates WHERE room_id = $1 AND round = $2 ORDER BY position`,
    [room.id, room.round],
  );
  const pickedSet = new Set<string>();
  if (room.state === "REVEALING") {
    const { rows: cast } = await pool.query<{ user_id: string }>(
      "SELECT user_id FROM picks WHERE room_id = $1 AND round = $2",
      [room.id, room.round]);
    for (const c of cast) pickedSet.add(c.user_id);
  }
  // Presence lives in Redis (live state, rebuildable); one pipelined
  // EXISTS per participant.
  const flags = participants.length === 0 ? [] :
    await redisPub.pipeline(
      participants.map((p) => ["exists", presenceKey(room.id, p.user_id)]),
    ).exec();

  const payload: RoomPayload = {
    id: room.id,
    joinCode: room.join_code,
    hostId: room.host_id,
    state: room.state,
    round: room.round,
    participants: participants.map((p, i) => ({
      userId: p.user_id,
      displayName: p.display_name,
      isHost: p.user_id === room.host_id,
      completedCount: Number(p.completed),
      connected: Boolean(flags?.[i]?.[1]),
      hasPicked: pickedSet.has(p.user_id),
    })),
  };
  if (room.result_candidate_id) {
    payload.result = { candidateId: room.result_candidate_id };
    const { rows: pb } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM picks
        WHERE room_id = $1 AND round = $2 AND candidate_id = $3`,
      [room.id, room.round, room.result_candidate_id]);
    const pickedBy = Number(pb[0]?.n ?? 0);
    if (pickedBy > 0) payload.result.pickedBy = pickedBy;
  }
  if (room.state !== "LOBBY" && room.state !== "ACTIVE") {
    const [{ rows: tally }, { rows: roster }] = await Promise.all([
      pool.query<{ candidate_id: string; yes: string }>(
        `SELECT candidate_id, count(*) AS yes FROM swipes
          WHERE room_id = $1 AND round = $2 AND decision = 'YES'
          GROUP BY candidate_id ORDER BY yes DESC, candidate_id`,
        [room.id, room.round]),
      pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM round_roster WHERE room_id = $1 AND round = $2",
        [room.id, room.round]),
    ]);
    const threshold = Number(roster[0]?.n ?? 0);
    payload.threshold = threshold;
    payload.tally = tally.map((t) => ({ candidateId: t.candidate_id, yes: Number(t.yes) }));
    if (room.state === "REVEALING" && !room.result_candidate_id) {
      const winners = payload.tally.filter((t) => t.yes >= threshold).map((t) => t.candidateId);
      if (winners.length > 1) payload.tie = winners;
    }
  }
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
