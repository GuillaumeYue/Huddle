/** Recommendation probe: synthetic history in, learned ordering out.
 *  Exercises the whole loop: swipes → queue → worker rebuild → cached
 *  profile → orderPool. Requires postgres+redis up. */
import "dotenv/config";
import { randomUUID } from "node:crypto";
const { pool } = await import("../src/db.js");
const { redisPub } = await import("../src/redis.js");
const { buildProfile, getProfiles } = await import("../src/reco/profiles.js");
const { orderPool } = await import("../src/reco/scoring.js");

function check(label: string, ok: boolean): void {
  if (!ok) { console.error(`FAILED: ${label}`); process.exit(1); }
  console.log(`ok  ${label}`);
}

// Synthetic history: a finished room where our user loved Japanese and
// rejected steak, twice each.
const { rows: [user] } = await pool.query<{ id: string }>(
  "INSERT INTO users (display_name) VALUES ('RecoProbe') RETURNING id");
const uid = user!.id;
const { rows: [room] } = await pool.query<{ id: string }>(
  `INSERT INTO rooms (join_code, host_id, state, closed_at)
   VALUES ($1, $2, 'NO_RESULT', now()) RETURNING id`,
  [randomUUID().slice(0, 6).toUpperCase(), uid]);
const rid = room!.id;
const cards = [
  ["j1", { cuisine: "Japanese", priceLevel: "2", rating: "4.2" }, "YES"],
  ["j2", { cuisine: "Japanese", priceLevel: "3", rating: "4.0" }, "YES"],
  ["s1", { cuisine: "Steak house", priceLevel: "3", rating: "4.6" }, "NO"],
  ["s2", { cuisine: "Steak house", priceLevel: "4", rating: "4.7" }, "NO"],
] as const;
for (const [i, [id, meta, decision]] of cards.entries()) {
  await pool.query(
    `INSERT INTO room_candidates (room_id, round, candidate_id, position, title, metadata)
     VALUES ($1, 1, $2, $3, $4, $5)`, [rid, id, i, id, meta]);
  await pool.query(
    `INSERT INTO swipes (room_id, round, user_id, candidate_id, decision)
     VALUES ($1, 1, $2, $3, $4)`, [rid, uid, id, decision]);
}

// Worker path, invoked directly (the worker process runs this same fn).
const profile = await buildProfile(uid);
check("profile learned from 4 swipes", profile.swipes === 4);
check("Japanese affinity above neutral, steak below",
  (profile.cuisine["Japanese"]?.yes ?? 0) === 2 &&
  (profile.cuisine["Steak house"]?.no ?? 0) === 2);

const [cached] = await getProfiles([uid]);
check("profile served from redis cache", cached!.swipes === 4);

// Online path: the pool a provider would hand us, reordered.
const pool20 = [
  { id: "steak", metadata: { cuisine: "Steak house", priceLevel: "3", rating: "4.9" } },
  { id: "sushi", metadata: { cuisine: "Japanese", priceLevel: "2", rating: "4.1" } },
  { id: "thai", metadata: { cuisine: "Thai", priceLevel: "2", rating: "4.5" } },
];
const ordered = orderPool(pool20, [cached!], "least_misery");
check("the deck leads with what the table's history predicts (sushi first)",
  ordered[0]!.id === "sushi");
check("the dreaded steakhouse sank despite 4.9 stars",
  ordered[ordered.length - 1]!.id === "steak");

const cold = await getProfiles([randomUUID()]);
check("unknown user = cold start neutral profile, no rebuild inline",
  cold[0]!.swipes === 0);

console.log("\nrecommendation loop verified: history → profile → ordered deck");
process.exit(0);
