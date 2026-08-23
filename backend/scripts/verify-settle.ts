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
  id: string; joinCode: string; state?: string; round?: number;
  result?: { candidateId: string };
  participants: { userId: string }[];
  candidates?: { id: string }[];
}
interface Ev { type: string; seq: number; room?: Room; progress?: { userId: string; completed: number } }

function connect(roomId: string, userId: string) {
  const ws = new WebSocket(`ws://localhost:3000/rooms/${roomId}/live?userId=${userId}`);
  const queue: Ev[] = []; const waiters: ((e: Ev) => void)[] = [];
  let closed: number | null = null;
  ws.on("message", (d) => {
    const e = JSON.parse(String(d)) as Ev;
    if (process.env["VERBOSE"]) console.log(`      [${userId.slice(0, 4)}] ${e.type} ${e.room?.state ?? ""} r${e.room?.round ?? ""} ${e.progress ? `completed=${e.progress.completed}` : ""}`);
    const w = waiters.shift(); if (w) w(e); else queue.push(e);
  });
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

/** Play a room to its verdict. `aliceYesPerRound[i]` = how many cards
 *  Alice says yes to in round i+1 (Bob always says yes to everything). */
async function playRoom(aliceYesPerRound: number[]) {
  const a = await post<U>("/dev/users", { displayName: "Alice" });
  const b = await post<U>("/dev/users", { displayName: "Bob" });
  const room = await post<Room>("/rooms", { hostId: a.id });
  await post("/rooms/join", { code: room.joinCode, userId: b.id });
  const alice = connect(room.id, a.id); const bob = connect(room.id, b.id);
  await alice.until((e) => e.type === "ROOM_STATE"); await bob.until((e) => e.type === "ROOM_STATE");
  await post(`/rooms/${room.id}/start`, { userId: a.id });

  const decks: string[][] = [];
  for (let round = 1; round <= aliceYesPerRound.length; round++) {
    const activeIn = (e: Ev) => inState("ACTIVE")(e) && e.room?.round === round;
    const active = await alice.until(activeIn);
    await bob.until(activeIn);
    const deck = (active.room?.candidates ?? []).map((c) => c.id);
    decks.push(deck);
    const yes = aliceYesPerRound[round - 1]!;
    deck.forEach((id, i) => { swipe(bob, id, "YES"); swipe(alice, id, i < yes ? "YES" : "NO"); });
    await alice.until((e) => inState("TALLY")(e) && e.room?.round === round);
    console.log(`    … round ${round}: TALLY seen`);
  }
  await alice.until(inState("REVEALING"));
  console.log("    … REVEALING seen (server-directed beat)");
  const final = await alice.until((e) => e.type === "ROOM_STATE" && (e.room?.state === "MATCHED" || e.room?.state === "NO_RESULT"));
  check("terminal broadcast is followed by a clean 1000 hangup", (await alice.waitClosed()) === 1000);
  return { decks, result: final.room?.result?.candidateId, finalState: final.room?.state, finalRound: final.room?.round };
}

const r1 = await playRoom([3]);
check("full consensus on 3 cards → MATCHED", r1.finalState === "MATCHED");
check("winner is one of the 3 candidates everyone said yes to",
  r1.result !== undefined && r1.decks[0]!.slice(0, 3).includes(r1.result));

// Overtime: zero consensus from an engaged table → TALLY → ACTIVE round 2
// with a deck that shares no card with round 1; consensus there → MATCHED.
const r2 = await playRoom([0, 2]);
check("zero consensus → overtime round 2 (TALLY → ACTIVE)", r2.finalRound === 2);
check("overtime deals a fresh deck — no card from round 1",
  r2.decks[1]!.length === 10 && r2.decks[1]!.every((id) => !r2.decks[0]!.includes(id)));
check("consensus in round 2 → MATCHED with a round-2 card",
  r2.finalState === "MATCHED" && r2.result !== undefined && r2.decks[1]!.slice(0, 2).includes(r2.result));

// The cap: zero consensus twice → NO_RESULT, no third round.
const r3 = await playRoom([0, 0]);
check("zero consensus twice → NO_RESULT at the round cap",
  r3.finalState === "NO_RESULT" && r3.finalRound === 2 && r3.result === undefined);

console.log("\nsettlement verified: TALLY → REVEALING → verdict, overtime and cap included");
process.exit(0);
