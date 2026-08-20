/**
 * Lab 2, fixed half — cross-process fan-out through Redis pub/sub.
 *
 * Spawns TWO server processes sharing Postgres + Redis and asserts the
 * exact opposites of the split-brain demo (in history at 2caf7ec):
 * joins, starts, progress, evictions and terminal shutdowns all cross
 * the process boundary. Requires docker compose (postgres+redis) up.
 *
 *   npx tsx scripts/verify-fanout.ts
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
interface Ev {
  type: string; seq: number;
  room?: { state?: string; participants: { userId: string }[]; candidates?: { id: string }[] };
  progress?: { userId: string; completed: number };
}

function connect(port: number, roomId: string, userId: string) {
  const ws = new WebSocket(`ws://localhost:${port}/rooms/${roomId}/live?userId=${userId}`);
  const queue: Ev[] = [];
  const waiters: ((e: Ev) => void)[] = [];
  const seqs: number[] = [];
  let closed: number | null = null;
  ws.on("message", (d) => {
    const e = JSON.parse(String(d)) as Ev;
    seqs.push(e.seq);
    const w = waiters.shift();
    if (w) w(e); else queue.push(e);
  });
  ws.on("close", (code) => { closed = code; });
  ws.on("error", () => { /* keep the emitter from throwing */ });
  return {
    ws, seqs,
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
    waitClosed(timeoutMs = 4000): Promise<number> {
      return new Promise((resolve, reject) => {
        if (closed !== null) return resolve(closed);
        const t = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
        ws.on("close", (code) => { clearTimeout(t); resolve(code); });
      });
    },
  };
}

function check(label: string, ok: boolean): void {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok  ${label}`);
}

const serverA = await startServer(A_PORT);
const serverB = await startServer(B_PORT);
try {
  const alice = await post<U>(A_PORT, "/dev/users", { displayName: "Alice" });
  const bob = await post<U>(A_PORT, "/dev/users", { displayName: "Bob" });
  const room = await post<R>(A_PORT, "/rooms", { hostId: alice.id });

  // Alice lives on process A, Bob on process B — the split-brain setup.
  const aliceWs = connect(A_PORT, room.id, alice.id);
  await aliceWs.next(); // snapshot

  await post(B_PORT, "/rooms/join", { code: room.joinCode, userId: bob.id });
  const join = await aliceWs.next();
  check("join via process B reaches Alice on process A",
    join.room?.participants.length === 2);

  const bobWs = connect(B_PORT, room.id, bob.id);
  await bobWs.next(); // snapshot

  // Kick crosses processes: REST on A, eviction happens to B's socket.
  await post(A_PORT, `/rooms/${room.id}/kick`, { hostId: alice.id, targetUserId: bob.id });
  const kicked = await bobWs.next();
  check("kick via A delivers final state to Bob's socket on B",
    kicked.room?.participants.every((p) => p.userId !== bob.id) ?? false);
  check("Bob's socket on B is closed 4401 by B's delivery path",
    (await bobWs.waitClosed()) === 4401);
  await aliceWs.next(); // Alice's copy of the kick broadcast

  await post(B_PORT, "/rooms/join", { code: room.joinCode, userId: bob.id });
  await aliceWs.next(); // rejoin broadcast
  const bobWs2 = connect(B_PORT, room.id, bob.id);
  await bobWs2.next(); // snapshot

  await post(A_PORT, `/rooms/${room.id}/start`, { userId: alice.id });
  const [aliceActive, bobActive] = await Promise.all([aliceWs.next(), bobWs2.next()]);
  check("start via A reaches BOTH processes",
    aliceActive.room?.state === "ACTIVE" && bobActive.room?.state === "ACTIVE");
  check("both processes deliver the same deck in the same order",
    JSON.stringify(aliceActive.room?.candidates) ===
    JSON.stringify(bobActive.room?.candidates));

  const card = aliceActive.room?.candidates?.[0]?.id ?? "";
  bobWs2.ws.send(JSON.stringify({ type: "SWIPE", candidateId: card, decision: "YES" }));
  const progress = await aliceWs.next();
  check("Bob's swipe (uplinked to B) fans out to Alice on A",
    progress.type === "PROGRESS" &&
    progress.progress?.userId === bob.id && progress.progress?.completed === 1);
  await bobWs2.next(); // Bob's own copy

  check("seq strictly increases on Alice's socket (Redis INCR is the one authority)",
    aliceWs.seqs.every((s, i) => i === 0 || s > aliceWs.seqs[i - 1]!));

  // Terminal crosses processes too: close via B, Alice hangs up on A.
  await post(B_PORT, `/rooms/${room.id}/close`, { userId: alice.id });
  await aliceWs.next(); // terminal broadcast
  await bobWs2.next();
  const [aClose, bClose] = await Promise.all([aliceWs.waitClosed(), bobWs2.waitClosed()]);
  check("terminal close via B hangs up sockets on BOTH processes with 1000",
    aClose === 1000 && bClose === 1000);

  console.log("\ncross-process fan-out verified: one room, two processes, one story");
} finally {
  serverA.kill();
  serverB.kill();
}
process.exit(0);
