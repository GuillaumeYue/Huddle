/**
 * Lab 2, naive half — DEMONSTRATION OF THE BREAK.
 *
 * RoomHub's registry is a per-process in-memory Map. Run TWO server
 * processes against the same Postgres and split one room's members
 * across them: every broadcast only reaches the sockets of the process
 * that happened to perform the mutation. The database stays perfectly
 * consistent — only the fan-out is split-brain, which is exactly what
 * makes this failure nasty: state is right, nobody hears about it.
 *
 * This script EXITS 0 WHEN IT OBSERVES THE BREAKAGE. After the Redis
 * pub/sub fix lands it is replaced by verify-fanout.ts asserting the
 * exact opposite.
 */
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";

const A_PORT = 3100;
const B_PORT = 3101;

async function startServer(port: number): Promise<ChildProcess> {
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
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
interface R { id: string; joinCode: string; state?: string; candidates?: { id: string }[] }
interface Ev { type: string; seq: number; room?: R; progress?: { completed: number } }

function connect(port: number, roomId: string, userId: string) {
  const ws = new WebSocket(`ws://localhost:${port}/rooms/${roomId}/live?userId=${userId}`);
  const queue: Ev[] = [];
  const waiters: ((e: Ev) => void)[] = [];
  ws.on("message", (d) => {
    const e = JSON.parse(String(d)) as Ev;
    const w = waiters.shift();
    if (w) w(e); else queue.push(e);
  });
  ws.on("error", () => { /* recorded implicitly by silence */ });
  return {
    ws,
    next(timeoutMs = 2000): Promise<Ev> {
      const head = queue.shift();
      if (head) return Promise.resolve(head);
      return new Promise((resolve, reject) => {
        const waiter = (e: Ev) => { clearTimeout(t); resolve(e); };
        const t = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error("timeout"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function observed(label: string, broken: boolean): void {
  if (!broken) {
    console.error(`NOT BROKEN (unexpected for the naive hub): ${label}`);
    process.exit(1);
  }
  console.log(`break observed  ${label}`);
}

const serverA = await startServer(A_PORT);
const serverB = await startServer(B_PORT);
try {
  const alice = await post<U>(A_PORT, "/dev/users", { displayName: "Alice" });
  const bob = await post<U>(A_PORT, "/dev/users", { displayName: "Bob" });
  const room = await post<R>(A_PORT, "/rooms", { hostId: alice.id });

  // Alice's socket lives in process A.
  const aliceWs = connect(A_PORT, room.id, alice.id);
  await aliceWs.next(); // snapshot

  // Bob joins THROUGH PROCESS B: the mutation commits to the shared
  // Postgres, but the broadcast walks only process B's (empty) registry.
  await post(B_PORT, "/rooms/join", { code: room.joinCode, userId: bob.id });
  const joinMissed = await aliceWs.next(1500).then(() => false, () => true);
  observed("Alice never hears Bob join (join hit the other process)", joinMissed);

  // The database is NOT confused — Bob's fresh snapshot from B shows both.
  const bobWs = connect(B_PORT, room.id, bob.id);
  const bobSnap = await bobWs.next();
  console.log(`   (db is consistent: Bob's snapshot lists ${
    (bobSnap.room as { participants?: unknown[] } | undefined)?.participants?.length} participants — only the fan-out is split)`);

  // Host starts via process A: Alice hears it, Bob — in the same room —
  // stays in LOBBY forever. Two members, two different games.
  await post(A_PORT, `/rooms/${room.id}/start`, { userId: alice.id });
  const aliceActive = await aliceWs.next();
  const bobMissedStart = await bobWs.next(1500).then(() => false, () => true);
  observed("Bob never hears the game start (start hit process A)",
    aliceActive.room?.state === "ACTIVE" && bobMissedStart);

  // Bob swipes via B (the db gladly records it — state check reads
  // Postgres); Alice never sees the PROGRESS.
  const card = aliceActive.room?.candidates?.[0]?.id ?? "";
  bobWs.ws.send(JSON.stringify({ type: "SWIPE", candidateId: card, decision: "YES" }));
  const progressMissed = await aliceWs.next(1500).then(() => false, () => true);
  observed("Alice never sees Bob's progress (swipe uplinked to B)", progressMissed);

  console.log("\nSPLIT-BRAIN DEMONSTRATED: one room, two processes, " +
    "consistent database, broken fan-out. The registry needs a " +
    "cross-process channel — enter Redis pub/sub.");
} finally {
  serverA.kill();
  serverB.kill();
}
process.exit(0);
