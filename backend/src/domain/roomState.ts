/**
 * MIRROR of HuddleCore/Sources/HuddleCore/RoomState.swift — the TS half
 * of the wire contract. The strings below ARE the protocol; they must
 * match the Swift raw values byte-for-byte. No compiler spans the two
 * languages, so the contract is held by (a) this file staying visually
 * diff-able against its Swift twin, and (b) the mirrored test suite.
 * Change one side only in a commit that changes both.
 */
export const ROOM_STATES = [
  "LOBBY",
  "ACTIVE",
  "TALLY",
  "REVEALING",
  "MATCHED",
  "NO_RESULT",
] as const;

export type RoomState = (typeof ROOM_STATES)[number];

/** Same transition table as RoomState.allowedTransitions in Swift. */
const TRANSITIONS: Record<RoomState, readonly RoomState[]> = {
  // Start the round, or host ends before anything happened.
  LOBBY: ["ACTIVE", "NO_RESULT"],
  // All present finished, or the inactivity timeout fired; host may end.
  ACTIVE: ["TALLY", "NO_RESULT"],
  // Reveal, or overtime re-run (fresh deck / eliminate-lowest), or host end.
  TALLY: ["REVEALING", "ACTIVE", "NO_RESULT"],
  REVEALING: ["MATCHED", "NO_RESULT"],
  MATCHED: [],
  NO_RESULT: [],
};

export function isRoomState(value: string): value is RoomState {
  return (ROOM_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: RoomState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function canTransition(from: RoomState, to: RoomState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Swipes are only accepted while ACTIVE (REVEALING is input-closed). */
export function acceptsSwipes(state: RoomState): boolean {
  return state === "ACTIVE";
}
