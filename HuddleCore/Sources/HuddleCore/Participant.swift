/// A person in a room.
///
/// `userId` is non-optional by locked decision: every participant is a
/// registered account (Sign in with Apple), there is no guest mode. This
/// gives reconnect, session history, and recommendation phase 3 a stable
/// primary key, and spares us the guest→account data-merge migration.
public struct Participant: Codable, Sendable, Hashable, Identifiable {
    public let userId: String
    public var displayName: String
    public var isHost: Bool

    public var id: String { userId }

    public init(userId: String, displayName: String, isHost: Bool = false) {
        self.userId = userId
        self.displayName = displayName
        self.isHost = isHost
    }
}
