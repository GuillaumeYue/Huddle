import pg from "pg";

/**
 * One process-wide connection pool.
 *
 * A pool, not a client-per-request: Postgres connections are expensive
 * (a forked server process each), so the pool keeps a handful warm and
 * requests borrow one for the duration of a query. This is also the
 * first place backpressure appears — if all connections are busy,
 * queries queue here rather than stampeding the database.
 */
export const pool = new pg.Pool({
  connectionString:
    process.env["DATABASE_URL"] ??
    "postgres://huddle:huddle_dev@localhost:5432/huddle",
  max: 10,
  // Fail fast in dev: a hung "connecting..." hides a down database.
  connectionTimeoutMillis: 2_000,
});

// Idle pooled connections can die under us (database restart, network
// blip, failover). The pool surfaces that as an 'error' EVENT — and an
// unhandled 'error' event kills the whole Node process. Without this
// handler, one Postgres hiccup takes the API and every live room down
// with it (verified: `docker compose stop postgres` crashed the server).
// With it, the dead client is discarded and the next query just draws a
// fresh connection.
pool.on("error", (err) => {
  console.error("[db] idle client error (connection dropped):", err.message);
});

/** True if the database answers a trivial query in time. */
export async function isDatabaseUp(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
