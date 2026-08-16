/// One thing the group can swipe on. Restaurants today; dishes, drinks,
/// travel spots tomorrow — behind the same type.
///
/// INVARIANT 1: the engine never knows the content. `metadata` is opaque
/// here — the engine must never read it, index into it, or branch on it.
/// Its only readers are the `CandidateProvider` that wrote it and the card
/// view that renders it; both sides of that pair know the schema they
/// agreed on. If you find yourself writing `metadata["cuisine"]` anywhere
/// inside HuddleCore, stop: that logic belongs in a provider.
///
/// `[String: String]` is a deliberate two-way door: it gets Codable for
/// free and keeps this module free of type-erasure machinery. Providers
/// stringify (`"4.5"`, `"800"`), renderers parse back. If that ever hurts,
/// swapping to a typed wrapper is a mechanical change.
public struct Candidate: Codable, Sendable, Hashable, Identifiable {
    /// Server-assigned in later phases, so String rather than UUID.
    public let id: String
    public let title: String
    public let metadata: [String: String]

    public init(id: String, title: String, metadata: [String: String] = [:]) {
        self.id = id
        self.title = title
        self.metadata = metadata
    }
}
