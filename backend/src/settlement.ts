import { pool } from "./db.js";
import { redisPub } from "./redis.js";

/**
 * ACTIVE → TALLY → REVEALING → MATCHED | NO_RESULT.
 *
 * Settlement has TWO triggers (all-done here; the inactivity timeout
 * later) and may be attempted by several processes at once. It must
 * run exactly once per round.
 *
 * Exactly-once by CAS (the naive look-then-act version is in history:
 * 4/5 trials double-settled, one rewound a MATCHED room back to TALLY).
 * Every transition is a conditional UPDATE whose WHERE carries the
 * precondition from the state machine's table — the same Postgres-
 * native CAS as /start. The first settler's claim matches the row;
 * every other settler's matches zero rows and stands down. No lock,
 * no leader, no coordination: the row itself is the arbiter.
 */

/** How long the server holds the REVEALING beat before the verdict. */
const REVEAL_MS = Number(process.env["REVEAL_MS"] ?? 2500);

/** Trigger B: a room nobody has acted in for this long is settled with
 *  whatever votes exist. The rescue path — a member who never returns,
 *  a table that wandered off — must not leave a room ACTIVE forever. */
const INACTIVITY_MS = Number(process.env["INACTIVITY_MS"] ?? 90_000);

const activityKey = (roomId: string): string => `room:${roomId}:activity`;

/** Called on every swipe (and at start): the timer only counts down
 *  while nobody is acting. */
export async function markActivity(roomId: string): Promise<void> {
  await redisPub.set(activityKey(roomId), String(Date.now()), "EX", 24 * 60 * 60);
}

export async function isInactive(roomId: string): Promise<boolean> {
  const last = await redisPub.get(activityKey(roomId));
  if (!last) return false; // unknown → don't guess, wait for an activity mark
  return Date.now() - Number(last) > INACTIVITY_MS;
}

/** Trigger B entry: settle with partial votes. settle() is CAS-guarded,
 *  so this may be called by any number of timers — at most one acts. */
export async function settleByTimeout(roomId: string, broadcast: Broadcast): Promise<void> {
  const { rows } = await pool.query<{ state: string; round: number; roster: string }>(
    `SELECT r.state, r.round,
       (SELECT count(*) FROM round_roster rr
         WHERE rr.room_id = r.id AND rr.round = r.round) AS roster
     FROM rooms r WHERE r.id = $1`,
    [roomId],
  );
  const p = rows[0];
  if (!p || p.state !== "ACTIVE") return;
  await settle(roomId, p.round, Number(p.roster), broadcast);
}

type Broadcast = (roomId: string) => Promise<void>;

interface Progress {
  state: string;
  round: number;
  roster: string;
  total: string;
  deck: string;
}

/** Trigger A: every member of the frozen roster has swiped the whole
 *  deck. Threshold for v1 consensus == roster size (configured value,
 *  not a hard-coded branch — "majority" later is a parameter change). */
export async function settleIfAllDone(roomId: string, broadcast: Broadcast): Promise<void> {
  const { rows } = await pool.query<Progress>(
    `SELECT r.state, r.round,
       (SELECT count(*) FROM round_roster rr
         WHERE rr.room_id = r.id AND rr.round = r.round)          AS roster,
       (SELECT count(*) FROM swipes s
         WHERE s.room_id = r.id AND s.round = r.round)            AS total,
       (SELECT count(*) FROM room_candidates c
         WHERE c.room_id = r.id)                                  AS deck
     FROM rooms r WHERE r.id = $1`,
    [roomId],
  );
  const p = rows[0];
  if (!p || p.state !== "ACTIVE") return;
  const roster = Number(p.roster);
  if (Number(p.total) < roster * Number(p.deck)) return;
  await settle(roomId, p.round, roster, broadcast);
}

export async function settle(
  roomId: string, round: number, threshold: number, broadcast: Broadcast,
): Promise<void> {
  // The claim. ACTIVE -> TALLY happens exactly once per round because
  // only one UPDATE can find the row still in ACTIVE.
  const { rowCount: claimed } = await pool.query(
    "UPDATE rooms SET state = 'TALLY' WHERE id = $1 AND state = 'ACTIVE'",
    [roomId],
  );
  if (claimed !== 1) return; // another settler got here first — stand down
  await broadcast(roomId);

  // The tally itself is one aggregate over the durable, PK-deduped
  // swipes — Postgres counts atomically; the hard part was never the
  // counting, it is making sure only ONE settler acts on the count.
  const { rows: winners } = await pool.query<{ candidate_id: string }>(
    `SELECT candidate_id FROM swipes
      WHERE room_id = $1 AND round = $2 AND decision = 'YES'
      GROUP BY candidate_id
     HAVING count(*) >= $3`,
    [roomId, round, threshold],
  );
  // Multi-way full consensus = a tie among winners → blind pick.
  // (v1: server-side random; the user-tapped blind pick is UI polish.)
  const pick = winners.length === 0
    ? null
    : winners[Math.floor(Math.random() * winners.length)]!.candidate_id;

  // Every later step is conditional too: a transition whose
  // precondition no longer holds (e.g. the host closed the room
  // mid-tally -> NO_RESULT) matches zero rows instead of rewinding it.
  const { rowCount: revealing } = await pool.query(
    "UPDATE rooms SET state = 'REVEALING' WHERE id = $1 AND state = 'TALLY'",
    [roomId],
  );
  if (revealing !== 1) return;
  await broadcast(roomId);
  await new Promise((r) => setTimeout(r, REVEAL_MS)); // the server-directed beat

  if (pick) {
    await pool.query(
      `UPDATE rooms SET state = 'MATCHED', result_candidate_id = $2, closed_at = now()
        WHERE id = $1 AND state = 'REVEALING'`,
      [roomId, pick],
    );
  } else {
    await pool.query(
      `UPDATE rooms SET state = 'NO_RESULT', closed_at = now()
        WHERE id = $1 AND state = 'REVEALING'`,
      [roomId],
    );
  }
  await broadcast(roomId);
}
