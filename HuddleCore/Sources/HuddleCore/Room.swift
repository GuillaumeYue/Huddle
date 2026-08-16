/// A live session. In later phases this struct is a *projection* of
/// server-authoritative state (invariant 2) — the client never invents a
/// room, it renders the one the server broadcasts. In phase 1 (local mock,
/// no backend) the app fabricates one locally; the shape is identical so
/// nothing above this layer changes when the server arrives.
public struct Room: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    /// Short human-relayable credential ("share the code"). The code *is*
    /// the access control for v1; LOBBY is the approval gate.
    public let joinCode: String
    public let hostId: String
    public private(set) var state: RoomState
    public var participants: [Participant]

    public init(
        id: String,
        joinCode: String,
        hostId: String,
        state: RoomState = .lobby,
        participants: [Participant] = []
    ) {
        self.id = id
        self.joinCode = joinCode
        self.hostId = hostId
        self.state = state
        self.participants = participants
    }

    public enum TransitionError: Error, Equatable, Sendable {
        case invalid(from: RoomState, to: RoomState)
    }

    /// The only way to change `state` — setter is private so every state
    /// change in the codebase flows through the transition table and an
    /// illegal jump is unrepresentable, not just discouraged.
    public mutating func transition(to next: RoomState) throws {
        guard state.canTransition(to: next) else {
            throw TransitionError.invalid(from: state, to: next)
        }
        state = next
    }
}
