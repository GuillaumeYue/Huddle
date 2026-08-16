import Testing
@testable import HuddleCore

// The state machine is the spine of the whole product, so its tests are
// exhaustive over the transition table, not spot checks.

@Suite("RoomState machine")
struct RoomStateTests {

    @Test("Happy path walks LOBBY → ACTIVE → TALLY → REVEALING → MATCHED")
    func happyPath() throws {
        var room = Room(id: "r1", joinCode: "ABC123", hostId: "u1")
        try room.transition(to: .active)
        try room.transition(to: .tally)
        try room.transition(to: .revealing)
        try room.transition(to: .matched)
        #expect(room.state == .matched)
    }

    @Test("Overtime loops back: TALLY → ACTIVE → TALLY is legal")
    func overtimeReRun() throws {
        var room = Room(id: "r1", joinCode: "ABC123", hostId: "u1", state: .tally)
        try room.transition(to: .active)   // eliminate-lowest / fresh-deck round
        try room.transition(to: .tally)
        #expect(room.state == .tally)
    }

    @Test("Host can end from every non-terminal state", arguments: RoomState.allCases)
    func hostEndAlwaysAvailable(state: RoomState) {
        if !state.isTerminal {
            #expect(state.canTransition(to: .noResult),
                    "Non-terminal \(state) must offer the host-end exit")
        }
    }

    @Test("Terminal states have no exits", arguments: RoomState.allCases)
    func terminalStatesAreFinal(state: RoomState) {
        if state.isTerminal {
            #expect(state.allowedTransitions.isEmpty)
        }
    }

    @Test("Every non-terminal state has at least one exit — no dead ends",
          arguments: RoomState.allCases)
    func noDeadEnds(state: RoomState) {
        if !state.isTerminal {
            #expect(!state.allowedTransitions.isEmpty)
        }
    }

    @Test("Only ACTIVE accepts swipes; REVEALING in particular is input-closed",
          arguments: RoomState.allCases)
    func swipeGate(state: RoomState) {
        #expect(state.acceptsSwipes == (state == .active))
    }

    @Test("Illegal jumps throw and leave state untouched")
    func illegalTransitionThrows() {
        var room = Room(id: "r1", joinCode: "ABC123", hostId: "u1") // lobby
        #expect(throws: Room.TransitionError.invalid(from: .lobby, to: .matched)) {
            try room.transition(to: .matched)
        }
        #expect(room.state == .lobby)
    }

    @Test("No transition re-enters LOBBY — a started room never un-starts",
          arguments: RoomState.allCases)
    func lobbyIsUnreachable(state: RoomState) {
        #expect(!state.canTransition(to: .lobby))
    }
}
