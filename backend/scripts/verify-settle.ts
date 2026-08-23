/**
 * Settlement, single node: the whole ACTIVE → TALLY → REVEALING →
 * MATCHED | NO_RESULT story, server-directed. Run against npm run dev.
 *
 *   npx tsx scripts/verify-settle.ts
 */
import WebSocket from "ws";

const BASE = "http://localhost:3000";
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

interface U { id: string }
interface Room {
  id: string; joinCode: string; state?: string;
  result?: { candidateId: string };
  participants: { userId: string }[];
  candidates?: { id: string }[];
}
interface Ev { type: string; seq: number; room?: Room; progress?: { userId: string; completed: number } }

function connect(roomId: string, userId: string) {
  const ws = new WebSocket(`ws://localhost:3000/rooms/${roomId}/live?userId=${userId}`);
  const queue: Ev[] = []; const waiters: ((e: Ev) => void)[] = [];
  let closed: number | null = null;
  ws.on("message", (d) => { const e = JSON.parse(String(d)) as Ev; const w = waiters.shift(); if (w) w(e); else queue.push(e); });
  ws.on("close", (c) => { closed = c; });
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
    async until(pred: (e: Ev) => boolean, ms = 8000): Promise<Ev> {
      const deadline = Date.now() + ms;
      for (;;) { const rem = deadline - Date.now(); if (rem <= 0) throw new Error("timed out waiting for condition"); const e = await nextEvent(rem); if (pred(e)) return e; }
    },
    waitClosed(ms = 8000): Promise<number> {
      return new Promise((resolve, reject) => { if (closed !== null) return resolve(closed); const t = setTimeout(() => reject(new Error("close timeout")), ms); ws.on("close", (c) => { clearTimeout(t); resolve(c); }); });
    },
  };
}
function check(label: string, ok: boolean): void { if (!ok) throw new Error(`FAILED: ${label}`); console.log(`ok  ${label}`); }
const inState = (s: string) => (e: Ev) => e.type === "ROOM_STATE" && e.room?.state === s;
const swipe = (c: ReturnType<typeof connect>, id: string, d: "YES" | "NO") =>
  c.ws.send(JSON.stringify({ type: "SWIPE", candidateId: id, decision: d }));

async function playRound(aliceYes: number): Promise<{ alice: ReturnType<typeof connect>; deck: string[]; result?: string; finalState?: string }> {
  const a = await post<U>("/dev/users", { displayName: "Alice" });
  const b = await post<U>("/dev/users", { displayName: "Bob" });
  const room = await post<Room>("/rooms", { hostId: a.id });
  await post("/rooms/join", { code: room.joinCode, userId: b.id });
  const alice = connect(room.id, a.id); const bob = connect(room.id, b.id);
  await alice.until((e) => e.type === "ROOM_STATE"); await bob.until((e) => e.type === "ROOM_STATE");
  await post(`/rooms/${room.id}/start`, { userId: a.id });
  const active = await alice.until(inState("ACTIVE"));
  await bob.until(inState("ACTIVE"));
  const deck = (active.room?.candidates ?? []).map((c) => c.id);
  deck.forEach((id, i) => { swipe(bob, id, "YES"); swipe(alice, id, i < aliceYes ? "YES" : "NO"); });
  await alice.until(inState("TALLY"));
  console.log("    … TALLY seen");
  await alice.until(inState("REVEALING"));
  console.log("    … REVEALING seen (server-directed beat)");
  const final = await alice.until((e) => e.type === "ROOM_STATE" && (e.room?.state === "MATCHED" || e.room?.state === "NO_RESULT"));
  const code = await alice.waitClosed();
  check("terminal broadcast is followed by a clean 1000 hangup", code === 1000);
  return { alice, deck, result: final.room?.result?.candidateId, finalState: final.room?.state };
}

const r1 = await playRound(3);
check("full consensus on 3 cards → MATCHED", r1.finalState === "MATCHED");
check("winner is one of the 3 candidates everyone said yes to",
  r1.result !== undefined && r1.deck.slice(0, 3).includes(r1.result));

const r2 = await playRound(0);
check("zero consensus → NO_RESULT", r2.finalState === "NO_RESULT" && r2.result === undefined);

console.log("\nsettlement verified: TALLY → REVEALING → verdict, server-directed");
process.exit(0);
