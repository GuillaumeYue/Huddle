import HuddleCore

/// Wire DTOs — the Swift copy of the treaty.
///
/// These types answer "what did the server SAY" (facts/snapshots), and
/// deliberately do not reuse HuddleCore's `Room`, which answers "how may
/// state change" (rules; private-set state + transition(to:)). Rules and
/// facts in one type would fight — the server's snapshot is authoritative
/// and never goes through local transition checks (the judge already ran
/// them). Pure value types with no invariants to guard (RoomState) ARE
/// reused: same wire strings on both ends of the protocol.
///
/// Mirror of backend/src/rooms.ts `roomPayload()` — field for field.

struct RoomDTO: Decodable, Identifiable, Hashable {
    let id: String
    let joinCode: String
    let hostId: String
    let state: RoomState
    /// Current round; overtime bumps it.
    let round: Int
    /// Settled outcome, present only in MATCHED.
    let result: RoomResultDTO?
    /// Consensus threshold (v1: roster size). From TALLY on.
    let threshold: Int?
    /// Yes-counts per candidate, most first. From TALLY on — never
    /// during ACTIVE, so the reveal keeps its suspense.
    let tally: [TallyEntryDTO]?
    /// Candidates that all reached consensus: a blind pick is pending.
    let tie: [String]?
    let participants: [RoomParticipantDTO]
    /// The shared deck; present from ACTIVE onward, absent in LOBBY.
    let candidates: [CandidateDTO]?
}

struct RoomResultDTO: Decodable, Hashable {
    let candidateId: String
    /// How many hidden picks the winner received, when any were cast.
    let pickedBy: Int?
}

struct TallyEntryDTO: Decodable, Hashable {
    let candidateId: String
    let yes: Int
}

struct CandidateDTO: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let metadata: [String: String]
}

struct RoomParticipantDTO: Decodable, Identifiable, Hashable {
    let userId: String
    let displayName: String
    let isHost: Bool
    /// Swipes recorded this round, from the authoritative snapshot.
    /// PROGRESS deltas accelerate this; the snapshot is the truth that
    /// survives your own disconnections.
    let completedCount: Int
    /// Live-socket presence, as the server currently believes it.
    let connected: Bool
    /// Cast their hidden pick (REVEALING only); the pick stays secret.
    let hasPicked: Bool

    var id: String { userId }
}

struct UserDTO: Decodable {
    let id: String
    let displayName: String
}

/// Every error body the backend produces: { "error": "..." }
struct ServerErrorDTO: Decodable {
    let error: String
}

/// Envelope of every server-push event (mirror of live.ts LiveEvent).
///
/// `type` is a raw String, NOT an enum — deliberately (invariant 3): a
/// future server may broadcast types this build has never heard of, and
/// they must decode-and-be-skipped, not throw and kill the stream. The
/// per-type payload fields are optional for the same reason.
/// `seq` orders events within one connection session; the on-connect
/// snapshot starts the world over, so it is never compared across
/// reconnects.
struct LiveEventDTO: Decodable {
    let type: String
    let seq: Int
    let room: RoomDTO?
    let progress: SwipeProgressDTO?
}

/// PROGRESS payload: how far one participant is through the deck.
struct SwipeProgressDTO: Decodable {
    let userId: String
    let completed: Int
    let deckSize: Int
}

/// Uplink: one verdict, sent over the room socket. The server's swipes
/// primary key (room, round, user, candidate) makes resends no-ops, so
/// this message may be sent at-least-once without double counting.
struct SwipeEventDTO: Encodable, Equatable {
    var type = "SWIPE"
    let candidateId: String
    let decision: SwipeDecision
}

// MARK: Request bodies (the outbound half of the treaty)

struct CreateUserBody: Encodable { let displayName: String }
struct CreateRoomBody: Encodable { let hostId: String }
struct JoinRoomBody: Encodable { let code: String, userId: String }
struct StartRoomBody: Encodable { let userId: String }
struct CloseRoomBody: Encodable { let userId: String }
struct KickBody: Encodable { let hostId: String, targetUserId: String }
struct PickBody: Encodable { let userId: String, candidateId: String }


/// Session history: the finished rooms this user was part of.
struct HistoryDTO: Decodable {
    let rooms: [HistoryRoomDTO]
}

struct HistoryRoomDTO: Decodable, Identifiable, Hashable {
    let id: String
    let state: RoomState
    let closedAt: String
    let resultTitle: String?
    let participantCount: Int
}
