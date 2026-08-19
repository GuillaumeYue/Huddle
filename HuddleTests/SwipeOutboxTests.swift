import Foundation
import HuddleCore
import Testing
@testable import Huddle

/// The outbox's behavioral contract. The naive predecessor (fire-and-
/// forget send, in history at 504c192) fails every one of these:
/// disconnected swipes vanished silently.
@MainActor
@Suite("Swipe outbox")
struct SwipeOutboxTests {

    private func swipe(_ id: String) -> SwipeEventDTO {
        SwipeEventDTO(candidateId: id, decision: .yes)
    }

    @Test("Swipes made while disconnected are queued, not lost")
    func queuesWhileDisconnected() async {
        let outbox = SwipeOutbox()
        outbox.enqueue(swipe("c1"))
        outbox.enqueue(swipe("c2"))
        await outbox.drain()   // no connection: draining must be a no-op
        #expect(outbox.pending.map(\.candidateId) == ["c1", "c2"])
    }

    @Test("A new connection replays the backlog in order")
    func replaysInOrderOnConnect() async {
        let outbox = SwipeOutbox()
        outbox.enqueue(swipe("c1"))
        outbox.enqueue(swipe("c2"))
        outbox.enqueue(swipe("c3"))

        var sent: [String] = []
        outbox.connectionReady { sent.append($0.candidateId) }
        await outbox.drain()

        #expect(sent == ["c1", "c2", "c3"])
        #expect(outbox.pending.isEmpty)
    }

    @Test("A failed send keeps the failed verdict and everything after it")
    func failedSendKeepsRemaining() async {
        let outbox = SwipeOutbox()
        outbox.enqueue(swipe("c1"))
        outbox.enqueue(swipe("c2"))
        outbox.enqueue(swipe("c3"))

        var sent: [String] = []
        struct Down: Error {}
        outbox.connectionReady { event in
            guard sent.count < 1 else { throw Down() }  // dies after c1
            sent.append(event.candidateId)
        }
        await outbox.drain()

        #expect(sent == ["c1"])
        #expect(outbox.pending.map(\.candidateId) == ["c2", "c3"])

        // The next connection picks up exactly where the last one died.
        outbox.connectionReady { sent.append($0.candidateId) }
        await outbox.drain()
        #expect(sent == ["c1", "c2", "c3"])
        #expect(outbox.pending.isEmpty)
    }

    @Test("connectionLost mid-drain stops sending; nothing is dropped")
    func lostMidDrainStops() async {
        let outbox = SwipeOutbox()
        outbox.enqueue(swipe("c1"))
        outbox.enqueue(swipe("c2"))

        var sent: [String] = []
        outbox.connectionReady { [weak outbox] event in
            sent.append(event.candidateId)
            outbox?.connectionLost()   // the link dies right after c1 lands
        }
        await outbox.drain()

        #expect(sent == ["c1"])
        #expect(outbox.pending.map(\.candidateId) == ["c2"])
    }
}
