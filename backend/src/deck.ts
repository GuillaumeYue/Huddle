import type pg from "pg";
import { MockRestaurantProvider, type CandidateProvider } from "./candidates.js";

/**
 * Dealing a deck — shared by the start transaction and by overtime.
 * Runs INSIDE the caller's transaction (client, not pool): a round
 * transition and its deck land together or not at all.
 */
export const DECK_SIZE = 10;

/** Swapped for the Google Places provider in phase 5; nothing here
 *  knows or cares which one it is. */
const provider: CandidateProvider = new MockRestaurantProvider();

export async function dealDeck(
  client: pg.PoolClient, roomId: string, round: number,
): Promise<void> {
  // "Never the same deck": everything this room has already shown is
  // excluded, across all rounds.
  const { rows } = await client.query<{ candidate_id: string }>(
    "SELECT candidate_id FROM room_candidates WHERE room_id = $1",
    [roomId],
  );
  const used = new Set(rows.map((r) => r.candidate_id));
  const deck = await provider.fetchCandidates(DECK_SIZE, used);
  if (deck.length === 0) {
    throw new Error("candidate provider exhausted — no fresh deck available");
  }
  for (const [position, candidate] of deck.entries()) {
    await client.query(
      `INSERT INTO room_candidates (room_id, round, candidate_id, position, title, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [roomId, round, candidate.id, position, candidate.title, candidate.metadata],
    );
  }
}
