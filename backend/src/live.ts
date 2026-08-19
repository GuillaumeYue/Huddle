import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { pool } from "./db.js";
import { isTerminal } from "./domain/roomState.js";
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

export interface LiveEvent {
  type: "ROOM_STATE";
  seq: number;
  room: RoomPayload;
}

/** Pure builder — unit-tested against the shared cross-language fixture. */
export function makeRoomStateEvent(seq: number, room: RoomPayload): LiveEvent {
  return { type: "ROOM_STATE", seq, room };
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

  /** Hook the HTTP server's upgrade path: ws://…/rooms/:id/live?userId= */
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
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        void this.accept(ws, roomId, userId, req);
      });
    });
  }

  /** Connection-as-identity: the (roomId, userId) pair is checked against
   *  the database before the socket joins the channel. Auth is deferred,
   *  so userId arrives as a query param; SIWA later replaces this with a
   *  token — the registry and broadcast code won't change. */
  private async accept(
    ws: WebSocket, roomId: string, userId: string, _req: IncomingMessage,
  ): Promise<void> {
    const { rows } = await pool.query(
      `SELECT 1 FROM room_participants rp
        JOIN rooms r ON r.id = rp.room_id
       WHERE rp.room_id = $1 AND rp.user_id = $2 AND r.closed_at IS NULL`,
      [roomId, userId],
    );
    if (rows.length === 0) {
      ws.close(4403, "not a participant of a live room");
      return;
    }

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

    // Snapshot on connect: the client needs no initial GET and no
    // cross-reconnect seq bookkeeping — this message defines its world.
    // (A mutation racing this fetch can deliver the same state twice
    // with adjacent seqs; snapshot-replace semantics make that benign.)
    const room = await getRoomPayload(roomId);
    if (room && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(makeRoomStateEvent(++channel.seq, room)));
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
