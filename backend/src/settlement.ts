import { pool } from "./db.js";

/**
 * ACTIVE → TALLY → REVEALING → MATCHED | NO_RESULT.
 *
 * Settlement has TWO triggers (all-done here; the inactivity timeout
 * later) and may be attempted by several processes at once. It must
 * run exactly once per round.
 *
 * NAIVE VERSION, on purpose: look-then-act. Read the state, see
 * ACTIVE, proceed. Two concurrent settlers both see ACTIVE, both tally,
 * both pick a winner, both direct the reveal — the demo script shows
 * two REVEALs and, with a multi-way match, two DIFFERENT winners
 * announced for one dinner. The CAS fix follows.
 */

/** How long the server holds the REVEALING beat before the verdict. */
const REVEAL_MS = Number(process.env["REVEAL_MS"] ?? 2500);

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
  // NAIVE: look, then act. The gap between these two statements is
  // where the second settler walks in.
  const { rows: look } = await pool.query<{ state: string }>(
    "SELECT state FROM rooms WHERE id = $1", [roomId]);
  if (look[0]?.state !== "ACTIVE") return;
  await pool.query("UPDATE rooms SET state = 'TALLY' WHERE id = $1", [roomId]);
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

  await pool.query("UPDATE rooms SET state = 'REVEALING' WHERE id = $1", [roomId]);
  await broadcast(roomId);
  await new Promise((r) => setTimeout(r, REVEAL_MS)); // the server-directed beat

  if (pick) {
    await pool.query(
      `UPDATE rooms SET state = 'MATCHED', result_candidate_id = $2, closed_at = now()
        WHERE id = $1`,
      [roomId, pick],
    );
  } else {
    await pool.query(
      "UPDATE rooms SET state = 'NO_RESULT', closed_at = now() WHERE id = $1",
      [roomId],
    );
  }
  await broadcast(roomId);
}
