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
        #expect(room.round == 1)
        #expect(room.result == nil)
        #expect(room.participants.count == 2)
        #expect(room.participants[0].displayName == "Alice")
        #expect(room.participants[0].isHost)
        #expect(room.participants[0].completedCount == 7)
        #expect(room.participants[0].connected)
        #expect(room.participants[1].displayName == "Bob")
        #expect(!room.participants[1].isHost)
        #expect(room.participants[1].completedCount == 3)
        #expect(!room.participants[1].connected)

        let candidates = try #require(room.candidates)
        #expect(candidates.count == 2)
        #expect(candidates[0].id == "mock-002")
        #expect(candidates[0].title == "Sakura Sushi Bar")
        #expect(candidates[0].metadata["cuisine"] == "Japanese")
        #expect(candidates[1].metadata["priceLevel"] == "1")
    }

    @Test("MATCHED snapshot fixture decodes with its result")
    func matchedEventDecodes() throws {
        let event = try JSONDecoder().decode(
            LiveEventDTO.self, from: fixtureData("room-matched-event.json"))
        let room = try #require(event.room)
        #expect(room.state == .matched)
        #expect(room.result?.candidateId == "mock-009")
        #expect(room.candidates?.contains { $0.id == "mock-009" } == true)
        #expect(room.threshold == 2)
        #expect(room.tally?.count == 2)
        #expect(room.tally?.first?.candidateId == "mock-009")
        #expect(room.tally?.first?.yes == 2)
        #expect(room.tie == nil)
    }

    @Test("PROGRESS event fixture decodes")
    func progressEventDecodes() throws {
        let event = try JSONDecoder().decode(
            LiveEventDTO.self, from: fixtureData("progress-event.json"))
        #expect(event.type == "PROGRESS")
        #expect(event.seq == 12)
        #expect(event.room == nil)
        let progress = try #require(event.progress)
        #expect(progress.userId == "07dd9958-e746-4654-851d-8061147c8e7c")
        #expect(progress.completed == 3)
        #expect(progress.deckSize == 10)
    }

    @Test("SWIPE uplink encodes to the wire shape live.ts expects")
    func swipeUplinkEncodes() throws {
        let data = try JSONEncoder().encode(
            SwipeEventDTO(candidateId: "mock-002", decision: .yes))
        let json = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["type"] as? String == "SWIPE")
        #expect(json["candidateId"] as? String == "mock-002")
        #expect(json["decision"] as? String == "YES")
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
