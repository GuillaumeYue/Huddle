import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeProgressEvent, makeRoomStateEvent } from "./live.js";
import type { RoomPayload } from "./roomsData.js";

/**
 * Cross-language contract tests, TS half.
 *
 * The fixtures under fixtures/ are decoded by the Swift test suite
 * (HuddleTests/WireContractTests.swift) and compared against these
 * builders' output here — the same bytes fed to both compilers. This
 * pair of suites is the closest thing the project has to a compiler
 * that spans the protocol. Change the wire shape ⇒ change the fixture
 * ⇒ both suites must pass in the same commit.
 */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8"),
  );
}

test("makeRoomStateEvent produces exactly the shared fixture", () => {
  const room: RoomPayload = {
    id: "b077a49e-4aac-40e9-953b-e9035c1658d1",
    joinCode: "JHYAJ7",
    hostId: "0ec08f3e-c110-4dce-80b8-99c4cdb97b10",
    state: "ACTIVE",
    participants: [
      {
        userId: "0ec08f3e-c110-4dce-80b8-99c4cdb97b10",
        displayName: "Alice",
        isHost: true,
      },
      {
        userId: "07dd9958-e746-4654-851d-8061147c8e7c",
        displayName: "Bob",
        isHost: false,
      },
    ],
    candidates: [
      {
        id: "mock-002",
        title: "Sakura Sushi Bar",
        metadata: {
          cuisine: "Japanese", priceLevel: "3",
          rating: "4.7", distanceMeters: "1200",
        },
      },
      {
        id: "mock-009",
        title: "The Burger Joint",
        metadata: {
          cuisine: "American", priceLevel: "1",
          rating: "3.9", distanceMeters: "450",
        },
      },
    ],
  };
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(makeRoomStateEvent(7, room))),
    fixture("room-state-event.json"),
  );
});

test("makeProgressEvent produces exactly the shared fixture", () => {
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(makeProgressEvent(12, {
      userId: "07dd9958-e746-4654-851d-8061147c8e7c",
      completed: 3,
      deckSize: 10,
    }))),
    fixture("progress-event.json"),
  );
});
