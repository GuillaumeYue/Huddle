import { dealDeck } from "./deck.js";
import { enqueueProfileJobs } from "./reco/queue.js";
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

/** Overtime cap: zero consensus deals a fresh deck this many rounds
 *  in total, then the room resolves NO_RESULT — every state has an
 *  exit, and "try again forever" is not one. */
const MAX_ROUNDS = Number(process.env["MAX_ROUNDS"] ?? 2);

/** Trigger B: a room nobody has acted in for this long is settled with
 *  whatever votes exist. The rescue path — a member who never returns,
 *  a table that wandered off — must not leave a room ACTIVE forever. */
const INACTIVITY_MS = Number(process.env["INACTIVITY_MS"] ?? 90_000);

/** How long a tied REVEALING waits for a member's blind pick before the
 *  server picks for the table — every state has an exit. */
export const PICK_TIMEOUT_MS = Number(process.env["PICK_TIMEOUT_MS"] ?? 20_000);

const activityKey = (roomId: string): string => `room:${roomId}:activity`;

/** Called on every swipe (and at start): the timer only counts down
 *  while nobody is acting. */
export async function markActivity(roomId: string): Promise<void> {
  await redisPub.set(activityKey(roomId), String(Date.now()), "EX", 24 * 60 * 60);
}

