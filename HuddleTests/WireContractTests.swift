import Foundation
import HuddleCore
import Testing
@testable import Huddle

/// Cross-language contract tests, Swift half.
///
/// Decodes the SAME fixture bytes that backend/src/live.test.ts asserts
/// its event builder produces — the two suites together stand in for the
/// cross-language compiler that doesn't exist. A wire-shape change must
/// update the fixture and pass both suites in one commit.
@Suite("Wire contract fixtures")
struct WireContractTests {

    private func fixtureData(_ name: String) throws -> Data {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // WireContractTests.swift
            .deletingLastPathComponent()   // HuddleTests/
            .appending(path: "fixtures/\(name)")
        return try Data(contentsOf: url)
    }

    @Test("ROOM_STATE event fixture decodes into the DTO layer")
    func roomStateEventDecodes() throws {
        let event = try JSONDecoder().decode(
            LiveEventDTO.self, from: fixtureData("room-state-event.json"))

        #expect(event.type == "ROOM_STATE")
        #expect(event.seq == 7)
        let room = try #require(event.room)
        #expect(room.id == "b077a49e-4aac-40e9-953b-e9035c1658d1")
        #expect(room.joinCode == "JHYAJ7")
        #expect(room.state == .active)
        #expect(room.participants.count == 2)
        #expect(room.participants[0].displayName == "Alice")
        #expect(room.participants[0].isHost)
        #expect(room.participants[1].displayName == "Bob")
        #expect(!room.participants[1].isHost)
    }

    @Test("Unknown event types decode instead of throwing — forward compatibility")
    func unknownEventTolerated() throws {
        // A future server may broadcast types this build has never heard
        // of (invariant 3). The envelope must decode; the client skips it.
        let bytes = Data(#"{"type":"CONFETTI_BURST","seq":9}"#.utf8)
        let event = try JSONDecoder().decode(LiveEventDTO.self, from: bytes)
        #expect(event.type == "CONFETTI_BURST")
        #expect(event.room == nil)
    }
}
