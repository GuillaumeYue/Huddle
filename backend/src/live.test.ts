import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeRoomStateEvent } from "./live.js";
import type { RoomPayload } from "./roomsData.js";

/**
 * Cross-language contract test, TS half.
 *
 * fixtures/room-state-event.json is decoded by the Swift test suite
 * (HuddleTests/WireContractTests.swift) and compared against this
 * builder's output here — the same bytes fed to both compilers. This
 * pair of tests is the closest thing the project has to a compiler
 * that spans the protocol. Change the wire shape ⇒ change the fixture
 * ⇒ both suites must pass in the same commit.
 */
const fixtureURL = new URL("../../fixtures/room-state-event.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureURL, "utf8")) as unknown;

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
  };
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(makeRoomStateEvent(7, room))),
    fixture,
  );
});
