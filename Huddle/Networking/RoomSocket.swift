import Foundation

/// The live channel for one room — the client end of live.ts.
///
/// `connect` returns a Connection: a stream of decoded downlink events
/// plus an uplink `send`. One Connection == one session == one seq
/// scope; dropping the stream (task cancellation) tears the socket down.
struct RoomSocket: Sendable {

    /// ws:// for the dev server; localhost is ATS-exempt like http://.
    var baseURL = URL(string: "ws://localhost:3000")!

    final class Connection: Sendable {
        private let task: URLSessionWebSocketTask
        let events: AsyncThrowingStream<LiveEventDTO, Error>

        fileprivate init(url: URL) {
            let task = URLSession.shared.webSocketTask(with: url)
            self.task = task
            task.resume()

            events = AsyncThrowingStream { continuation in
                let receiveLoop = Task {
                    do {
                        while !Task.isCancelled {
                            let message = try await task.receive()
                            guard case .string(let text) = message else { continue }
                            // Tolerant receiver: a frame that doesn't decode
                            // is dropped, not fatal — one malformed message
                            // must not kill a healthy connection.
                            if let event = try? JSONDecoder().decode(
                                LiveEventDTO.self, from: Data(text.utf8)) {
                                continuation.yield(event)
                            }
                        }
                        continuation.finish()
                    } catch {
                        // Server hung up (kick / room end) or transport
                        // died; the consumer decides whether to reconnect.
                        continuation.finish(throwing: error)
                    }
                }
                continuation.onTermination = { _ in
                    receiveLoop.cancel()
                    task.cancel(with: .goingAway, reason: nil)
                }
            }
        }

        /// Uplink. Throws if the socket is down — the caller owns the
        /// retry/queue policy (see RoomSessionViewModel.sendSwipe).
        func send(_ swipe: SwipeEventDTO) async throws {
            let data = try JSONEncoder().encode(swipe)
            try await task.send(.string(String(decoding: data, as: UTF8.self)))
        }
    }

    func connect(roomId: String, userId: String) -> Connection {
        let url = baseURL
            .appending(path: "/rooms/\(roomId)/live")
            .appending(queryItems: [URLQueryItem(name: "userId", value: userId)])
        return Connection(url: url)
    }
}
