/**
 * End-to-end probe for the live (ws) layer, single node. Run against a
 * server that is already up (npm run dev), with Postgres + Redis up:
 *
 *   npx tsx scripts/verify-live.ts
 *
 * Waiting is PREDICATE-based, never positional: presence and future
 * features may add broadcasts at any time; counting events breaks on
 * every protocol addition. Exits 0 on success.
 */
import WebSocket from "ws";

const BASE = "http://localhost:3000";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

interface User { id: string }
interface Room {
  id: string;
  joinCode: string;
  state?: string;
  participants: { userId: string; completedCount: number }[];
  candidates?: { id: string }[];
}
interface LiveEvent {
  type: string;
  seq: number;
  room?: Room;
  progress?: { userId: string; completed: number; deckSize: number };
}

function connect(roomId: string, userId: string) {
  const ws = new WebSocket(`ws://localhost:3000/rooms/${roomId}/live?userId=${userId}`);
  const queue: LiveEvent[] = [];
  const waiters: ((e: LiveEvent) => void)[] = [];
  const seqs: number[] = [];
  let closed: { code: number } | null = null;
  let rejected = false;

  ws.on("message", (data) => {
    const event = JSON.parse(String(data)) as LiveEvent;
    seqs.push(event.seq);
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  });
  ws.on("close", (code) => { closed = { code }; });
  // A refused handshake (HTTP 403 before upgrade) surfaces as 'error'.
  ws.on("error", () => { rejected = true; });

  const nextEvent = (timeoutMs: number): Promise<LiveEvent> => {
    const head = queue.shift();
    if (head) return Promise.resolve(head);
    return new Promise((resolve, reject) => {
      const waiter = (e: LiveEvent) => { clearTimeout(timer); resolve(e); };
      const timer = setTimeout(() => {
        // Remove the dead waiter, or the NEXT real event gets swallowed
        // by a promise that already rejected.
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error("timed out waiting for event"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };

  return {
    ws, seqs,
    /** Drain events until one satisfies the predicate. */
    async until(predicate: (e: LiveEvent) => boolean, timeoutMs = 5000): Promise<LiveEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timed out waiting for condition");
        const e = await nextEvent(remaining);
        if (predicate(e)) return e;
      }
    },
    /** Assert that NO event matching the predicate arrives in the window. */
    async silence(predicate: (e: LiveEvent) => boolean, windowMs = 800): Promise<boolean> {
      return this.until(predicate, windowMs).then(() => false, () => true);
    },
    waitClosed(timeoutMs = 5000): Promise<number> {
      return new Promise((resolve, reject) => {
        if (closed) return resolve(closed.code);
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for close")), timeoutMs);
        ws.on("close", (code) => { clearTimeout(timer); resolve(code); });
      });
    },
    async wasRejected(timeoutMs = 3000): Promise<boolean> {
      await this.waitClosed(timeoutMs).catch(() => undefined);
      return rejected && queue.length === 0;
    },
  };
}

function check(label: string, ok: boolean): void {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok  ${label}`);
}

const hasMembers = (n: number) => (e: LiveEvent): boolean =>
  e.type === "ROOM_STATE" && e.room?.participants.length === n;
const isProgress = (e: LiveEvent): boolean => e.type === "PROGRESS";

const alice = await post<User>("/dev/users", { displayName: "Alice" });
const bob = await post<User>("/dev/users", { displayName: "Bob" });
const room = await post<Room>("/rooms", { hostId: alice.id });

// 1. Snapshot on connect
const aliceWs = connect(room.id, alice.id);
const snapshot = await aliceWs.until((e) => e.type === "ROOM_STATE");
check("host gets ROOM_STATE snapshot on connect",
  snapshot.room?.participants.length === 1);

// 2. Non-member is rejected before the handshake completes
const strangerWs = connect(room.id, bob.id);
check("non-member upgrade is refused (403, no handshake)",
  await strangerWs.wasRejected());

// 3. Join broadcasts to the room
await post("/rooms/join", { code: room.joinCode, userId: bob.id });
check("host sees Bob arrive via broadcast",
  (await aliceWs.until(hasMembers(2))) !== undefined);

// 4. Member connects, gets current snapshot
const bobWs = connect(room.id, bob.id);
check("Bob's snapshot has both participants",
  (await bobWs.until(hasMembers(2))) !== undefined);

// 5. Kick: last event for Bob shows him gone, then his socket is closed
await post(`/rooms/${room.id}/kick`, { hostId: alice.id, targetUserId: bob.id });
await bobWs.until((e) =>
  e.type === "ROOM_STATE" &&
  (e.room?.participants.every((p) => p.userId !== bob.id) ?? false));
console.log("ok  kicked guest's final event no longer lists him");
check("kicked guest's socket is closed with 4401",
  (await bobWs.waitClosed()) === 4401);
await aliceWs.until(hasMembers(1));

// 6. Rejoin + start fans out to everyone
await post("/rooms/join", { code: room.joinCode, userId: bob.id });
await aliceWs.until(hasMembers(2));
const bobWs2 = connect(room.id, bob.id);
await bobWs2.until(hasMembers(2));
await post(`/rooms/${room.id}/start`, { userId: alice.id });
const isActive = (e: LiveEvent): boolean =>
  e.type === "ROOM_STATE" && e.room?.state === "ACTIVE";
const [aliceSees, bobSees] = await Promise.all([
  aliceWs.until(isActive), bobWs2.until(isActive),
]);
check("start reaches every member", true);

// 7. The started room carries the shared deck
const deck = aliceSees.room?.candidates ?? [];
check("ACTIVE snapshot carries a 10-card shared deck", deck.length === 10);
check("both members see the same deck in the same order",
  JSON.stringify(deck) === JSON.stringify(bobSees.room?.candidates ?? []));

// 8. Swipe uplink fans out as PROGRESS
const firstCard = deck[0]!.id;
bobWs2.ws.send(JSON.stringify({ type: "SWIPE", candidateId: firstCard, decision: "YES" }));
const progress = await aliceWs.until(isProgress);
check("swipe fans out as PROGRESS to every member",
  progress.progress?.userId === bob.id &&
  progress.progress?.completed === 1 &&
  progress.progress?.deckSize === 10);

// 9. Resending the same swipe is a declared no-op: no PROGRESS broadcast
bobWs2.ws.send(JSON.stringify({ type: "SWIPE", candidateId: firstCard, decision: "NO" }));
check("duplicate swipe (even flipped) broadcasts nothing — idempotency key holds",
  await aliceWs.silence(isProgress));

// 10. A candidate outside the deck is dropped by the declared FK
bobWs2.ws.send(JSON.stringify({ type: "SWIPE", candidateId: "not-a-card", decision: "YES" }));
check("swipe on a non-deck candidate is dropped", await aliceWs.silence(isProgress));

// 11. Regression guard: a swipe fired the INSTANT the socket opens
// (outbox replay shape) must not fall into any listener gap.
const bobWs3 = connect(room.id, bob.id);
bobWs3.ws.on("open", () => {
  bobWs3.ws.send(JSON.stringify(
    { type: "SWIPE", candidateId: deck[1]!.id, decision: "NO" }));
});
const atOpen = await aliceWs.until(isProgress);
check("at-open swipe (outbox replay shape) lands and fans out",
  atOpen.progress?.completed === 2);

// 12. Snapshot carries authoritative progress AND presence: a fresh
// connection sees facts it never received deltas for.
const aliceWs2 = connect(room.id, alice.id);
const resync = await aliceWs2.until((e) => e.type === "ROOM_STATE");
const bobInSnapshot = resync.room?.participants.find((p) => p.userId === bob.id);
check("fresh snapshot carries completedCount (progress resync)",
  bobInSnapshot?.completedCount === 2);

// 13. Close is terminal: broadcast, then the hub hangs up on everyone
await post(`/rooms/${room.id}/close`, { userId: alice.id });
const closes = await Promise.all([
  aliceWs.waitClosed(), bobWs2.waitClosed(),
  bobWs3.waitClosed(), aliceWs2.waitClosed(),
]);
check("terminal state closes all sockets with 1000",
  closes.every((c) => c === 1000));

console.log("\nall live-layer checks passed");
process.exit(0);
