/**
 * Recommendation phase 1+2 — the PURE half. No I/O: importable by unit
 * tests and by both the worker (offline, heavy) and the deal path
 * (online, light) without dragging connections along.
 *
 * Explainability is a design constraint: every score decomposes into
 * named parts (cuisine affinity, price affinity, rating prior), so
 * "why was this card first" always has an answer.
 */

/** Per-feature evidence: how often this user said yes/no to it. */
export interface FeatureCounts {
  yes: number;
  no: number;
}

export interface TasteProfile {
  cuisine: Record<string, FeatureCounts>;
  priceLevel: Record<string, FeatureCounts>;
  swipes: number;
}

export const emptyProfile = (): TasteProfile =>
  ({ cuisine: {}, priceLevel: {}, swipes: 0 });

export interface SwipeRow {
  decision: "YES" | "NO";
  metadata: Record<string, string>;
}

/** Fold raw swipe history into a profile. */
export function profileFromRows(rows: SwipeRow[]): TasteProfile {
  const profile = emptyProfile();
  for (const row of rows) {
    profile.swipes++;
    for (const [dimension, key] of [
      ["cuisine", row.metadata["cuisine"]],
      ["priceLevel", row.metadata["priceLevel"]],
    ] as const) {
      if (!key) continue;
      const dim = profile[dimension];
      const counts = (dim[key] ??= { yes: 0, no: 0 });
      counts[row.decision === "YES" ? "yes" : "no"]++;
    }
  }
  return profile;
}

/** Laplace-smoothed affinity: no evidence → a neutral 0.5, never a
 *  hard 0 or 1 from a single swipe. */
export function affinity(counts: FeatureCounts | undefined): number {
  const yes = counts?.yes ?? 0;
  const no = counts?.no ?? 0;
  return (yes + 1) / (yes + no + 2);
}

const W_CUISINE = 0.6;
const W_PRICE = 0.2;
const W_RATING = 0.2;

/** One user's predicted appetite for one candidate, in [0, 1]. */
export function scoreCandidate(
  profile: TasteProfile, metadata: Record<string, string>,
): number {
  const cuisine = affinity(metadata["cuisine"] ? profile.cuisine[metadata["cuisine"]] : undefined);
  const price = affinity(metadata["priceLevel"] ? profile.priceLevel[metadata["priceLevel"]] : undefined);
  const rating = metadata["rating"] ? Number(metadata["rating"]) / 5 : 0.5;
  return W_CUISINE * cuisine + W_PRICE * price + W_RATING * rating;
}

/**
 * Group aggregation — the fairness fork, both sides implemented:
 *   average      — maximize the table's total happiness; a strong
 *                  majority can outvote one member's dread.
 *   least-misery — the group is only as happy as its least happy
 *                  member; one person's strong dislike sinks a card.
 */
export type Aggregation = "average" | "least_misery";

export function aggregate(scores: number[], mode: Aggregation): number {
  if (scores.length === 0) return 0.5;
  if (mode === "least_misery") return Math.min(...scores);
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/** Order a candidate pool for a set of member profiles, best first.
 *  Deterministic: ties break by rating, then id — the same pool and
 *  profiles always deal the same deck. */
export function orderPool<C extends { id: string; metadata: Record<string, string> }>(
  pool: C[], profiles: TasteProfile[], mode: Aggregation,
): C[] {
  const scored = pool.map((candidate) => ({
    candidate,
    score: aggregate(profiles.map((p) => scoreCandidate(p, candidate.metadata)), mode),
  }));
  scored.sort((a, b) =>
    b.score - a.score ||
    Number(b.candidate.metadata["rating"] ?? 0) - Number(a.candidate.metadata["rating"] ?? 0) ||
    (a.candidate.id < b.candidate.id ? -1 : 1));
  return scored.map((s) => s.candidate);
}
