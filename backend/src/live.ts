import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { pool } from "./db.js";
import { acceptsSwipes, isRoomState, isTerminal } from "./domain/roomState.js";
import {
  makeProgressEvent, makeRoomStateEvent, type LiveEvent,
} from "./liveEvents.js";
import { redisPub, redisSub } from "./redis.js";
import { getRoomPayload, presenceKey } from "./roomsData.js";
import { settleIfAllDone } from "./settlement.js";

/**
 * The live (server-push) half of the protocol — multi-process edition.
 *
 * Lab 2's split-brain (demo in history: two processes, one room,
 * consistent database, broken fan-out) is fixed by splitting broadcast
 * into two halves with Redis pub/sub as the cross-process channel:
 *
 *   publish side  — whichever process performs a mutation builds the
 *                   event, INCRs the room's seq (Redis atomic counter:
 *                   one global ordering authority per room, replacing
 *                   the old per-process counter), and PUBLISHes to
 *                   room:{id};
 *   deliver side  — EVERY process subscribed to that room hands the
 *                   message to its own local sockets, and applies
 *                   eviction/terminal handling to the connections it
 *                   owns.
 *
 * Out-of-order note: concurrent publishers can interleave INCR and
 * PUBLISH so a lower seq may arrive after a higher one. The client's
 * seq guard (only accept seq > last) simply drops the stale one — for
 * full snapshots that is the correct outcome, and PROGRESS is healed
 * by snapshot completeness. Ordering discipline lives at the edges,
 * not in the middle.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Live-state keys are hygiene-TTL'd: if a room dies silently (no
 *  terminal broadcast, nobody connected) its counter still evaporates.
 *  Redis holds nothing that can't be rebuilt — by design. */
const SEQ_TTL_SECONDS = 24 * 60 * 60;

/**
 * Presence is a LEASE, not a flag (the SIGKILL ghost, in history at
 * 059bef5, is what a flag gets you). Every heartbeat re-earns the
 * lease for connections that answered the last ping; a process that
 * dies stops renewing and its users expire off within TTL — no death
 * notification required. Env-tunable so tests can shrink time.
 */
const PRESENCE_TTL_SECONDS = Number(process.env["PRESENCE_TTL_SECONDS"] ?? 40);
const HEARTBEAT_MS = Number(process.env["HEARTBEAT_MS"] ?? 15_000);

const roomChannel = (roomId: string): string => `room:${roomId}`;
const seqKey = (roomId: string): string => `room:${roomId}:seq`;

interface LiveConn {
  ws: WebSocket;
  userId: string;
  /** Did this socket answer the last ping? ws-level liveness: a client
   *  that vanished without FIN (dead battery, dropped WiFi) never
   *  closes; the ping/pong probe is how we notice. */
  isAlive: boolean;
}

interface Channel {
  conns: Set<LiveConn>;
  /** Last known presence signature — the sweeper broadcasts only when
   *  it actually changes, so lease expiry becomes visible to clients
   *  without spamming identical snapshots. */
  presenceSig: string;
}

