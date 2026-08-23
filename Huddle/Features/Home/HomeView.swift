import HuddleCore
import SwiftUI

/// The front door. In v1's final shape this is where "create a room" and
/// "join with code" live; until the backend exists (phase 2) the room
/// entrance is visible but locked, and the primary CTA runs the local
/// solo deck. When rooms arrive, only the button's action changes — the
/// navigation skeleton stays.
struct HomeView: View {
    /// Dev identity for the whole app; SIWA replaces its register path.
    @State private var session = UserSession(api: HuddleAPIClient())
    private let api = HuddleAPIClient()
    /// A room we were in when the process died, re-fetched and re-entered.
    @State private var resumedRoom: RoomDTO?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Spacer()
                cardFan
                    .padding(.bottom, 40)
                logotype
                Spacer()
                actions
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
            .background(Color(.systemBackground))
            .navigationDestination(item: $resumedRoom) { room in
                RoomSessionView(viewModel: RoomSessionViewModel(
                    room: room, api: api, myUserId: session.userId ?? ""))
            }
            .task { await resumeIfNeeded() }
        }
        .environment(session)
    }

    /// Walk back into an unfinished room after a process death. The
    /// server is the source of truth: we only ask whether the room still
    /// lists us and is still in play. Finished rooms are forgotten
    /// quietly — the live session already shows verdicts to anyone who
    /// merely backgrounded; a stale result page days later is noise.
    private func resumeIfNeeded() async {
        guard let roomId = session.currentRoomId, let me = session.userId else { return }
        do {
            let room = try await api.room(id: roomId)
            let stillIn = room.participants.contains { $0.userId == me }
            if stillIn && !room.state.isTerminal {
                resumedRoom = room
            } else {
                session.forgetRoom()
            }
        } catch {
            // Unreachable server or vanished room: keep the breadcrumb
            // for the next launch rather than guessing.
        }
    }

    // MARK: Decorative card fan

    /// Three miniature cards fanned like a hand — the product in one image.
    private var cardFan: some View {
        ZStack {
            fanCard(colors: [Color(red: 0.66, green: 0.77, blue: 0.99),
                             Color(red: 0.37, green: 0.49, blue: 0.89)],
                    angle: -12, offset: CGSize(width: -56, height: 10))
            fanCard(colors: [Color(red: 0.83, green: 0.99, blue: 0.47),
                             Color(red: 0.22, green: 0.70, blue: 0.67)],
                    angle: 12, offset: CGSize(width: 56, height: 10))
            fanCard(colors: [Color(red: 1.00, green: 0.66, blue: 0.62),
                             Color(red: 1.00, green: 0.44, blue: 0.60)],
                    angle: 0, offset: .zero)
        }
    }

    private func fanCard(colors: [Color], angle: Double, offset: CGSize) -> some View {
        RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(LinearGradient(colors: colors,
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: 92, height: 128)
            .overlay(alignment: .bottomLeading) {
                Image(systemName: "heart.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(10)
            }
            .shadow(color: .black.opacity(0.14), radius: 10, y: 6)
            .rotationEffect(.degrees(angle), anchor: .bottom)
            .offset(offset)
    }

    // MARK: Logotype

    private var logotype: some View {
        VStack(spacing: 10) {
            Text("Huddle")
                .font(.system(size: 44, weight: .heavy, design: .rounded))
            Text("Swipe together. Decide fast.")
                .font(.system(.body, design: .rounded))
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Actions

    private var actions: some View {
        VStack(spacing: 14) {
            NavigationLink {
                RoomEntryView()
            } label: {
                Text("Create or join a room")
                    .font(.system(.headline, design: .rounded))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color.primary, in: Capsule())
                    .foregroundStyle(Color(.systemBackground))
            }

            NavigationLink {
                SwipeDeckView(provider: MockRestaurantProvider())
            } label: {
                Text("Practice solo")
                    .font(.system(.headline, design: .rounded))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color(.secondarySystemBackground), in: Capsule())
                    .foregroundStyle(Color.primary)
            }
        }
    }
}

#Preview {
    HomeView()
}
