import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { pool } from "./db.js";
import { acceptsSwipes, isRoomState, isTerminal } from "./domain/roomState.js";
import { getRoomPayload, type RoomPayload } from "./roomsData.js";

/**
 * The live (server-push) half of the protocol.
 *
 * Transport rules, matching the architecture notes:
 * - REST stays the COMMAND channel (mutations, with real status codes).
 * - ws is the EVENT channel: after a successful mutation the server
 *   broadcasts a full room snapshot to everyone connected to that room.
 * - Full snapshots, not deltas: the lobby is small, and "replace your
 *   whole copy with mine" is the least bug-prone reconciliation there is.
 *   Deltas are an optimization to earn later, not a starting point.
 * - Every event carries an extensible `type` (invariant 3) and a `seq`.
 *   `seq` is scoped to ONE connection session: the on-connect snapshot
 *   resets the client's world, so clients compare seq only within a
 *   connection, never across reconnects.
 */

export interface SwipeProgress {
  userId: string;
  completed: number;
  deckSize: number;
}

export type LiveEvent =
  | { type: "ROOM_STATE"; seq: number; room: RoomPayload }
  | { type: "PROGRESS"; seq: number; progress: SwipeProgress };

/** Pure builders — unit-tested against the shared cross-language fixtures. */
export function makeRoomStateEvent(seq: number, room: RoomPayload): LiveEvent {
  return { type: "ROOM_STATE", seq, room };
}

export function makeProgressEvent(seq: number, progress: SwipeProgress): LiveEvent {
  return { type: "PROGRESS", seq, progress };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LiveConn {
  ws: WebSocket;
  userId: string;
}

interface RoomChannel {
  /** Monotonic per room while it lives; survives an empty connection set
   *  so a rejoining client can never observe seq going backwards. */
  seq: number;
  conns: Set<LiveConn>;
}

class RoomHub {
  /** In-memory, single-node — deliberately. This registry IS the naive
   *  version of the cross-instance fan-out lab: run two server processes
   *  and a room's members split across them stop hearing each other.
   *  Redis pub/sub arrives to fix exactly that, later in phase 3. */
  private channels = new Map<string, RoomChannel>();
  private wss = new WebSocketServer({ noServer: true });

  /** Hook the HTTP server's upgrade path: ws://…/rooms/:id/live?userId=
   *
   *  Authorization runs BEFORE the handshake completes. The tempting
   *  alternative — finish the handshake, then check membership, then
   *  attach listeners — leaves an await gap between "socket open" and
   *  "someone listening": an eager client (our outbox drains the moment
   *  the connection opens) can land messages in that gap, and an
   *  EventEmitter with no listener drops them on the floor. Verify
   *  first, and attach listeners synchronously at open. */
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
        // Connection-as-identity: (roomId, userId) checked against the
        // db. Auth is deferred, so userId is a query param; SIWA later
        // replaces this with a token — nothing below changes.
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

  /** Synchronous on purpose: every listener is attached before this
   *  function returns, i.e. before anything else can run — no await gap
   *  for early uplink messages to fall into. */
  private accept(ws: WebSocket, roomId: string, userId: string): void {
    let channel = this.channels.get(roomId);
    if (!channel) {
      channel = { seq: 0, conns: new Set() };
      this.channels.set(roomId, channel);
    }
    const conn: LiveConn = { ws, userId };
    channel.conns.add(conn);
    ws.on("close", () => {
      channel.conns.delete(conn);
      // The channel skeleton (seq) is kept until the room ends — see
      // RoomChannel.seq. Cleared in broadcast on terminal state.
    });
    ws.on("message", (data) => {
      void this.handleMessage(conn, roomId, String(data)).catch((err) => {
        console.error("[live] message handling failed:", err);
      });
    });

    // Snapshot on connect: the client needs no initial GET and no
    // cross-reconnect seq bookkeeping — this message defines its world.
    // (A mutation racing this fetch can deliver the same state twice
    // with adjacent seqs; snapshot-replace semantics make that benign.)
    void (async () => {
      const room = await getRoomPayload(roomId);
      if (room && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(makeRoomStateEvent(++channel.seq, room)));
      }
    })().catch((err) => console.error("[live] snapshot failed:", err));
  }

  /**
   * Uplink handler — the first ws-borne command. Same tolerance rules as
   * the client's receiver: unknown types and malformed frames are
   * dropped, never fatal. The wire is at-least-once (clients may resend);
   * exactly-once-ness lives in the swipes PRIMARY KEY, not up here.
   */
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

    // The swipe gate: only ACTIVE accepts input. This is where
    // "REVEALING is input-closed" stops being a comment in the state
    // machine and starts rejecting real late packets.
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
      // FK violation: candidate not in this room's deck — a buggy or
      // hostile client; drop it (integrity was declared in the schema).
      return;
    }
    if (inserted) {
      await this.broadcastProgress(roomId, conn.userId);
    }
  }

  private async broadcastProgress(roomId: string, userId: string): Promise<void> {
    const channel = this.channels.get(roomId);
    if (!channel || channel.conns.size === 0) return;

    const { rows } = await pool.query<{ completed: string; deck_size: string }>(
      `SELECT
         (SELECT count(*) FROM swipes
           WHERE room_id = $1 AND user_id = $2)      AS completed,
         (SELECT count(*) FROM room_candidates
           WHERE room_id = $1)                       AS deck_size`,
      [roomId, userId],
    );
    const event = makeProgressEvent(++channel.seq, {
      userId,
      completed: Number(rows[0]?.completed ?? 0),
      deckSize: Number(rows[0]?.deck_size ?? 0),
    });
    const message = JSON.stringify(event);
    for (const conn of channel.conns) {
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(message);
    }
  }

  /** Called by the REST layer after every successful mutation. */
  async broadcastRoom(roomId: string): Promise<void> {
    const channel = this.channels.get(roomId);
    if (!channel || channel.conns.size === 0) return;

    const room = await getRoomPayload(roomId);
    if (!room) return;

    const message = JSON.stringify(makeRoomStateEvent(++channel.seq, room));
    const memberIds = new Set(room.participants.map((p) => p.userId));

    for (const conn of [...channel.conns]) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(message);
      }
      // Evicted AFTER sending: a kicked guest's last event is the state
      // in which they no longer appear — their signal to leave.
      if (!memberIds.has(conn.userId)) {
        conn.ws.close(4401, "removed from room");
        channel.conns.delete(conn);
      }
    }

    if (isTerminal(room.state)) {
      for (const conn of [...channel.conns]) {
        conn.ws.close(1000, "room ended");
      }
      this.channels.delete(roomId);
    }
  }
}

export const hub = new RoomHub();
