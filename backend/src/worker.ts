import "dotenv/config";
import { Redis } from "ioredis";
import { buildProfile } from "./reco/profiles.js";
import { PROFILE_QUEUE } from "./reco/queue.js";

/**
 * The worker — the OFFLINE half of the recommender, and the reason the
 * realtime path never computes anything heavy. A separate process on
 * purpose: profile rebuilds can be slow, crash, or fall behind without
 * touching a single swipe broadcast.
 *
 * BRPOP blocks, so it gets a DEDICATED connection — a blocking command
 * would freeze every other caller sharing the connection (same family
 * as the pub/sub twin-connection rule).
 */
const blocking = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
blocking.on("error", (err: Error) => console.error("[worker:redis]", err.message));

let running = true;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    running = false;
    blocking.disconnect();
    process.exit(0);
  });
}

console.log("[worker] profile worker up, waiting on", PROFILE_QUEUE);
while (running) {
  try {
    const job = await blocking.brpop(PROFILE_QUEUE, 5);
    if (!job) continue; // timeout tick: lets the loop notice shutdown
    const userId = job[1];
    const profile = await buildProfile(userId);
    console.log(`[worker] rebuilt profile for ${userId.slice(0, 8)}… (${profile.swipes} swipes)`);
  } catch (err) {
    if (!running) break;
    console.error("[worker] job failed:", err);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
