import Foundation

/// The only file in the app that knows how to talk to the backend —
/// the mirror of backend/src/db.ts (the only file that knows Postgres).
/// Views and view models depend on this type, never on URLSession.
struct HuddleAPIClient: Sendable {

    /// Simulator shares the Mac's network, so localhost reaches the dev
    /// server (ATS-exempt); Release builds point at the deployed origin.
    var baseURL = APIConfig.httpBase

    enum APIError: Error, LocalizedError {
        /// The bytes never made it (offline, refused, timeout).
        case transport(underlying: Error)
        /// The server answered with a non-2xx verdict.
        case server(status: Int, message: String)
        /// 2xx bytes arrived but don't match the DTO — the treaty drifted
        /// (or a proxy served us HTML). Loud on purpose: this error means
        /// a protocol bug, not a user problem.
        case decoding(underlying: Error)

        var errorDescription: String? {
            switch self {
            case .transport: "Can't reach the server"
            case .server(_, let message): message
            case .decoding: "Unexpected server response"
            }
        }
    }

    // MARK: Endpoints

    func createUser(displayName: String) async throws -> UserDTO {
        try await post("/dev/users", CreateUserBody(displayName: displayName))
    }

    func createRoom(hostId: String) async throws -> RoomDTO {
        try await post("/rooms", CreateRoomBody(hostId: hostId))
    }

    func joinRoom(code: String, userId: String) async throws -> RoomDTO {
        try await post("/rooms/join", JoinRoomBody(code: code, userId: userId))
    }

    func room(id: String) async throws -> RoomDTO {
        try await get("/rooms/\(id)")
    }

    func startRoom(id: String, userId: String) async throws -> RoomDTO {
        try await post("/rooms/\(id)/start", StartRoomBody(userId: userId))
    }

    func closeRoom(id: String, userId: String) async throws -> RoomDTO {
        try await post("/rooms/\(id)/close", CloseRoomBody(userId: userId))
    }

    /// The blind pick. 409 means someone at the table tapped first —
    /// the socket delivers their verdict; the caller just stops.
    func pick(roomId: String, userId: String, candidateId: String) async throws -> RoomDTO {
        try await post("/rooms/\(roomId)/pick",
                       PickBody(userId: userId, candidateId: candidateId))
    }

    func history(userId: String) async throws -> HistoryDTO {
        try await get("/users/\(userId)/history")
    }

    /// Account deletion (anonymization server-side). 204, no body.
    func deleteAccount(userId: String) async throws {
        var request = URLRequest(url: baseURL.appending(path: "/users/\(userId)"))
        request.httpMethod = "DELETE"
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode(ServerErrorDTO.self, from: data))?.error
                ?? "Server error (\(status))"
            throw APIError.server(status: status, message: message)
        }
    }

    func kick(roomId: String, hostId: String, targetUserId: String) async throws -> RoomDTO {
        try await post("/rooms/\(roomId)/kick",
                       KickBody(hostId: hostId, targetUserId: targetUserId))
    }

    // MARK: Plumbing

    private func get<R: Decodable>(_ path: String) async throws -> R {
        try await send(URLRequest(url: baseURL.appending(path: path)))
    }

    private func post<B: Encodable, R: Decodable>(_ path: String, _ body: B) async throws -> R {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await send(request)
    }

    private func send<R: Decodable>(_ request: URLRequest) async throws -> R {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.transport(underlying: error)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            // The backend always ships { "error": "..." }; if even that
            // fails to parse we still produce a usable message.
            let message = (try? JSONDecoder().decode(ServerErrorDTO.self, from: data))?.error
                ?? "Server error (\(status))"
            throw APIError.server(status: status, message: message)
        }

        do {
            return try JSONDecoder().decode(R.self, from: data)
        } catch {
            throw APIError.decoding(underlying: error)
        }
    }
}
