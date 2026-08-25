import Foundation
import Observation

/// Who am I, pre-auth edition.
///
/// Until Sign in with Apple lands, identity is a dev-endpoint user whose
/// id we persist in UserDefaults — so relaunching the app keeps the same
/// userId (rejoin, kick, host rights all depend on stable identity).
/// SIWA replaces the `register` path; the rest of the app only ever sees
/// `userId`/`displayName` and won't change.
@MainActor
@Observable
final class UserSession {
    private(set) var userId: String?
    private(set) var displayName: String?
    /// The room this device is (or was last) in. Persisted so a killed
    /// process can walk back into its game: identity is durable, and
    /// the server kept everything else — this is the one breadcrumb the
    /// client has to keep for itself.
    private(set) var currentRoomId: String?

    private let api: HuddleAPIClient
    private let defaults = UserDefaults.standard

    init(api: HuddleAPIClient) {
        self.api = api
        userId = defaults.string(forKey: "dev.userId")
        displayName = defaults.string(forKey: "dev.displayName")
        currentRoomId = defaults.string(forKey: "session.currentRoomId")
    }

    func rememberRoom(_ roomId: String) {
        currentRoomId = roomId
        defaults.set(roomId, forKey: "session.currentRoomId")
    }

    func forgetRoom() {
        currentRoomId = nil
        defaults.removeObject(forKey: "session.currentRoomId")
    }

    var isRegistered: Bool { userId != nil }

    /// Account deleted: forget everything local. The server has already
    /// anonymized the durable side.
    func wipe() {
        for key in ["dev.userId", "dev.displayName", "session.currentRoomId"] {
            defaults.removeObject(forKey: key)
        }
        userId = nil
        displayName = nil
        currentRoomId = nil
    }

    func register(displayName name: String) async throws {
        let user = try await api.createUser(displayName: name)
        defaults.set(user.id, forKey: "dev.userId")
        defaults.set(user.displayName, forKey: "dev.displayName")
        userId = user.id
        displayName = user.displayName
    }
}
