import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ROOM_STATES,
  acceptsSwipes,
  canTransition,
  isTerminal,
} from "./roomState.js";

// Mirror of HuddleCoreTests/RoomStateTests.swift — same invariants,
// exhaustive over the same table. If a test exists on one side and not
// the other, the mirror is drifting.

test("happy path walks LOBBY → ACTIVE → TALLY → REVEALING → MATCHED", () => {
  assert.ok(canTransition("LOBBY", "ACTIVE"));
  assert.ok(canTransition("ACTIVE", "TALLY"));
  assert.ok(canTransition("TALLY", "REVEALING"));
  assert.ok(canTransition("REVEALING", "MATCHED"));
});

test("overtime loops back: TALLY → ACTIVE is legal", () => {
  assert.ok(canTransition("TALLY", "ACTIVE"));
  assert.ok(canTransition("ACTIVE", "TALLY"));
});

test("host can end from every non-terminal state", () => {
  for (const state of ROOM_STATES) {
    if (!isTerminal(state)) {
      assert.ok(canTransition(state, "NO_RESULT"), `${state} must offer host-end`);
    }
  }
});

test("terminal states have no exits", () => {
  for (const state of ROOM_STATES) {
    if (isTerminal(state)) {
      for (const to of ROOM_STATES) {
        assert.equal(canTransition(state, to), false);
      }
    }
  }
});

test("every non-terminal state has at least one exit — no dead ends", () => {
  for (const state of ROOM_STATES) {
    if (!isTerminal(state)) {
      assert.ok(ROOM_STATES.some((to) => canTransition(state, to)));
    }
  }
});

test("only ACTIVE accepts swipes; REVEALING in particular is input-closed", () => {
  for (const state of ROOM_STATES) {
    assert.equal(acceptsSwipes(state), state === "ACTIVE");
  }
});

test("no transition re-enters LOBBY — a started room never un-starts", () => {
  for (const state of ROOM_STATES) {
    assert.equal(canTransition(state, "LOBBY"), false);
  }
});
