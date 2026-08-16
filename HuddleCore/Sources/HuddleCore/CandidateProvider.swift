/// The socket in the wall between the engine and any content domain.
///
/// The engine consumes candidates through this protocol and nothing else;
/// everything domain-specific (what a restaurant is, how to talk to Google
/// Places, what goes into `metadata`) lives inside a conforming provider
/// on the *app* side of the module boundary. Adding dishes or travel spots
/// later means writing a new provider — the engine does not change.
///
/// `async throws` from day one: the mock resolves instantly, but the real
/// provider (Google Places, phase 5) is a network call, and retrofitting
/// asynchrony into a synchronous contract breaks every call site.
public protocol CandidateProvider: Sendable {
    /// Fetch a deck of candidates for one round.
    ///
    /// Contract: returns at most `count` candidates, all with unique ids.
    /// A short return (fewer than `count`) is valid — content may run out —
    /// and callers must handle it. An empty return is how "no candidates
    /// available" is expressed; providers should not throw for that case.
    func fetchCandidates(count: Int) async throws -> [Candidate]
}
