/**
 * End-to-end probe for the live (ws) layer. Run against a server that is
 * already up (npm run dev), with Postgres up:
 *
 *   npx tsx scripts/verify-live.ts
 *
 * Walks the whole realtime story: snapshot on connect, join broadcast,
 * non-member rejection, kick eviction, start fan-out, terminal close.
 * Exits 0 on success, 1 with the failed step on stderr.
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
  participants: { userId: string; completedCount: number }[];
  candidates?: { id: string }[];
}
interface LiveEvent {
  type: string;
  seq: number;
  room?: Room;
  progress?: { userId: string; completed: number; deckSize: number };
}

/** Collects events from one ws connection with an awaitable queue. */
function connect(roomId: string, userId: string) {
  const ws = new WebSocket(`ws://localhost:3000/rooms/${roomId}/live?userId=${userId}`);
  const queue: LiveEvent[] = [];
  const waiters: ((e: LiveEvent) => void)[] = [];
  let closed: { code: number } | null = null;

  ws.on("message", (data) => {
    const event = JSON.parse(String(data)) as LiveEvent;
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  });
  ws.on("close", (code) => { closed = { code }; });
  // A refused handshake (HTTP 403 before upgrade) surfaces as 'error';
  // without a listener the emitter would throw and kill the script.
  let rejected = false;
  ws.on("error", () => { rejected = true; });

  return {
    ws,
    nextEvent(timeoutMs = 3000): Promise<LiveEvent> {
      const head = queue.shift();
      if (head) return Promise.resolve(head);
      return new Promise((resolve, reject) => {
        const waiter = (e: LiveEvent) => { clearTimeout(timer); resolve(e); };
        const timer = setTimeout(() => {
          // Remove the dead waiter, or the NEXT real event gets swallowed
          // by a promise that already rejected — a stale waiter eats one
          // event each. (Found the hard way: the close broadcast vanished
          // into the timed-out waiters of the two negative checks above.)
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error("timed out waiting for event"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    waitClosed(timeoutMs = 3000): Promise<number> {
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

const alice = await post<User>("/dev/users", { displayName: "Alice" });
const bob = await post<User>("/dev/users", { displayName: "Bob" });
const room = await post<Room>("/rooms", { hostId: alice.id });

// 1. Snapshot on connect
const aliceWs = connect(room.id, alice.id);
let event = await aliceWs.nextEvent();
check("host gets ROOM_STATE snapshot on connect",
  event.type === "ROOM_STATE" && event.room?.participants.length === 1);
const seqAfterSnapshot = event.seq;

// 2. Non-member is rejected BEFORE the handshake completes (membership
// is verified pre-upgrade so the listener attaches synchronously at
// open — no await gap for early uplink frames to fall into)
const strangerWs = connect(room.id, bob.id);
check("non-member upgrade is refused (403, no handshake)",
  await strangerWs.wasRejected());

// 3. Join broadcasts to the room, seq advances
await post("/rooms/join", { code: room.joinCode, userId: bob.id });
event = await aliceWs.nextEvent();
check("host sees Bob arrive via broadcast",
  event.room?.participants.length === 2);
check("seq is monotonic within the session", event.seq > seqAfterSnapshot);

// 4. Member connects, gets current snapshot
const bobWs = connect(room.id, bob.id);
event = await bobWs.nextEvent();
check("Bob's snapshot has both participants",
  event.room?.participants.length === 2);

// 5. Kick: last event for Bob shows him gone, then his socket is closed
await post(`/rooms/${room.id}/kick`, { hostId: alice.id, targetUserId: bob.id });
event = await bobWs.nextEvent();
check("kicked guest's final event no longer lists him",
  event.room?.participants.every((p) => p.userId !== bob.id) ?? false);
check("kicked guest's socket is closed with 4401",
  (await bobWs.waitClosed()) === 4401);
await aliceWs.nextEvent(); // host's copy of the kick broadcast

// 6. Rejoin + start fans out to everyone
await post("/rooms/join", { code: room.joinCode, userId: bob.id });
await aliceWs.nextEvent(); // rejoin broadcast
const bobWs2 = connect(room.id, bob.id);
await bobWs2.nextEvent(); // snapshot
await post(`/rooms/${room.id}/start`, { userId: alice.id });
const [aliceSees, bobSees] = await Promise.all([aliceWs.nextEvent(), bobWs2.nextEvent()]);
check("start reaches every member",
  aliceSees.room !== undefined && bobSees.room !== undefined);

// 7. The started room carries the shared deck
const deck = aliceSees.room?.candidates ?? [];
check("ACTIVE snapshot carries a 10-card shared deck", deck.length === 10);
check("both members see the same deck in the same order",
  JSON.stringify(deck) === JSON.stringify(bobSees.room?.candidates ?? []));

// 8. Swipe uplink: Bob's verdict produces a PROGRESS broadcast for all
const firstCard = deck[0]!.id;
bobWs2.ws.send(JSON.stringify({ type: "SWIPE", candidateId: firstCard, decision: "YES" }));
const [aliceProgress, bobProgress] = await Promise.all([
  aliceWs.nextEvent(), bobWs2.nextEvent(),
]);
check("swipe fans out as PROGRESS to every member",
  aliceProgress.type === "PROGRESS" && bobProgress.type === "PROGRESS" &&
  aliceProgress.progress?.userId === bob.id &&
  aliceProgress.progress?.completed === 1 &&
  aliceProgress.progress?.deckSize === 10);

// 9. Resending the same swipe is a declared no-op: no second broadcast
bobWs2.ws.send(JSON.stringify({ type: "SWIPE", candidateId: firstCard, decision: "NO" }));
const duplicateSilent = await aliceWs.nextEvent(800).then(() => false, () => true);
check("duplicate swipe (even flipped) broadcasts nothing — idempotency key holds",
  duplicateSilent);

// 10. A candidate outside the deck is dropped by the declared FK
bobWs2.ws.send(JSON.stringify({ type: "SWIPE", candidateId: "not-a-card", decision: "YES" }));
const bogusSilent = await aliceWs.nextEvent(800).then(() => false, () => true);
check("swipe on a non-deck candidate is dropped", bogusSilent);

// 11. Regression guard for the reconnect-replay path: a swipe fired the
// INSTANT the socket opens (exactly how the outbox drains a backlog)
// must not fall into any server-side listener gap.
const bobWs3 = connect(room.id, bob.id);
bobWs3.ws.on("open", () => {
  bobWs3.ws.send(JSON.stringify(
    { type: "SWIPE", candidateId: deck[1]!.id, decision: "NO" }));
});
const atOpen = await aliceWs.nextEvent();
check("at-open swipe (outbox replay shape) lands and fans out",
  atOpen.type === "PROGRESS" && atOpen.progress?.completed === 2);
await bobWs2.nextEvent(); // drain bobWs2's copy of that PROGRESS
await bobWs3.nextEvent(); // bobWs3's snapshot
await bobWs3.nextEvent(); // bobWs3's copy of the PROGRESS

// 12. Snapshot carries authoritative progress: a FRESH connection must
// see counts it never received deltas for (delta-only state dies with
// a disconnect; the snapshot is the truth).
const aliceWs2 = connect(room.id, alice.id);
const resync = await aliceWs2.nextEvent();
const bobInSnapshot = resync.room?.participants.find((p) => p.userId === bob.id);
check("fresh snapshot carries completedCount (progress resync)",
  bobInSnapshot?.completedCount === 2);

// 13. Close is terminal: broadcast, then the hub hangs up on everyone
await post(`/rooms/${room.id}/close`, { userId: alice.id });
await aliceWs.nextEvent();
await bobWs2.nextEvent();
const [aliceClose, bobClose, bob3Close, alice2Close] = await Promise.all([
  aliceWs.waitClosed(), bobWs2.waitClosed(),
  bobWs3.waitClosed(), aliceWs2.waitClosed(),
]);
check("terminal state closes all sockets with 1000",
  aliceClose === 1000 && bobClose === 1000 &&
  bob3Close === 1000 && alice2Close === 1000);

console.log("\nall live-layer checks passed");
process.exit(0);
