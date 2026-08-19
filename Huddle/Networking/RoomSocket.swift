import Foundation

/// The server-push channel for one room — the receiving end of live.ts.
///
/// Exposes the socket as an AsyncThrowingStream of decoded events: the
/// consumer just `for try await`s, and cancellation (leaving the view)
/// tears the connection down via onTermination. One stream == one
/// connection session == one seq scope.
struct RoomSocket: Sendable {

    /// ws:// for the dev server; localhost is ATS-exempt like http://.
    var baseURL = URL(string: "ws://localhost:3000")!

    func events(roomId: String, userId: String) -> AsyncThrowingStream<LiveEventDTO, Error> {
        let url = baseURL
            .appending(path: "/rooms/\(roomId)/live")
            .appending(queryItems: [URLQueryItem(name: "userId", value: userId)])

        return AsyncThrowingStream { continuation in
            let task = URLSession.shared.webSocketTask(with: url)
            task.resume()

            let receiveLoop = Task {
                do {
                    while !Task.isCancelled {
                        let message = try await task.receive()
                        guard case .string(let text) = message else { continue }
                        // Tolerant receiver: bytes that don't decode as an
                        // envelope are dropped, not fatal — one malformed
                        // frame must not kill a healthy connection.
                        if let event = try? JSONDecoder().decode(
                            LiveEventDTO.self, from: Data(text.utf8)) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    // Server closed us (kick/room end) or transport died;
                    // the consumer decides whether to reconnect.
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                receiveLoop.cancel()
                task.cancel(with: .goingAway, reason: nil)
            }
        }
    }
}
