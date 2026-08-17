import Foundation
import HuddleCore
import Observation

/// State of one lobby, kept fresh by polling.
///
/// Phase 2: `GET /rooms/:id` every 2 seconds is the stand-in for the
/// phase-3 WebSocket push — same "decode → update state → UI reacts"
/// pipeline, only the transport changes. Everything here treats the
/// fetched RoomDTO as authoritative (invariant 2): we never mutate the
/// local copy except by replacing it with a fresh server snapshot.
@MainActor
@Observable
final class LobbyViewModel {

    private(set) var room: RoomDTO
    private(set) var errorMessage: String?
    /// Set when the server snapshot no longer lists us: the host kicked
    /// us while we were polling. The view exits on this.
    private(set) var wasRemoved = false

    private let api: HuddleAPIClient
    let myUserId: String

    init(room: RoomDTO, api: HuddleAPIClient, myUserId: String) {
        self.room = room
        self.api = api
        self.myUserId = myUserId
    }

    var isHost: Bool { room.hostId == myUserId }
    var hasStarted: Bool { room.state != .lobby }

    /// Runs for the lifetime of the lobby view (.task cancels it on exit).
    func pollWhileVisible() async {
        while !Task.isCancelled && !hasStarted && !wasRemoved {
            try? await Task.sleep(for: .seconds(2))
            await refresh()
        }
    }

    func refresh() async {
        do {
            apply(try await api.room(id: room.id))
        } catch {
            // Transient poll failures are silent by design: the next tick
            // retries, and a lobby that flashes errors on every WiFi blip
            // is worse than one that's 2s stale.
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
