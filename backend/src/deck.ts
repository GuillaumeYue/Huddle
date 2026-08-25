import type pg from "pg";
import { MockRestaurantProvider, type CandidateProvider } from "./candidates.js";
import { GooglePlacesProvider, placesConfigured } from "./googlePlaces.js";
import { getProfiles } from "./reco/profiles.js";
import { orderPool, type Aggregation } from "./reco/scoring.js";

/**
 * Dealing a deck — shared by the start transaction and by overtime.
 * Runs INSIDE the caller's transaction (client, not pool): a round
 * transition and its deck land together or not at all.
 */
export const DECK_SIZE = 10;

/** Real data when a key is configured, the mock otherwise — same
 *  contract, and nothing downstream knows or cares which one it is. */
const provider: CandidateProvider = placesConfigured()
  ? new GooglePlacesProvider()
  : new MockRestaurantProvider();
console.log(`[deck] candidate provider: ${placesConfigured() ? "Google Places" : "mock"}`);

const AGGREGATION: Aggregation =
  process.env["RECO_AGGREGATION"] === "average" ? "average" : "least_misery";

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
  // Over-fetch so the recommender has something to choose FROM, then
  // order by the table's cached taste profiles. This is the ONLINE half
  // of the recommender: a dot product over ≤2×DECK_SIZE candidates with
  // precomputed profiles — microseconds. The heavy half (building those
  // profiles) lives in the worker; a cache miss here means cold start
  // (neutral profile), never an inline rebuild.
  const fetched = await provider.fetchCandidates(DECK_SIZE * 2, used);
  if (fetched.length === 0) {
    throw new Error("candidate provider exhausted — no fresh deck available");
  }
  const { rows: members } = await client.query<{ user_id: string }>(
    "SELECT user_id FROM room_participants WHERE room_id = $1", [roomId]);
  const profiles = await getProfiles(members.map((m) => m.user_id));
  const deck = orderPool(fetched, profiles, AGGREGATION).slice(0, DECK_SIZE);
  for (const [position, candidate] of deck.entries()) {
    await client.query(
      `INSERT INTO room_candidates (room_id, round, candidate_id, position, title, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [roomId, round, candidate.id, position, candidate.title, candidate.metadata],
    );
  }
}
