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
interface Room { id: string; joinCode: string; participants: { userId: string }[] }
interface LiveEvent { type: string; seq: number; room?: Room }

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

  return {
    ws,
    nextEvent(timeoutMs = 3000): Promise<LiveEvent> {
      const head = queue.shift();
      if (head) return Promise.resolve(head);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for event")), timeoutMs);
        waiters.push((e) => { clearTimeout(timer); resolve(e); });
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

// 2. Non-member is rejected
const strangerWs = connect(room.id, bob.id);
check("non-member socket is closed with 4403",
  (await strangerWs.waitClosed()) === 4403);

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

// 7. Close is terminal: broadcast, then the hub hangs up on everyone
await post(`/rooms/${room.id}/close`, { userId: alice.id });
await aliceWs.nextEvent();
await bobWs2.nextEvent();
const [aliceClose, bobClose] = await Promise.all([aliceWs.waitClosed(), bobWs2.waitClosed()]);
check("terminal state closes all sockets with 1000",
  aliceClose === 1000 && bobClose === 1000);

console.log("\nall live-layer checks passed");
process.exit(0);
