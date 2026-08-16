/// The lifecycle of a room. Every state has a guaranteed exit — no dead ends.
///
/// Locked flow: `LOBBY → ACTIVE → TALLY → REVEALING → MATCHED | NO_RESULT`.
/// The host may end the session at any time (modeled as a transition to
/// `.noResult`, the graceful terminal).
///
/// Raw values are SCREAMING_CASE because they are the wire format: the
/// backend will emit these exact strings, and the client must decode them
/// byte-for-byte. Do not rename casually — that is a protocol change.
public enum RoomState: String, Codable, Sendable, CaseIterable {
    case lobby = "LOBBY"
    case active = "ACTIVE"
    case tally = "TALLY"
    case revealing = "REVEALING"
    case matched = "MATCHED"
    case noResult = "NO_RESULT"

    /// Terminal states have no exits. A room that reaches one is resolved.
    public var isTerminal: Bool {
        switch self {
        case .matched, .noResult: true
        case .lobby, .active, .tally, .revealing: false
        }
    }

    /// Swipes are only accepted while ACTIVE. In particular REVEALING is
    /// input-closed: the server directs the reveal pacing and any swipe
    /// arriving in that window must be rejected, not queued.
    public var acceptsSwipes: Bool {
        self == .active
    }

    /// The full transition table. Keeping it in one place (rather than
    /// scattered `if` checks) makes the state machine auditable: the tests
    /// walk this table exhaustively.
    public var allowedTransitions: Set<RoomState> {
        switch self {
        case .lobby:
            // Start the round, or host ends before anything happened.
            [.active, .noResult]
        case .active:
            // All present finished swiping, or the inactivity timeout fired.
            // Either trigger lands in TALLY; host may still end.
            [.tally, .noResult]
        case .tally:
            // .revealing — a result (match, tie resolution, blind pick) is
            //   ready to be presented.
            // .active — overtime: eliminate-lowest re-run or a fresh-deck
            //   round after zero valid yes. Hard-capped by the engine (the
            //   cap lives with the round logic, not in this table).
            [.revealing, .active, .noResult]
        case .revealing:
            [.matched, .noResult]
        case .matched, .noResult:
            []
        }
    }

    public func canTransition(to next: RoomState) -> Bool {
        allowedTransitions.contains(next)
    }
}
