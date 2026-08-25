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
  threshold?: number; tally?: { candidateId: string; yes: number }[]; tie?: string[];
  participants: { userId: string }[];
  candidates?: { id: string }[];
}
async function postStatus(path: string, body: unknown): Promise<number> {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.status;
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
 *  Alice says yes to in round i+1 (Bob always says yes to everything).
 *  `pick`: what to do if the reveal is a tie — "alice" taps the second
 *  tied card, "race" has both tap different cards at once, "none"
 *  leaves it to the server (only sane with a short PICK_TIMEOUT). */
async function playRoom(aliceYesPerRound: number[], pick: "alice" | "race" | "none" = "none") {
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
  const revealing = await alice.until(inState("REVEALING"));
  const tie = revealing.room?.tie ?? [];
  console.log(`    … REVEALING seen${tie.length ? ` (tie of ${tie.length}, waiting for the table)` : " (server-directed beat)"}`);

  let picked: string | undefined; let statuses: number[] = [];
  if (tie.length > 1 && pick === "alice") {
    // Decision C: BOTH members cast hidden picks for the same card —
    // plurality makes the verdict deterministic. Alice trying to cast
    // twice is the 409 now (first cast is final), not another member.
    picked = tie[1]!;
    statuses = [await postStatus(`/rooms/${room.id}/pick`, { userId: a.id, candidateId: picked })];
    statuses.push(await postStatus(`/rooms/${room.id}/pick`, { userId: a.id, candidateId: tie[0] }));
    statuses.push(await postStatus(`/rooms/${room.id}/pick`, { userId: b.id, candidateId: picked }));
  } else if (tie.length > 1 && pick === "race") {
    // Simultaneous different picks: both are votes now (200 + 200);
    // the roster completing fires the plurality resolution, and an
    // exact 1–1 top tie falls to server random among the two.
    const [sa, sb] = await Promise.all([
      postStatus(`/rooms/${room.id}/pick`, { userId: a.id, candidateId: tie[0] }),
      postStatus(`/rooms/${room.id}/pick`, { userId: b.id, candidateId: tie[1] }),
    ]);
    statuses = [sa, sb];
  }
  const final = await alice.until((e) => e.type === "ROOM_STATE" && (e.room?.state === "MATCHED" || e.room?.state === "NO_RESULT"), 25_000);
  check("terminal broadcast is followed by a clean 1000 hangup", (await alice.waitClosed()) === 1000);
  return { decks, tie, picked, statuses, final: final.room! };
}

// 1. A single winner: server-directed beat, automatic verdict.
const r1 = await playRoom([1]);
check("single consensus → MATCHED without a pick", r1.final.state === "MATCHED" && r1.tie.length === 0
  && r1.final.result?.candidateId === r1.decks[0]![0]);
check("verdict carries the tally and threshold",
  r1.final.threshold === 2 && (r1.final.tally?.length ?? 0) >= 1 && r1.final.tally?.[0]?.yes === 2);

// 2. A tie: the table picks blind; the second tap gets 409.
const r2 = await playRoom([3], "alice");
check("three-way consensus → REVEALING carries a tie of 3", r2.tie.length === 3);
check("first cast 200, second cast by the SAME member 409, partner's cast 200",
  r2.statuses[0] === 200 && r2.statuses[1] === 409 && r2.statuses[2] === 200);
check("unanimous hidden picks → that exact card wins, credited to both",
  r2.final.state === "MATCHED" && r2.final.result?.candidateId === r2.picked
  && r2.final.result?.pickedBy === 2);

// 3. Two taps in the same instant: the row arbitrates — one 200, one 409.
const r3 = await playRoom([2], "race");
check("simultaneous different picks: BOTH are votes (200 + 200)",
  r3.statuses.filter((s) => s === 200).length === 2);
check("a 1–1 top tie resolves at random among the tied pair, credited to one",
  r3.tie.includes(r3.final.result?.candidateId ?? "") && r3.final.result?.pickedBy === 1);

// 4. Overtime: zero consensus → round 2 with a disjoint deck → tie → pick.
const r4 = await playRoom([0, 2], "alice");
check("zero consensus → overtime round 2 (TALLY → ACTIVE)", r4.final.round === 2);
check("overtime deals a fresh deck — no card from round 1",
  r4.decks[1]!.length === 10 && r4.decks[1]!.every((id) => !r4.decks[0]!.includes(id)));
check("round-2 tie resolved by the table's unanimous picks with a round-2 card",
  r4.final.state === "MATCHED" && r4.final.result?.candidateId === r4.picked && r4.decks[1]!.includes(r4.picked!));

// 5. The cap: zero consensus twice → NO_RESULT, tally still reported.
const r5 = await playRoom([0, 0]);
check("zero consensus twice → NO_RESULT at the round cap",
  r5.final.state === "NO_RESULT" && r5.final.round === 2 && r5.final.result === undefined);
check("NO_RESULT still explains itself with a tally", (r5.final.tally?.length ?? 0) > 0 && r5.final.threshold === 2);

console.log("\nsettlement verified: beat, blind pick, pick race, overtime, cap");
process.exit(0);
