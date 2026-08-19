import Foundation
import Observation
import os

/// The outbox half of "optimistic swipe + reconcile".
///
/// The deck UI is optimistic: a card flies away the moment you swipe,
/// no round-trip. This box makes the *reporting* reliable: verdicts are
/// queued here and drained over the live connection in order; a failed
/// send leaves the verdict queued, and every new connection replays
/// whatever is pending.
///
/// The wire contract this leans on: sends are AT-LEAST-ONCE (a verdict
/// whose send "failed" may in truth have reached the server — network
/// errors are ambiguous), and the server's swipes primary key
/// (room, round, user, candidate) makes the duplicates no-ops. Retry
/// freely, count once — reliability is split between the two ends.
///
/// @MainActor: enqueue/drain are serialized by the actor, so there is
/// exactly one in-flight drain and the queue order IS the send order
/// (the "socket-event serialization" iOS lab, in its simplest form).
@MainActor
@Observable
final class SwipeOutbox {

    private(set) var pending: [SwipeEventDTO] = []

    /// The current connection's uplink; nil while disconnected.
    private var sender: ((SwipeEventDTO) async throws -> Void)?
    private var isDraining = false
    private let log = Logger(subsystem: "com.han.Huddle", category: "outbox")

    func enqueue(_ event: SwipeEventDTO) {
        pending.append(event)
        log.info("enqueue \(event.candidateId, privacy: .public) pending=\(self.pending.count) online=\(self.sender != nil)")
        Task { await drain() }
    }

    /// A (re)connection is live: adopt its uplink and replay the backlog.
    func connectionReady(_ send: @escaping (SwipeEventDTO) async throws -> Void) {
        sender = send
        log.notice("connectionReady, pending=\(self.pending.count)")
        Task { await drain() }
    }

    func connectionLost() {
        log.notice("connectionLost, pending=\(self.pending.count)")
        sender = nil
    }

    func drain() async {
        guard !isDraining else { return }
        isDraining = true
        defer { isDraining = false }

        // Both conditions re-read every lap: connectionLost() mid-drain
        // stops the loop, and items enqueued mid-drain get picked up.
        while let send = sender, let next = pending.first {
            do {
                try await send(next)
                pending.removeFirst()
                log.notice("sent \(next.candidateId, privacy: .public), pending=\(self.pending.count)")
            } catch {
                // Send failed — the verdict STAYS queued (the whole point).
                // The next connectionReady() will replay it; if it did
                // reach the server after all, the PK absorbs the replay.
                log.error("send failed \(next.candidateId, privacy: .public): \(error, privacy: .public), pending=\(self.pending.count)")
                break
            }
        }
    }
}
