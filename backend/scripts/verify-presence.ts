/**
 * Lab 3 — presence as a LEASE. Two spawned processes, shared
 * Postgres + Redis, time shrunk via env (TTL 3s, heartbeat 1s).
 *
 * Clean paths flip presence immediately via close events; the dirty
 * path — SIGKILL the process holding Bob's socket, so no close event
 * ever fires — converges anyway: Bob's lease stops being renewed,
 * expires, and the surviving process's sweeper notices and broadcasts.
 * The ghost this replaces is in history at 059bef5.
 */
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";

const A_PORT = 3100;
const B_PORT = 3101;
const TEST_TTL_S = 3;
const TEST_HEARTBEAT_MS = 1000;

async function startServer(port: number): Promise<ChildProcess> {
  // node --import tsx, NOT `npx tsx`: npx wraps the real server in a
  // parent process, and SIGKILL — unlike SIGTERM — cannot be forwarded;
  // killing the wrapper orphans the actual server, which then keeps
  // renewing leases and haunts the very test that tries to kill it.
  // (Found the hard way: the "dead" process B stayed alive on :3101.)
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      PRESENCE_TTL_SECONDS: String(TEST_TTL_S),
      HEARTBEAT_MS: String(TEST_HEARTBEAT_MS),
    },
    stdio: process.env["DEBUG_SPAWN"] ? "inherit" : "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return child;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill();
  throw new Error(`server :${port} failed to start`);
}

async function post<T>(port: number, path: string, body: unknown): Promise<T> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

interface U { id: string }
interface Participant { userId: string; connected: boolean }
interface R { id: string; joinCode: string; participants: Participant[] }
interface Ev { type: string; seq: number; room?: R }

function connect(port: number, roomId: string, userId: string) {
  const ws = new WebSocket(`ws://localhost:${port}/rooms/${roomId}/live?userId=${userId}`);
  const queue: Ev[] = [];
  const waiters: ((e: Ev) => void)[] = [];
  ws.on("message", (d) => {
    const e = JSON.parse(String(d)) as Ev;
    const w = waiters.shift();
    if (w) w(e); else queue.push(e);
  });
  ws.on("error", () => { /* keep emitter calm */ });
  return {
    ws,
    next(timeoutMs = 4000): Promise<Ev> {
      const head = queue.shift();
      if (head) return Promise.resolve(head);
      return new Promise((resolve, reject) => {
        const waiter = (e: Ev) => { clearTimeout(t); resolve(e); };
        const t = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error("timed out waiting for event"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    /** Wait for a ROOM_STATE where `predicate` holds, draining others. */
    async until(predicate: (r: R) => boolean, timeoutMs = 6000): Promise<R> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timed out waiting for condition");
        const e = await this.next(remaining);
        if (e.type === "ROOM_STATE" && e.room && predicate(e.room)) return e.room;
      }
    },
  };
}

function check(label: string, ok: boolean): void {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok  ${label}`);
}

const flag = (r: R | undefined, userId: string): boolean | undefined =>
  r?.participants.find((p) => p.userId === userId)?.connected;

const serverA = await startServer(A_PORT);
let serverB: ChildProcess | null = await startServer(B_PORT);
try {
  const alice = await post<U>(A_PORT, "/dev/users", { displayName: "Alice" });
  const bob = await post<U>(A_PORT, "/dev/users", { displayName: "Bob" });
  const room = await post<R>(A_PORT, "/rooms", { hostId: alice.id });

  const aliceWs = connect(A_PORT, room.id, alice.id);
  const snap = await aliceWs.next();
  check("own snapshot already shows self online",
    flag(snap.room, alice.id) === true);

  await post(B_PORT, "/rooms/join", { code: room.joinCode, userId: bob.id });
  const joined = await aliceWs.until((r) => r.participants.length === 2);
  check("REST-joined member is offline until a socket lands",
    flag(joined, bob.id) === false);

  const bobWs = connect(B_PORT, room.id, bob.id);
  await bobWs.next();
  check("presence flips online cross-process (Bob on B, seen by Alice on A)",
    flag(await aliceWs.until((r) => flag(r, bob.id) === true), bob.id) === true);

  bobWs.ws.close();
  check("clean close flips offline immediately",
    flag(await aliceWs.until((r) => flag(r, bob.id) === false), bob.id) === false);

  console.log("    … bob reconnecting to B");
  const bobWs2 = connect(B_PORT, room.id, bob.id);
  await bobWs2.next();
  console.log("    … bob got his snapshot");
  await aliceWs.until((r) => flag(r, bob.id) === true);
  console.log("    … alice sees bob online again");

  // The dirty path: no close event will ever come. The lease expires
  // on its own, and A's sweeper broadcasts the change — Alice LEARNS
  // of the death through time, not through a message.
  serverB.kill("SIGKILL");
  serverB = null;
  const observed = await aliceWs.until(
    (r) => flag(r, bob.id) === false,
    (TEST_TTL_S + 3) * 1000,
  );
  check("SIGKILL with no close event: lease expiry + sweeper broadcast reach Alice",
    flag(observed, bob.id) === false);

  const probe = await (await fetch(`http://localhost:${A_PORT}/rooms/${room.id}`)).json() as R;
  check("REST probe agrees: the ghost is gone", flag(probe, bob.id) === false);

  console.log("\npresence is a lease: liveness re-earned every heartbeat, " +
    "death discovered by expiry — no notification required.");
} finally {
  serverA.kill();
  serverB?.kill();
}
process.exit(0);
