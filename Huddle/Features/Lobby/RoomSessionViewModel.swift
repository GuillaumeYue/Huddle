import Foundation
import HuddleCore
import Observation

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
    private var connection: RoomSocket.Connection?
    let myUserId: String

    init(room: RoomDTO, api: HuddleAPIClient, myUserId: String) {
        self.room = room
        self.api = api
        self.myUserId = myUserId
    }

    var isHost: Bool { room.hostId == myUserId }
    /// The round is on — show the deck. Strictly ACTIVE: a terminal state
    /// also leaves LOBBY, but means "go home", not "start playing".
    var isActive: Bool { room.state == .active }
    /// The room ended (host closed it) — leave quietly.
    var hasEnded: Bool { room.state.isTerminal }

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
    func listenWhileVisible() async {
        defer { connection = nil }
        while !Task.isCancelled && !isOver {
            var lastSeq = 0
            let connection = socket.connect(roomId: room.id, userId: myUserId)
            self.connection = connection
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
            } catch {
                // Connection dropped mid-session; breathe and reconnect —
                // the on-connect snapshot resyncs the room state.
            }
            if !isOver {
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// Ship one verdict. NAIVELY fire-and-forget, on purpose: if the
    /// socket happens to be down, this swipe is silently lost — the
    /// server never hears it, and the room can hang waiting for us.
    /// That loss is the demonstration piece of the optimistic-swipe /
    /// reconcile lab, which fixes it with a pending queue + replay.
    func sendSwipe(candidate: Candidate, decision: SwipeDecision) {
        let event = SwipeEventDTO(candidateId: candidate.id, decision: decision)
        Task { [connection] in
            try? await connection?.send(event)
        }
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
        room = snapshot
        if !snapshot.participants.contains(where: { $0.userId == myUserId }) {
            wasRemoved = true
        }
    }
}
