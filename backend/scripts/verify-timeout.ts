/**
 * Trigger B — the distributed inactivity timer. Two spawned processes,
 * time shrunk via env (inactivity 2s, tick 500ms → lease 1.5s).
 *
 * Asserts: a room still settles when SOMEONE is connected, when NOBODY
 * is connected (the hosted-timer ghost, in history), that exactly one
 * process holds the sweeper lease, and that SIGKILLing the holder
 * hands the lease to the survivor in time to settle the next room.
 */
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";

const A_PORT = 3100, B_PORT = 3101;
const INACTIVITY_MS = 2000;

async function startServer(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(port), INACTIVITY_MS: String(INACTIVITY_MS),
      HEARTBEAT_MS: "1000", TIMER_TICK_MS: "500", REVEAL_MS: "200", PRESENCE_TTL_SECONDS: "3" },
    stdio: process.env["DEBUG_SPAWN"] ? "inherit" : "ignore",
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
const getState = async (port: number, roomId: string): Promise<string> =>
  ((await (await fetch(`http://localhost:${port}/rooms/${roomId}`)).json()) as { state: string }).state;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface U { id: string }
interface Room { id: string; joinCode: string; candidates?: { id: string }[] }
interface Ev { type: string; room?: { state?: string; candidates?: { id: string }[] } }

function connect(port: number, roomId: string, userId: string) {
  const ws = new WebSocket(`ws://localhost:${port}/rooms/${roomId}/live?userId=${userId}`);
  const queue: Ev[] = []; const waiters: ((e: Ev) => void)[] = [];
  ws.on("message", (d) => { const e = JSON.parse(String(d)) as Ev; const w = waiters.shift(); if (w) w(e); else queue.push(e); });
  ws.on("error", () => {});
  const nextEvent = (ms: number): Promise<Ev> => {
    const head = queue.shift(); if (head) return Promise.resolve(head);
    return new Promise((resolve, reject) => {
      const waiter = (e: Ev) => { clearTimeout(t); resolve(e); };
      const t = setTimeout(() => { const i = waiters.indexOf(waiter); if (i !== -1) waiters.splice(i, 1); reject(new Error("timeout")); }, ms);
      waiters.push(waiter);
    });
  };
  return {
    ws,
    async until(pred: (e: Ev) => boolean, ms = 6000): Promise<Ev> {
      const deadline = Date.now() + ms;
      for (;;) { const rem = deadline - Date.now(); if (rem <= 0) throw new Error("timed out"); const e = await nextEvent(rem); if (pred(e)) return e; }
    },
  };
}
const isActive = (e: Ev) => e.type === "ROOM_STATE" && e.room?.state === "ACTIVE";
const terminal = (s: string) => s === "MATCHED" || s === "NO_RESULT";
function check(label: string, ok: boolean): void { if (!ok) throw new Error(`FAILED: ${label}`); console.log(`ok  ${label}`); }

/** A started room with two members who swiped a couple of cards each. */
async function startedRoom() {
  const a = await post<U>(A_PORT, "/dev/users", { displayName: "Alice" });
  const b = await post<U>(A_PORT, "/dev/users", { displayName: "Bob" });
  const room = await post<Room>(A_PORT, "/rooms", { hostId: a.id });
  await post(B_PORT, "/rooms/join", { code: room.joinCode, userId: b.id });
  const alice = connect(A_PORT, room.id, a.id); const bob = connect(B_PORT, room.id, b.id);
  await alice.until((e) => e.type === "ROOM_STATE"); await bob.until((e) => e.type === "ROOM_STATE");
  await post(A_PORT, `/rooms/${room.id}/start`, { userId: a.id });
  const deck = ((await alice.until(isActive)).room?.candidates ?? []).map((c) => c.id);
  await bob.until(isActive);
  for (const id of deck.slice(0, 2)) {
    alice.ws.send(JSON.stringify({ type: "SWIPE", candidateId: id, decision: "YES" }));
    bob.ws.send(JSON.stringify({ type: "SWIPE", candidateId: id, decision: "YES" }));
  }
  await sleep(300);
  return { room, alice, bob };
}

const serverA = await startServer(A_PORT);
const serverB = await startServer(B_PORT);
try {
  // 1. Someone is still connected: the hosted timer fires.
  const r1 = await startedRoom();
  r1.bob.ws.close();
  await sleep(INACTIVITY_MS + 2500);
  check("hosted timeout settles a room that still has a member connected",
    terminal(await getState(A_PORT, r1.room.id)));

  // 2. Everyone is gone — the exact case the timeout exists for.
  const r2 = await startedRoom();
  r2.alice.ws.close(); r2.bob.ws.close();
  await sleep(INACTIVITY_MS + 2500);
  check("nobody home: the leased sweeper still settles the orphaned room",
    terminal(await getState(A_PORT, r2.room.id)));

  // 3. Exactly one sweeper holds the lease.
  const health = async (port: number) =>
    (await (await fetch(`http://localhost:${port}/health`)).json()) as { timerLeader: boolean };
  const [ha, hb] = await Promise.all([health(A_PORT), health(B_PORT)]);
  check("exactly one process holds the sweeper lease",
    ha.timerLeader !== hb.timerLeader);

  // 4. Failover: kill the holder; the survivor must take the lease and
  //    settle the next orphaned room on its own.
  const leaderIsA = ha.timerLeader;
  (leaderIsA ? serverA : serverB).kill("SIGKILL");
  const survivor = leaderIsA ? B_PORT : A_PORT;
  console.log(`    … SIGKILLed the lease holder (${leaderIsA ? "A" : "B"}); survivor is ${leaderIsA ? "B" : "A"}`);
  const a3 = await post<U>(survivor, "/dev/users", { displayName: "Solo" });
  const room3 = await post<Room>(survivor, "/rooms", { hostId: a3.id });
  const solo = connect(survivor, room3.id, a3.id);
  await solo.until((e) => e.type === "ROOM_STATE");
  await post(survivor, `/rooms/${room3.id}/start`, { userId: a3.id });
  await solo.until(isActive);
  solo.ws.close();
  await sleep(INACTIVITY_MS + 1500 /* lease */ + 2000);
  check("lease failover: the survivor took over and settled the room",
    terminal(await getState(survivor, room3.id)));
  check("the survivor now reports itself as sweeper leader",
    (await health(survivor)).timerLeader === true);

  console.log("\nthe timer belongs to the room; the lease picks who rings it; CAS guarantees it rings once.");
} finally { serverA.kill(); serverB.kill(); }
process.exit(0);
