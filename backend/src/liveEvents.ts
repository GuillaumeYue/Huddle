import type { RoomPayload } from "./roomsData.js";

/**
 * Pure wire-protocol builders for the live channel — no I/O, importable
 * by tests without dragging Redis/DB connections along. The hub
 * (live.ts) is transport; this file is vocabulary.
 */

export interface SwipeProgress {
  userId: string;
  completed: number;
  deckSize: number;
}

export type LiveEvent =
  | { type: "ROOM_STATE"; seq: number; room: RoomPayload }
  | { type: "PROGRESS"; seq: number; progress: SwipeProgress };

/** Unit-tested against the shared cross-language fixtures. */
export function makeRoomStateEvent(seq: number, room: RoomPayload): LiveEvent {
  return { type: "ROOM_STATE", seq, room };
}

export function makeProgressEvent(seq: number, progress: SwipeProgress): LiveEvent {
  return { type: "PROGRESS", seq, progress };
}