export async function isInactive(
  roomId: string, thresholdMs: number = INACTIVITY_MS,
): Promise<boolean> {
  const last = await redisPub.get(activityKey(roomId));
  if (!last) return false; // unknown → don't guess, wait for an activity mark
  return Date.now() - Number(last) > thresholdMs;
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
  // A room that timed out is not asked to play again: settle with what
  // exists. Overtime is for engaged tables, not abandoned ones.
  await settle(roomId, p.round, Number(p.roster), broadcast, { allowOvertime: false });
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
         WHERE c.room_id = r.id AND c.round = r.round)             AS deck
     FROM rooms r WHERE r.id = $1`,
    [roomId],
  );
  const p = rows[0];
  if (!p || p.state !== "ACTIVE") return;
  const roster = Number(p.roster);
  if (Number(p.total) < roster * Number(p.deck)) return;
  // An engaged table that rejected everything gets fresh picks.
  await settle(roomId, p.round, roster, broadcast, { allowOvertime: true });
}

export async function settle(
  roomId: string, round: number, threshold: number, broadcast: Broadcast,
  options: { allowOvertime: boolean },
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
  const winners = await winnersFor(roomId, round, threshold);

  // Zero consensus from an engaged table: overtime — TALLY → ACTIVE with
  // a fresh deck and a re-frozen roster, while rounds remain.
  if (winners.length === 0 && options.allowOvertime && round < MAX_ROUNDS) {
    if (await overtime(roomId, round, broadcast)) return;
    // provider exhausted or lost the CAS: fall through to the verdict
  }

  // Every later step is conditional too: a transition whose
  // precondition no longer holds (e.g. the host closed the room
  // mid-tally -> NO_RESULT) matches zero rows instead of rewinding it.
  const { rowCount: revealing } = await pool.query(
    "UPDATE rooms SET state = 'REVEALING' WHERE id = $1 AND state = 'TALLY'",
    [roomId],
  );
  if (revealing !== 1) return;
  await markActivity(roomId); // REVEALING's own clock, for the sweeper's rescue
  await broadcast(roomId);

  // One winner: the server-directed beat, then the verdict. A tie: the
  // table gets PICK_TIMEOUT_MS to tap a blind pick (first tap wins, via
  // the same CAS); if nobody does, the server picks for them. Either
  // way resolveReveal() is a no-op if someone already resolved it.
  await new Promise((r) => setTimeout(r, winners.length > 1 ? PICK_TIMEOUT_MS : REVEAL_MS));
  await resolveReveal(roomId, null, broadcast);
}

async function winnersFor(roomId: string, round: number, threshold: number): Promise<string[]> {
  const { rows } = await pool.query<{ candidate_id: string }>(
    `SELECT candidate_id FROM swipes
      WHERE room_id = $1 AND round = $2 AND decision = 'YES'
      GROUP BY candidate_id
     HAVING count(*) >= $3
      ORDER BY candidate_id`,
    [roomId, round, threshold],
  );
  return rows.map((r) => r.candidate_id);
}

export type RevealOutcome = "resolved" | "already" | "invalid";

/**
 * REVEALING → MATCHED | NO_RESULT. Three callers, one arbiter:
 *   - settle() after the beat / pick timeout (chosen = null → random)
 *   - POST /rooms/:id/pick, a member's blind pick (chosen = their card)
 *   - the timer sweeper rescuing a REVEALING whose settler died
 * The CAS (state = REVEALING AND no result yet) makes them all safe to
 * race: exactly one verdict, the rest learn "already".
 */
export async function resolveReveal(
  roomId: string, chosen: string | null, broadcast: Broadcast,
): Promise<RevealOutcome> {
  const { rows } = await pool.query<{ state: string; round: number; roster: string }>(
    `SELECT r.state, r.round,
       (SELECT count(*) FROM round_roster rr
         WHERE rr.room_id = r.id AND rr.round = r.round) AS roster
     FROM rooms r WHERE r.id = $1`,
    [roomId],
  );
  const p = rows[0];
  if (!p || p.state !== "REVEALING") return "already";
  const winners = await winnersFor(roomId, p.round, Number(p.roster));
  if (chosen !== null && !winners.includes(chosen)) return "invalid";
  const pick = chosen ?? (winners.length === 0
    ? null
    : winners[Math.floor(Math.random() * winners.length)]!);

  const { rowCount } = pick
    ? await pool.query(
        `UPDATE rooms SET state = 'MATCHED', result_candidate_id = $2, closed_at = now()
          WHERE id = $1 AND state = 'REVEALING' AND result_candidate_id IS NULL`,
        [roomId, pick])
    : await pool.query(
        `UPDATE rooms SET state = 'NO_RESULT', closed_at = now()
          WHERE id = $1 AND state = 'REVEALING'`,
        [roomId]);
  if (rowCount !== 1) return "already";
  await broadcast(roomId);
  // The room is settled: its swipes are final evidence. Queue profile
  // rebuilds for the roster — the worker learns, the hot path doesn't.
  const { rows: roster } = await pool.query<{ user_id: string }>(
    "SELECT DISTINCT user_id FROM round_roster WHERE room_id = $1", [roomId]);
  await enqueueProfileJobs(roster.map((r) => r.user_id)).catch((err) =>
    console.error("[settle] enqueue failed:", err));
  return "resolved";
}

/**
 * TALLY → ACTIVE, round + 1. One transaction: the transition, the fresh
 * deck, and the re-frozen roster land together or not at all. The
 * transition is conditional on (TALLY, this round) — the same CAS shape
 * as every other step, so a competing close/settle can't double-deal.
 */
async function overtime(roomId: string, round: number, broadcast: Broadcast): Promise<boolean> {
  const client = await pool.connect();
  let dealt = false;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ round: number }>(
      `UPDATE rooms SET state = 'ACTIVE', round = round + 1
        WHERE id = $1 AND state = 'TALLY' AND round = $2
        RETURNING round`,
      [roomId, round],
    );
    const next = rows[0]?.round;
    if (next !== undefined) {
      await dealDeck(client, roomId, next);
      // Same people, new round: "present" is re-frozen from the previous
      // roster, not from presence — nobody joins or leaves mid-game.
      await client.query(
        `INSERT INTO round_roster (room_id, round, user_id)
         SELECT room_id, $2, user_id FROM round_roster
          WHERE room_id = $1 AND round = $3`,
        [roomId, next, round],
      );
      await client.query("COMMIT");
      dealt = true;
    } else {
      await client.query("ROLLBACK");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[settle] overtime failed, resolving instead:", err);
  } finally {
    client.release();
  }
  if (dealt) {
    await markActivity(roomId); // the inactivity clock restarts with the round
    await broadcast(roomId);
  }
  return dealt;
}
