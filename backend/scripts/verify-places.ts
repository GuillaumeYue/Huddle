/** Live probe for the Google Places provider. Needs a key in .env.
 *    npx tsx --env-file=.env scripts/verify-places.ts  (or via dotenv) */
import "dotenv/config";
const { GooglePlacesProvider, placesConfigured } = await import("../src/googlePlaces.js");

if (!placesConfigured()) {
  console.error("no GOOGLE_PLACES_API_KEY in backend/.env — configure it first");
  process.exit(2);
}
const provider = new GooglePlacesProvider();
const t0 = Date.now();
const first = await provider.fetchCandidates(10);
const t1 = Date.now();
const second = await provider.fetchCandidates(10);
const t2 = Date.now();

function check(label: string, ok: boolean): void {
  if (!ok) { console.error(`FAILED: ${label}`); process.exit(1); }
  console.log(`ok  ${label}`);
}
check("returns a full deck", first.length === 10);
check("ids are unique", new Set(first.map((c) => c.id)).size === 10);
check("every metadata value is a string",
  first.every((c) => Object.values(c.metadata).every((v) => typeof v === "string")));
check(`second fetch is cache-served (${t2 - t1}ms vs ${t1 - t0}ms)`, t2 - t1 < 50);
const excl = new Set(first.map((c) => c.id));
const overtimeDeck = await provider.fetchCandidates(10, excl);
check("an excluding set yields only unseen candidates",
  overtimeDeck.every((c) => !excl.has(c.id)));
const withPhotos = first.filter((c) => c.metadata["photoUrl"]?.startsWith("https://"));
check(`photos resolved to keyless public urls (${withPhotos.length}/10)`,
  withPhotos.length >= 5);

console.log("\nreal Montréal, via cache:");
for (const c of first) {
  console.log(`  ${c.title}  ·  ${c.metadata["cuisine"] ?? "?"} · ★${c.metadata["rating"] ?? "–"} · ${c.metadata["distanceMeters"] ?? "?"}m`);
}
process.exit(0);
