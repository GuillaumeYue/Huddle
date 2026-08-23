import { randomUUID } from "node:crypto";
import os from "node:os";
import { pool } from "./db.js";
import { redisPub } from "./redis.js";
import { isInactive, settleByTimeout } from "./settlement.js";

/**
 * The distributed inactivity timer.
 *
 * The naive version (in history) ran inside each process's heartbeat
 * and timed out the rooms that process hosted — so a room whose
 * members had all gone dark was hosted by nobody and stuck in ACTIVE
 * forever. The timer belongs to the ROOM, not to a socket holder:
 * the sweeper scans EVERY active room in Postgres, regardless of who
 * (if anyone) is connected.
 *
 * Only one process sweeps at a time, chosen by a Redis LEASE:
 *   acquire  — SET timer:sweeper <me> NX PX <ttl>   (atomic take-if-free)
 *   renew    — Lua: extend ONLY if the value is still <me>  (atomic
 *              check-and-act; a GET-then-PEXPIRE would let a process
 *              whose lease just expired extend the NEW holder's lease)
 *   failover — a dead holder stops renewing, the key expires, the next
 *              tick's SET NX on another process wins.
 *
 * Division of labour, stated plainly: the lease buys ONE firing point
 * (no N-way duplicate sweeps, no thundering herd); CORRECTNESS never
 * depended on it — settle() is CAS-guarded, so even an overlap at
 * lease handoff settles a room exactly once. Efficiency from the
 * lease, safety from the row.
 */

const TICK_MS = Number(process.env["TIMER_TICK_MS"] ?? 5_000);
const LEASE_MS = TICK_MS * 3;
const LEASE_KEY = "timer:sweeper";

export const instanceId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

const RENEW_IF_MINE = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;

let leader = false;
export const isTimerLeader = (): boolean => leader;

type Broadcast = (roomId: string) => Promise<void>;

export function startTimerSweeper(broadcast: Broadcast): void {
  const handle = setInterval(() => {
    void tick(broadcast).catch((err) => console.error("[timer] tick failed:", err));
  }, TICK_MS);
  handle.unref();
}

async function holdLease(): Promise<boolean> {
  const acquired = await redisPub.set(LEASE_KEY, instanceId, "PX", LEASE_MS, "NX");
  if (acquired === "OK") return true;
  const renewed = await redisPub.eval(RENEW_IF_MINE, 1, LEASE_KEY, instanceId, String(LEASE_MS));
  return renewed === 1;
}

async function tick(broadcast: Broadcast): Promise<void> {
  leader = await holdLease();
  if (!leader) return;

  // Every ACTIVE room in the system — hosted or orphaned alike.
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM rooms WHERE state = 'ACTIVE' AND closed_at IS NULL",
  );
  for (const { id } of rows) {
    if (await isInactive(id)) {
      await settleByTimeout(id, broadcast);
    }
  }
}
