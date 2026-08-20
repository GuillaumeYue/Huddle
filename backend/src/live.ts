import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { pool } from "./db.js";
import { acceptsSwipes, isRoomState, isTerminal } from "./domain/roomState.js";
import {
  makeProgressEvent, makeRoomStateEvent, type LiveEvent,
} from "./liveEvents.js";
import { redisPub, redisSub } from "./redis.js";
import { getRoomPayload } from "./roomsData.js";

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

const roomChannel = (roomId: string): string => `room:${roomId}`;
const seqKey = (roomId: string): string => `room:${roomId}:seq`;

interface LiveConn {
  ws: WebSocket;
  userId: string;
}

class RoomHub {
  /** Local sockets only. The cross-process picture lives in Redis. */
  private channels = new Map<string, Set<LiveConn>>();
  private wss = new WebSocketServer({ noServer: true });
  private delivering = false;

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
    const conn: LiveConn = { ws, userId };
    ws.on("close", () => {
      const conns = this.channels.get(roomId);
      if (!conns) return;
      conns.delete(conn);
      if (conns.size === 0) void this.releaseChannel(roomId);
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
      const conns = await this.claimChannel(roomId);
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        if (conns.size === 0) await this.releaseChannel(roomId);
        return; // died during setup; don't strand a zombie in the set
      }
      conns.add(conn);
      const room = await getRoomPayload(roomId);
      if (room && ws.readyState === WebSocket.OPEN) {
        const seq = await this.nextSeq(roomId);
        ws.send(JSON.stringify(makeRoomStateEvent(seq, room)));
      }
    })().catch((err) => {
      console.error("[live] accept failed:", err);
      ws.close(1011, "internal error");
    });
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

  private async claimChannel(roomId: string): Promise<Set<LiveConn>> {
    let conns = this.channels.get(roomId);
    if (!conns) {
      conns = new Set();
      this.channels.set(roomId, conns);
      this.ensureDelivering();
      await redisSub.subscribe(roomChannel(roomId));
    }
    return conns;
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
    const conns = this.channels.get(roomId);
    if (!conns || conns.size === 0) return;

    let event: LiveEvent;
    try {
      event = JSON.parse(message) as LiveEvent;
    } catch {
      return;
    }

    const memberIds = event.type === "ROOM_STATE"
      ? new Set(event.room.participants.map((p) => p.userId))
      : null;

    for (const conn of [...conns]) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(message);
      }
      // Evicted AFTER sending: a kicked guest's last event is the state
      // in which they no longer appear — their signal to leave.
      if (memberIds && !memberIds.has(conn.userId)) {
        conn.ws.close(4401, "removed from room");
        conns.delete(conn);
      }
    }

    if (event.type === "ROOM_STATE" && isTerminal(event.room.state)) {
      for (const conn of [...conns]) {
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
    }
  }
}

export const hub = new RoomHub();
