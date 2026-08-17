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
    let participants: [RoomParticipantDTO]
}

struct RoomParticipantDTO: Decodable, Identifiable, Hashable {
    let userId: String
    let displayName: String
    let isHost: Bool

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

// MARK: Request bodies (the outbound half of the treaty)

struct CreateUserBody: Encodable { let displayName: String }
struct CreateRoomBody: Encodable { let hostId: String }
struct JoinRoomBody: Encodable { let code: String, userId: String }
struct StartRoomBody: Encodable { let userId: String }
struct CloseRoomBody: Encodable { let userId: String }
struct KickBody: Encodable { let hostId: String, targetUserId: String }