class RoomHub {
  /** Local sockets only. The cross-process picture lives in Redis. */
  private channels = new Map<string, Channel>();
  private wss = new WebSocketServer({ noServer: true });
  private delivering = false;
  private heartbeat: NodeJS.Timeout | null = null;

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const match = url.pathname.match(/^\/rooms\/([0-9a-f-]{36})\/live$/i);
      const roomId = match?.[1];
      const userId = url.searchParams.get("userId") ?? "";
      if (!roomId || !UUID_RE.test(roomId) || !UUID_RE.test(userId)) {
        socket.destroy();
        return;
      }
      void (async () => {
        // Membership verified BEFORE the handshake completes (the
        // listener-gap lesson): the socket never opens unauthorized.
        const { rows } = await pool.query(
          `SELECT 1 FROM room_participants rp
            JOIN rooms r ON r.id = rp.room_id
           WHERE rp.room_id = $1 AND rp.user_id = $2 AND r.closed_at IS NULL`,
          [roomId, userId],
        );
        if (rows.length === 0) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.accept(ws, roomId, userId);
        });
      })().catch((err) => {
        console.error("[live] upgrade failed:", err);
        socket.destroy();
      });
    });
  }

  /** ws listeners attach before ANY await — kept from the lab verdict. */
  private accept(ws: WebSocket, roomId: string, userId: string): void {
    const conn: LiveConn = { ws, userId, isAlive: true };
    ws.on("pong", () => { conn.isAlive = true; });
    ws.on("close", () => {
      const channel = this.channels.get(roomId);
      if (!channel) return;
      channel.conns.delete(conn);
      // Clean closes flip presence immediately — the lease is the
      // safety net for dirty deaths, not a replacement for good news.
      void (async () => {
        await redisPub.del(presenceKey(roomId, userId));
        await this.broadcastRoom(roomId);
      })().catch((err) => console.error("[live] presence off failed:", err));
      if (channel.conns.size === 0) void this.releaseChannel(roomId);
    });
    ws.on("message", (data) => {
      void this.handleMessage(conn, roomId, String(data)).catch((err) => {
        console.error("[live] message handling failed:", err);
      });
    });

    void (async () => {
      // Order is the correctness argument: SUBSCRIBE first, snapshot
      // second. Anything published before the subscription is inside
      // the snapshot; anything after it is delivered. No gap.
      const channel = await this.claimChannel(roomId);
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        if (channel.conns.size === 0) await this.releaseChannel(roomId);
        return; // died during setup; don't strand a zombie in the set
      }
      channel.conns.add(conn);
      // First lease grant, before the snapshot is built: your own
      // snapshot already shows you online; the broadcast tells the rest.
      await redisPub.set(presenceKey(roomId, userId), "1", "EX", PRESENCE_TTL_SECONDS);
      const room = await getRoomPayload(roomId);
      if (room && ws.readyState === WebSocket.OPEN) {
        const seq = await this.nextSeq(roomId);
        ws.send(JSON.stringify(makeRoomStateEvent(seq, room)));
      }
      await this.broadcastRoom(roomId);
    })().catch((err) => {
      console.error("[live] accept failed:", err);
      ws.close(1011, "internal error");
    });
  }

  // MARK: heartbeat — the lease renewal loop

  /** One interval per process. Each tick, for every local connection:
   *  terminate sockets that didn't answer the last ping (half-open TCP
   *  never closes itself), re-earn the presence lease for those that
   *  did, and — the sweeper — re-read presence and broadcast if it
   *  changed, so leases that EXPIRED (a dead process's users) become
   *  visible to everyone without any death notification. */
  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      void this.heartbeatTick().catch((err) =>
        console.error("[live] heartbeat failed:", err));
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private async heartbeatTick(): Promise<void> {
    for (const [roomId, channel] of this.channels) {
      const renewals = redisPub.pipeline();
      for (const conn of [...channel.conns]) {
        if (!conn.isAlive) {
          conn.ws.terminate(); // fires 'close' → DEL + broadcast path
          continue;
        }
        conn.isAlive = false;
        conn.ws.ping();
        renewals.set(presenceKey(roomId, conn.userId), "1", "EX", PRESENCE_TTL_SECONDS);
      }
      await renewals.exec();

      // Sweeper: presence changed without any event on this process
      // (typically: another process died and its leases expired)?
      const room = await getRoomPayload(roomId);
      if (!room) continue;
      const sig = room.participants.map((p) => `${p.userId}:${p.connected}`).join("|");
      if (sig !== channel.presenceSig) {
        channel.presenceSig = sig;
        const seq = await this.nextSeq(roomId);
        await redisPub.publish(
          roomChannel(roomId), JSON.stringify(makeRoomStateEvent(seq, room)));
      }
    }
  }

  // MARK: publish side

  /** Called by the REST layer after every successful mutation — from
   *  whichever process handled it. No local-connection check: the
   *  members may all be on OTHER processes (that was the bug). */
  async broadcastRoom(roomId: string): Promise<void> {
    const room = await getRoomPayload(roomId);
    if (!room) return;
    const seq = await this.nextSeq(roomId);
    await redisPub.publish(
      roomChannel(roomId), JSON.stringify(makeRoomStateEvent(seq, room)));
  }

  private async broadcastProgress(roomId: string, userId: string): Promise<void> {
    const { rows } = await pool.query<{ completed: string; deck_size: string }>(
      `SELECT
         (SELECT count(*) FROM swipes
           WHERE room_id = $1 AND user_id = $2)      AS completed,
         (SELECT count(*) FROM room_candidates
           WHERE room_id = $1)                       AS deck_size`,
      [roomId, userId],
    );
    const seq = await this.nextSeq(roomId);
    await redisPub.publish(roomChannel(roomId), JSON.stringify(
      makeProgressEvent(seq, {
        userId,
        completed: Number(rows[0]?.completed ?? 0),
        deckSize: Number(rows[0]?.deck_size ?? 0),
      })));
  }

  /** The room's ordering authority: one atomic counter in Redis,
   *  shared by every process. First appearance of the atomic-counter
   *  tool that phase 4's tally is built on. */
  private async nextSeq(roomId: string): Promise<number> {
    const seq = await redisPub.incr(seqKey(roomId));
    void redisPub.expire(seqKey(roomId), SEQ_TTL_SECONDS);
    return seq;
  }

  // MARK: deliver side

  private async claimChannel(roomId: string): Promise<Channel> {
    let channel = this.channels.get(roomId);
    if (!channel) {
      channel = { conns: new Set(), presenceSig: "" };
      this.channels.set(roomId, channel);
      this.ensureDelivering();
      this.ensureHeartbeat();
      await redisSub.subscribe(roomChannel(roomId));
    }
    return channel;
  }

  private async releaseChannel(roomId: string): Promise<void> {
    this.channels.delete(roomId);
    await redisSub.unsubscribe(roomChannel(roomId)).catch((err) => {
      console.error("[live] unsubscribe failed:", err);
    });
  }

  private ensureDelivering(): void {
    if (this.delivering) return;
    this.delivering = true;
    redisSub.on("message", (channel: string, message: string) => {
      this.deliverLocal(channel.slice("room:".length), message);
    });
  }

  /** Fan the published event out to THIS process's sockets, and apply
   *  membership eviction / terminal shutdown to the connections this
   *  process owns — every process runs this for its own people. */
  private deliverLocal(roomId: string, message: string): void {
    const channel = this.channels.get(roomId);
    if (!channel || channel.conns.size === 0) return;

    let event: LiveEvent;
    try {
      event = JSON.parse(message) as LiveEvent;
    } catch {
      return;
    }

    if (event.type === "ROOM_STATE") {
      // Keep the sweeper's baseline current so it only speaks when it
      // has news the room hasn't already heard.
      channel.presenceSig = event.room.participants
        .map((p) => `${p.userId}:${p.connected}`).join("|");
    }

    const memberIds = event.type === "ROOM_STATE"
      ? new Set(event.room.participants.map((p) => p.userId))
      : null;

    for (const conn of [...channel.conns]) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(message);
      }
      // Evicted AFTER sending: a kicked guest's last event is the state
      // in which they no longer appear — their signal to leave.
      if (memberIds && !memberIds.has(conn.userId)) {
        conn.ws.close(4401, "removed from room");
        channel.conns.delete(conn);
      }
    }

    if (event.type === "ROOM_STATE" && isTerminal(event.room.state)) {
      for (const conn of [...channel.conns]) {
        conn.ws.close(1000, "room ended");
      }
      void this.releaseChannel(roomId);
      void redisPub.del(seqKey(roomId));
    }
  }

  // MARK: uplink

  /** Unchanged by the lab: uplink is per-connection, not fan-out. The
   *  wire stays at-least-once; exactly-once lives in the swipes PK. */
  private async handleMessage(
    conn: LiveConn, roomId: string, raw: string,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const msg = parsed as { type?: unknown; candidateId?: unknown; decision?: unknown };
    if (msg.type !== "SWIPE") return;
    if (typeof msg.candidateId !== "string") return;
    if (msg.decision !== "YES" && msg.decision !== "NO") return;

    const { rows } = await pool.query<{ state: string }>(
      "SELECT state FROM rooms WHERE id = $1 AND closed_at IS NULL",
      [roomId],
    );
    const state = rows[0]?.state;
    if (!state || !isRoomState(state) || !acceptsSwipes(state)) return;

    let inserted = false;
    try {
      const { rowCount } = await pool.query(
        `INSERT INTO swipes (room_id, user_id, candidate_id, decision)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, round, user_id, candidate_id) DO NOTHING`,
        [roomId, conn.userId, msg.candidateId, msg.decision],
      );
      inserted = rowCount === 1;
    } catch {
      return; // FK violation: candidate not in this room's deck
    }
    if (inserted) {
      await this.broadcastProgress(roomId, conn.userId);
      // Trigger A of ACTIVE→TALLY: everyone in the frozen roster has
      // finished the deck. (Trigger B, the inactivity timeout, comes
      // with the distributed-timer lab.) Two final swipes can land on
      // two processes at once — settlement must survive that.
      await settleIfAllDone(roomId, (id) => this.broadcastRoom(id));
    }
  }
}

export const hub = new RoomHub();
