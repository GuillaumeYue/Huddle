import Foundation
import HuddleCore
import Observation
import os

/// State of one room session, lobby through play, kept fresh by server
/// push over a single socket that lives as long as the session view.
///
/// REST remains the command channel for room lifecycle (start/kick/
/// close); swipes are the first uplink command on the socket. Every
/// ROOM_STATE snapshot is authoritative (invariant 2): the local copy is
/// only ever replaced whole, never edited.
@MainActor
@Observable
final class RoomSessionViewModel {

    private(set) var room: RoomDTO
    private(set) var errorMessage: String?
    /// Set when a snapshot no longer lists us: the host kicked us.
    private(set) var wasRemoved = false
    /// userId → cards completed, from PROGRESS events.
    private(set) var progressByUser: [String: Int] = [:]

    private let api: HuddleAPIClient
    private let socket = RoomSocket()
    private let outbox = SwipeOutbox()
    let myUserId: String

    init(room: RoomDTO, api: HuddleAPIClient, myUserId: String) {
        self.room = room
        self.api = api
        self.myUserId = myUserId
    }

    var isHost: Bool { room.hostId == myUserId }

    /// userId → label to render. Display names are labels, not identity
    /// (userId is identity — duplicates break nothing functionally), so
    /// name collisions are resolved at DISPLAY time: duplicates get a
    /// join-order suffix ("Alex 1", "Alex 2"). Numbering by roster order
    /// makes every device render the SAME labels, because the roster
    /// order is server-authoritative — "kick Alex 2" means the same
    /// person on every screen.
    var displayLabels: [String: String] {
        var occurrences: [String: Int] = [:]
        for participant in room.participants {
            occurrences[participant.displayName, default: 0] += 1
        }
        var counters: [String: Int] = [:]
        var labels: [String: String] = [:]
        for participant in room.participants {
            if occurrences[participant.displayName, default: 0] > 1 {
                let n = counters[participant.displayName, default: 0] + 1
                counters[participant.displayName] = n
                labels[participant.userId] = "\(participant.displayName) \(n)"
            } else {
                labels[participant.userId] = participant.displayName
            }
        }
        return labels
    }

    func label(for userId: String) -> String {
        displayLabels[userId] ?? "?"
    }
    /// The round is on — show the deck. Strictly ACTIVE: a terminal state
    /// also leaves LOBBY, but means "go home", not "start playing".
    var isActive: Bool { room.state == .active }
    /// The server is counting / directing the reveal: input is closed,
    /// the screen is the server's stage.
    var isTallying: Bool { room.state == .tally || room.state == .revealing }
    /// The room reached a terminal state: show the outcome (a match, no
    /// match, or "host closed the room"), then let the user leave.
    var hasEnded: Bool { room.state.isTerminal }

    /// The settled winner, resolved against the shared deck.
    var winner: Candidate? {
        guard let id = room.result?.candidateId else { return nil }
        return deck?.first { $0.id == id }
    }

    /// The shared deck as engine Candidates. Non-nil from ACTIVE onward.
    var deck: [Candidate]? {
        room.candidates.map { list in
            list.map { Candidate(id: $0.id, title: $0.title, metadata: $0.metadata) }
        }
    }

    private var isOver: Bool { hasEnded || wasRemoved }

    /// Runs for the lifetime of the session view (.task cancels on exit).
    /// Outer loop = connection sessions (2s backoff reconnect); inner
    /// loop = one session's events, with seq scoped to that session.
    /// Unlike the lobby-only version, this KEEPS listening through
    /// ACTIVE — the same socket carries swipe uplink and progress
    /// downlink while the deck is on screen.
    private let log = Logger(subsystem: "com.han.Huddle", category: "session")

    func listenWhileVisible() async {
        while !Task.isCancelled && !isOver {
            var lastSeq = 0
            log.info("connecting to room \(self.room.id, privacy: .public)")
            let connection = socket.connect(roomId: room.id, userId: myUserId)
            // Hand the fresh uplink to the outbox: anything queued while
            // we were dark replays right now, in order.
            outbox.connectionReady { try await connection.send($0) }
            do {
                for try await event in connection.events {
                    guard event.seq > lastSeq else { continue } // stale — skip
                    lastSeq = event.seq
                    switch event.type {
                    case "ROOM_STATE":
                        if let snapshot = event.room { apply(snapshot) }
                    case "PROGRESS":
                        if let progress = event.progress {
                            progressByUser[progress.userId] = progress.completed
                        }
                    default:
                        break // unknown event type — skip, never throw
                    }
                    if isOver { break }
                }
                log.info("event stream ended cleanly")
            } catch {
                // Connection dropped mid-session; breathe and reconnect —
                // the on-connect snapshot resyncs the room state.
                log.error("event stream failed: \(error, privacy: .public)")
            }
            outbox.connectionLost()
            if !isOver {
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// Ship one verdict — via the outbox, never directly. The fire-and-
    /// forget version of this method (in history, 504c192) silently lost
    /// swipes whenever the socket was down; now a verdict is either
    /// delivered or still sitting in `pending` waiting for the next
    /// connection. The server's idempotency key absorbs any replays.
    func sendSwipe(candidate: Candidate, decision: SwipeDecision) {
        outbox.enqueue(SwipeEventDTO(candidateId: candidate.id, decision: decision))
    }

    func start() async {
        do {
            apply(try await api.startRoom(id: room.id, userId: myUserId))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func kick(_ userId: String) async {
        do {
            apply(try await api.kick(roomId: room.id, hostId: myUserId,
                                     targetUserId: userId))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func close() async {
        do {
            apply(try await api.closeRoom(id: room.id, userId: myUserId))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func apply(_ snapshot: RoomDTO) {
        // Overtime: a new round is a new race. Counts are per round on
        // the wire, so the max-merge below must not carry last round's
        // numbers forward.
        if snapshot.round != room.round { progressByUser = [:] }
        room = snapshot
        // Progress resync: the snapshot carries authoritative counts, so
        // PROGRESS events missed while we were disconnected are healed
        // here. max() guards the benign race where a snapshot fetched
        // just before a swipe is delivered just after its PROGRESS —
        // counts are monotonic within a round, so newer == larger.
        for participant in snapshot.participants {
            progressByUser[participant.userId] = max(
                progressByUser[participant.userId] ?? 0,
                participant.completedCount)
        }
        if !snapshot.participants.contains(where: { $0.userId == myUserId }) {
            wasRemoved = true
        }
    }
}
