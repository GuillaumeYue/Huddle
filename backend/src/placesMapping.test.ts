import assert from "node:assert/strict";
import { test } from "node:test";
import { mapPlace } from "./placesMapping.js";

// The provider ↔ card-view contract the mock has rehearsed since
// phase 1: every metadata value a string, keys the card knows.
test("mapPlace turns a wire place into an opaque seed", () => {
  const seed = mapPlace({
    id: "ChIJxyz",
    displayName: { text: "Schwartz's Deli" },
    rating: 4.4,
    priceLevel: "PRICE_LEVEL_MODERATE",
    primaryTypeDisplayName: { text: "Deli" },
    location: { latitude: 45.5165, longitude: -73.5771 },
  }, 45.5019, -73.5674);
  assert.ok(seed);
  assert.equal(seed.id, "ChIJxyz");
  assert.equal(seed.title, "Schwartz's Deli");
  assert.equal(seed.metadata["cuisine"], "Deli");
  assert.equal(seed.metadata["rating"], "4.4");
  assert.equal(seed.metadata["priceLevel"], "2");
  const d = Number(seed.metadata["distanceMeters"]);
  assert.ok(d > 1400 && d < 2200, `distance ${d} should be ~1.8km`);
});

test("mapPlace tolerates sparse places and rejects nameless ones", () => {
  const sparse = mapPlace({ id: "x", displayName: { text: "Nameless Noodles" } }, 45.5, -73.5);
  assert.ok(sparse);
  assert.equal(sparse.metadata["cuisine"], "Restaurant");
  assert.equal("rating" in sparse.metadata, false);
  assert.equal(mapPlace({ id: "y" }, 45.5, -73.5), null);
});
