/**
 * Trigger B — the inactivity timeout. Two spawned processes, time
 * shrunk via env (inactivity 2s, heartbeat 1s, reveal 200ms).
 *
 * NAIVE PHASE: each process times out the rooms it hosts. Works while
 * someone is connected — and the final check DEMONSTRATES THE BREAK:
 * a room whose members have all disconnected is hosted by nobody, so
 * it stays ACTIVE forever, which is precisely the situation the
 * timeout exists to rescue. Exits 0 while the stuck room is observed.
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
  const state = await getState(A_PORT, r2.room.id);
  if (state === "ACTIVE") {
    console.log("break observed  STUCK: everyone left, nobody hosts the room, nobody times it out");
    console.log("\nthe timer must belong to the ROOM, not to whichever process happens to hold a socket.");
  } else {
    console.error(`NOT BROKEN (unexpected for the hosted timer): state=${state}`);
    process.exit(1);
  }
} finally { serverA.kill(); serverB.kill(); }
process.exit(0);
