import Foundation
import Testing
@testable import HuddleCore

// These types are the future wire format (invariant 2: the client renders
// what the server sends). A round-trip test now means phase 3 inherits
// types that are proven to survive encode/decode unchanged.

@Suite("Codable round trips")
struct CodableRoundTripTests {

    @Test("Candidate survives a round trip, metadata intact and opaque")
    func candidateRoundTrip() throws {
        let original = Candidate(
            id: "c1",
            title: "Sichuan Palace",
            metadata: ["cuisine": "sichuan", "rating": "4.5", "distanceMeters": "800"]
        )
        let decoded = try JSONDecoder().decode(
            Candidate.self, from: JSONEncoder().encode(original))
        #expect(decoded == original)
    }

    @Test("Room with participants survives a round trip")
    func roomRoundTrip() throws {
        let original = Room(
            id: "r1",
            joinCode: "ABC123",
            hostId: "u1",
            state: .active,
            participants: [
                Participant(userId: "u1", displayName: "Han", isHost: true),
                Participant(userId: "u2", displayName: "Wei"),
            ]
        )
        let decoded = try JSONDecoder().decode(
            Room.self, from: JSONEncoder().encode(original))
        #expect(decoded == original)
    }

    @Test("RoomState encodes as its SCREAMING_CASE wire string")
    func roomStateWireFormat() throws {
        let data = try JSONEncoder().encode(RoomState.noResult)
        #expect(String(data: data, encoding: .utf8) == "\"NO_RESULT\"")
    }

    @Test("All wire strings decode back to the right case",
          arguments: RoomState.allCases)
    func wireStringsRoundTrip(state: RoomState) throws {
        let decoded = try JSONDecoder().decode(
            RoomState.self, from: JSONEncoder().encode(state))
        #expect(decoded == state)
    }

    @Test("SwipeDecision uses YES/NO wire strings",
          arguments: SwipeDecision.allCases)
    func swipeDecisionWireFormat(decision: SwipeDecision) throws {
        let decoded = try JSONDecoder().decode(
            SwipeDecision.self, from: JSONEncoder().encode(decision))
        #expect(decoded == decision)
        #expect(decision.rawValue == decision.rawValue.uppercased())
    }
}
