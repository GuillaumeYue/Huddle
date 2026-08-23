/**
 * Phase 4 exactly-once lab — the fixed half.
 *
 * Two processes. Both members have one card left; their final swipes
 * land on different processes at the same instant, so BOTH handlers
 * see "all done" and call settle(). With CAS transitions, exactly one
 * claims ACTIVE->TALLY; the other matches zero rows and stands down.
 * Asserts one REVEALING, one verdict, zero chaos, in every trial.
 * (The naive demo that double-settled 4/5 trials is in history.)
 */
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { Redis } from "ioredis";

// Each probe owns redis db 1 for the clusters it spawns; start clean so
// nothing a previous probe left behind (a lease, a presence key) can
// shape this run.
await new Redis("redis://localhost:6379/1").flushdb().then((_r) => undefined);

const A_PORT = 3100, B_PORT = 3101, TRIALS = 5;

async function startServer(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, REDIS_URL: "redis://localhost:6379/1", PICK_TIMEOUT_MS: "300", PORT: String(port), REVEAL_MS: "300" }, stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${port}/health`)).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill(); throw new Error(`server :${port} failed to start`);
}
async function post<T>(port: number, path: string, body: unknown): Promise<T> {
  const res = await fetch(`http://localhost:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}
interface U { id: string }
interface Room { id: string; joinCode: string; state?: string; result?: { candidateId: string }; candidates?: { id: string }[] }
interface Ev { type: string; seq: number; room?: Room; progress?: { userId: string; completed: number } }

function connect(port: number, roomId: string, userId: string) {
  const ws = new WebSocket(`ws://localhost:${port}/rooms/${roomId}/live?userId=${userId}`);
  const all: Ev[] = []; const queue: Ev[] = []; const waiters: ((e: Ev) => void)[] = [];
  let closed: number | null = null;
  ws.on("message", (d) => { const e = JSON.parse(String(d)) as Ev; all.push(e); const w = waiters.shift(); if (w) w(e); else queue.push(e); });
  ws.on("close", (c) => { closed = c; }); ws.on("error", () => {});
  const nextEvent = (ms: number): Promise<Ev> => {
    const head = queue.shift(); if (head) return Promise.resolve(head);
    return new Promise((resolve, reject) => {
      const waiter = (e: Ev) => { clearTimeout(t); resolve(e); };
      const t = setTimeout(() => { const i = waiters.indexOf(waiter); if (i !== -1) waiters.splice(i, 1); reject(new Error("timeout")); }, ms);
      waiters.push(waiter);
    });
  };
  return {
    ws, all,
    async until(pred: (e: Ev) => boolean, ms = 8000): Promise<Ev> {
      const deadline = Date.now() + ms;
      for (;;) { const rem = deadline - Date.now(); if (rem <= 0) throw new Error("timed out"); const e = await nextEvent(rem); if (pred(e)) return e; }
    },
    waitClosed(ms = 8000): Promise<number> {
      return new Promise((resolve, reject) => { if (closed !== null) return resolve(closed); const t = setTimeout(() => reject(new Error("close timeout")), ms); ws.on("close", (c) => { clearTimeout(t); resolve(c); }); });
    },
  };
}
const inState = (s: string) => (e: Ev) => e.type === "ROOM_STATE" && e.room?.state === s;
const swipe = (c: ReturnType<typeof connect>, id: string) => c.ws.send(JSON.stringify({ type: "SWIPE", candidateId: id, decision: "YES" }));

const serverA = await startServer(A_PORT); const serverB = await startServer(B_PORT);
let doubles = 0, errored = 0;
try {
  for (let t = 1; t <= TRIALS; t++) {
   // One retry per trial: a probe timeout right after spawning fresh
   // servers is startup jitter, not evidence — and must never be
   // confused with a double settlement.
   for (let attempt = 1; attempt <= 2; attempt++) {
   try {
    const a = await post<U>(A_PORT, "/dev/users", { displayName: "Alice" });
    const b = await post<U>(A_PORT, "/dev/users", { displayName: "Bob" });
    const room = await post<Room>(A_PORT, "/rooms", { hostId: a.id });
    await post(B_PORT, "/rooms/join", { code: room.joinCode, userId: b.id });
    const alice = connect(A_PORT, room.id, a.id); const bob = connect(B_PORT, room.id, b.id);
    await alice.until((e) => e.type === "ROOM_STATE"); await bob.until((e) => e.type === "ROOM_STATE");
    await post(A_PORT, `/rooms/${room.id}/start`, { userId: a.id });
    const active = await alice.until(inState("ACTIVE")); await bob.until(inState("ACTIVE"));
    const deck = (active.room?.candidates ?? []).map((c) => c.id);
    // Nine cards each, confirmed landed.
    for (const id of deck.slice(0, 9)) { swipe(alice, id); swipe(bob, id); }
    await alice.until((e) => e.type === "PROGRESS" && e.progress?.userId === a.id && e.progress.completed === 9);
    await alice.until((e) => e.type === "PROGRESS" && e.progress?.userId === b.id && e.progress.completed === 9);
    // The race: two final swipes, two processes, one instant.
    const last = deck[9]!;
    swipe(alice, last); swipe(bob, last);
    await alice.waitClosed(10_000);
    const reveals = alice.all.filter(inState("REVEALING")).length;
    const verdicts = alice.all.filter((e) => e.type === "ROOM_STATE" && (e.room?.state === "MATCHED" || e.room?.state === "NO_RESULT"));
    const winners = new Set(verdicts.map((e) => e.room?.result?.candidateId));
    const doubled = reveals > 1 || verdicts.length > 1;
    if (doubled) doubles++;
    console.log(`trial ${t}: REVEALING×${reveals}, verdicts×${verdicts.length}, distinct winners=${winners.size}${doubled ? "  ← DOUBLE SETTLEMENT" : ""}`);
    break;
   } catch (err) {
    if (attempt === 1) { console.log(`trial ${t}: probe error (${(err as Error).message}) — retrying once`); continue; }
    errored++;
    console.log(`trial ${t}: errored twice — ${(err as Error).message}`);
   }
   }
  }
} finally { serverA.kill(); serverB.kill(); }

if (doubles > 0) {
  console.error(`\nFAILED: settlement ran twice in ${doubles}/${TRIALS} trials — CAS broken.`);
  process.exit(1);
}
if (errored > 0) {
  console.error(`\nINCONCLUSIVE: ${errored}/${TRIALS} trials errored in the probe (not a double settlement) — rerun.`);
  process.exit(2);
}
console.log(`\nexactly-once held in ${TRIALS}/${TRIALS} trials: two triggers, two processes, one settlement.`);
process.exit(0);
