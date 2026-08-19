import Foundation
import HuddleCore
import Observation

/// One decision made during this session, in order.
struct SwipeRecord: Identifiable, Equatable {
    let candidate: Candidate
    let decision: SwipeDecision
    var id: String { candidate.id }
}

/// Presentation state for one swipe session.
///
/// Phase 1: the deck comes from an injected `CandidateProvider` and
/// decisions stay on-device. In phase 3 this same `history` becomes the
/// outbound event stream (optimistic swipe + reconcile against the
/// server's authoritative state) — which is why decisions are recorded as
/// an ordered list of records, not just a "liked" set.
@MainActor
@Observable
final class DeckViewModel {

    enum Phase: Equatable {
        case loading
        case swiping
        case finished
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    /// Cards still to swipe; index 0 is the top of the stack.
    private(set) var stack: [Candidate] = []
    private(set) var history: [SwipeRecord] = []

    var liked: [Candidate] { history.filter { $0.decision == .yes }.map(\.candidate) }
    var totalCount: Int { history.count + stack.count }
    var completedCount: Int { history.count }
    var progress: Double {
        totalCount == 0 ? 0 : Double(completedCount) / Double(totalCount)
    }

    private let provider: any CandidateProvider
    private let deckSize: Int
    /// Group sessions hook here to ship each verdict to the server the
    /// moment it's committed locally. nil in solo practice.
    private let onDecision: ((Candidate, SwipeDecision) -> Void)?

    init(provider: any CandidateProvider, deckSize: Int = 10,
         onDecision: ((Candidate, SwipeDecision) -> Void)? = nil) {
        self.provider = provider
        self.deckSize = deckSize
        self.onDecision = onDecision
    }

    func loadDeck() async {
        phase = .loading
        history = []
        do {
            stack = try await provider.fetchCandidates(count: deckSize)
            phase = stack.isEmpty ? .finished : .swiping
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Commit the top card. The view calls this *after* the fly-off
    /// animation completes, so state mutation and animation never race.
    /// The `candidate` parameter guards against double-fire: a stale call
    /// for a card that is no longer on top is ignored, not misapplied.
    func commit(_ decision: SwipeDecision, for candidate: Candidate) {
        guard phase == .swiping, stack.first?.id == candidate.id else { return }
        history.append(SwipeRecord(candidate: candidate, decision: decision))
        stack.removeFirst()
        if stack.isEmpty { phase = .finished }
        onDecision?(candidate, decision)
    }
}
