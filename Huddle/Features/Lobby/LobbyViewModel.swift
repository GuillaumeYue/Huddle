import Foundation
import HuddleCore
import Observation

/// State of one lobby, kept fresh by server push.
///
/// Phase 3: the 2-second polling loop is gone — a RoomSocket stream
/// delivers ROOM_STATE events, same "decode → replace state → UI reacts"
/// pipeline with the transport swapped, exactly as planned. REST remains
/// the command channel (start/kick/close); the socket only listens.
/// Every snapshot is authoritative (invariant 2): the local copy is only
/// ever replaced whole, never edited.
@MainActor
@Observable
final class LobbyViewModel {

    private(set) var room: RoomDTO
    private(set) var errorMessage: String?
    /// Set when a snapshot no longer lists us: the host kicked us.
    private(set) var wasRemoved = false

    private let api: HuddleAPIClient
    private let socket = RoomSocket()
    let myUserId: String

    init(room: RoomDTO, api: HuddleAPIClient, myUserId: String) {
        self.room = room
        self.api = api
        self.myUserId = myUserId
    }

    var isHost: Bool { room.hostId == myUserId }
    /// The round began — move to the deck. Strictly ACTIVE: a terminal
    /// state also leaves LOBBY, but means "go home", not "start playing"
    /// (the old `state != .lobby` check sent closed-room guests into the
    /// deck by mistake).
    var isActive: Bool { room.state == .active }
    /// The room ended without starting (host closed it) — leave quietly.
    var hasEnded: Bool { room.state.isTerminal }

    private var isSettled: Bool { isActive || hasEnded || wasRemoved }

    /// Runs for the lifetime of the lobby view (.task cancels it on exit).
    /// Outer loop = connection sessions (reconnect after 2s on drop);
    /// inner loop = one session's events. seq lives INSIDE the session:
    /// each connection starts with an authoritative snapshot, so ordering
    /// is only ever compared within one session, never across two.
    func listenWhileVisible() async {
        while !Task.isCancelled && !isSettled {
            var lastSeq = 0
            do {
                for try await event in socket.events(roomId: room.id, userId: myUserId) {
                    guard event.type == "ROOM_STATE",
                          let snapshot = event.room,
                          event.seq > lastSeq
                    else { continue } // unknown type or stale — skip, never throw
                    lastSeq = event.seq
                    apply(snapshot)
                    if isSettled { break }
                }
            } catch {
                // Connection dropped. If the lobby is still live, breathe
                // and reconnect — the on-connect snapshot resyncs us.
            }
            if !isSettled {
                try? await Task.sleep(for: .seconds(2))
            }
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
