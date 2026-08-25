import assert from "node:assert/strict";
import { test } from "node:test";
import {
  affinity, aggregate, emptyProfile, orderPool, profileFromRows, scoreCandidate,
} from "./scoring.js";

test("profile folds history and affinity smooths it", () => {
  const p = profileFromRows([
    { decision: "YES", metadata: { cuisine: "Japanese", priceLevel: "2" } },
    { decision: "YES", metadata: { cuisine: "Japanese", priceLevel: "3" } },
    { decision: "NO", metadata: { cuisine: "Steak house", priceLevel: "3" } },
  ]);
  assert.equal(p.swipes, 3);
  assert.equal(affinity(p.cuisine["Japanese"]), (2 + 1) / (2 + 0 + 2)); // 0.75
  assert.equal(affinity(p.cuisine["Steak house"]), (0 + 1) / (0 + 1 + 2)); // ~0.33
  assert.equal(affinity(p.cuisine["Thai"]), 0.5); // no evidence → neutral
});

test("cold start scores are neutral, rating breaks the tie", () => {
  const cold = emptyProfile();
  const plain = scoreCandidate(cold, { cuisine: "X", priceLevel: "2", rating: "2.5" });
  const starred = scoreCandidate(cold, { cuisine: "Y", priceLevel: "2", rating: "5.0" });
  assert.ok(Math.abs(plain - 0.5) < 1e-9);
  assert.ok(starred > plain);
});

test("least-misery sinks what one member dreads; average forgives it", () => {
  const lover = profileFromRows(Array.from({ length: 6 }, () =>
    ({ decision: "YES" as const, metadata: { cuisine: "Sichuan" } })));
  const hater = profileFromRows(Array.from({ length: 6 }, () =>
    ({ decision: "NO" as const, metadata: { cuisine: "Sichuan" } })));
  const meta = { cuisine: "Sichuan", rating: "4.0" };
  const scores = [scoreCandidate(lover, meta), scoreCandidate(hater, meta)];
  assert.ok(aggregate(scores, "average") > 0.5);
  assert.ok(aggregate(scores, "least_misery") < 0.45);
});

test("orderPool is deterministic and puts common ground first under least-misery", () => {
  const sushiFan = profileFromRows(Array.from({ length: 5 }, () =>
    ({ decision: "YES" as const, metadata: { cuisine: "Japanese" } })));
  const sushiSkeptic = profileFromRows([
    ...Array.from({ length: 5 }, () => ({ decision: "NO" as const, metadata: { cuisine: "Japanese" } })),
    ...Array.from({ length: 5 }, () => ({ decision: "YES" as const, metadata: { cuisine: "Italian" } })),
  ]);
  const pool = [
    { id: "a", metadata: { cuisine: "Japanese", rating: "4.8" } },
    { id: "b", metadata: { cuisine: "Italian", rating: "4.0" } },
    { id: "c", metadata: { cuisine: "Thai", rating: "4.0" } },
  ];
  const ordered = orderPool(pool, [sushiFan, sushiSkeptic], "least_misery");
  // Italian: fan neutral, skeptic loves. Japanese: skeptic dreads → sinks
  // despite the fan and the stars.
  assert.equal(ordered[0]!.id, "b");
  assert.deepEqual(
    orderPool(pool, [sushiFan, sushiSkeptic], "least_misery").map((c) => c.id),
    ordered.map((c) => c.id)); // same inputs, same deck
});
