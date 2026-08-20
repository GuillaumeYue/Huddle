import { Redis } from "ioredis";

/**
 * Two connections, not one — a Redis connection in subscriber mode is
 * dedicated by protocol: once SUBSCRIBEd it may not issue regular
 * commands (INCR, PUBLISH, ...). The classic first-week-of-Redis
 * gotcha, avoided by construction: `redisPub` commands & publishes,
 * `redisSub` only ever subscribes and listens.
 */
const url = process.env["REDIS_URL"] ?? "redis://localhost:6379";

export const redisPub = new Redis(url);
export const redisSub = new Redis(url);

// Same lesson as the pg pool crash: client libraries surface transport
// failures as 'error' EVENTS, and an unhandled 'error' event kills the
// Node process. ioredis reconnects on its own — our only job is to
// witness the error instead of dying of it.
for (const [name, client] of [["pub", redisPub], ["sub", redisSub]] as const) {
  client.on("error", (err: Error) => {
    console.error(`[redis:${name}] ${err.message}`);
  });
}

/** True if Redis answers PING in time. */
export async function isRedisUp(): Promise<boolean> {
  try {
    return (await redisPub.ping()) === "PONG";
  } catch {
    return false;
  }
}
