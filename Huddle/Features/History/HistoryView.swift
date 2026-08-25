import SwiftUI

/// Where the table has been: finished rooms, newest first. The seed of
/// the future "re-invite the usual crew" — the people are all in here.
struct HistoryView: View {
    @Environment(UserSession.self) private var session
    private let api = HuddleAPIClient()

    @State private var rooms: [HistoryRoomDTO] = []
    @State private var loaded = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let errorMessage {
                ContentUnavailableView {
                    Label("Couldn't load history", systemImage: "wifi.exclamationmark")
                } description: { Text(errorMessage) }
            } else if loaded && rooms.isEmpty {
                ContentUnavailableView {
                    Label("No huddles yet", systemImage: "clock")
                } description: {
                    Text("Finished rooms land here — winners and near-misses alike.")
                }
            } else {
                List(rooms) { room in
                    HStack(spacing: 14) {
                        Image(systemName: room.state == .matched
                              ? "checkmark.seal.fill" : "moon.zzz.fill")
                            .font(.system(size: 22))
                            .foregroundStyle(room.state == .matched
                                             ? Color(.systemGreen) : .secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(room.resultTitle ?? "No match")
                                .font(.system(.body, design: .rounded, weight: .semibold))
                            Text("\(room.participantCount) at the table · \(Self.display(room.closedAt))")
                                .font(.system(.footnote, design: .rounded))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("History")
        .task {
            guard let userId = session.userId else { loaded = true; return }
            do {
                rooms = try await api.history(userId: userId).rooms
            } catch {
                errorMessage = error.localizedDescription
            }
            loaded = true
        }
    }

    private static func display(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso)
            ?? ISO8601DateFormatter().date(from: iso) else { return "" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
