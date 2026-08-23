/**
 * Phase 4 exactly-once lab — DEMONSTRATION OF THE BREAK.
 *
 * Two processes. Both members have one card left; their final swipes
 * land on different processes at the same instant. Each handler sees
 * "all done" and settles. With naive look-then-act settlement, both
 * proceed: two REVEALs, two verdicts — and since every card had full
 * consensus, two DIFFERENT winners can be announced for one dinner.
 *
 * Prints what it observed over N trials; exits 0 when at least one
 * double-settlement was seen (the naive expectation).
 */
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";

const A_PORT = 3100, B_PORT = 3101, TRIALS = 5;

async function startServer(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(port), REVEAL_MS: "300" }, stdio: "ignore",
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
   } catch (err) {
    // Under double settlement the room's state can be REWOUND (a late
    // settler's TALLY update lands after the first one's MATCHED) —
    // the protocol story stops making sense, and so can the probe.
    errored++;
    console.log(`trial ${t}: errored — ${(err as Error).message} (chaos counts as breakage)`);
   }
  }
} finally { serverA.kill(); serverB.kill(); }
doubles += errored;

if (doubles > 0) {
  console.log(`\nbreak observed in ${doubles}/${TRIALS} trials: look-then-act settlement ran twice for one round.`);
  process.exit(0);
}
console.error(`\nNOT BROKEN in ${TRIALS} trials (race window not hit — rerun, or the naive hub got lucky).`);
process.exit(1);
