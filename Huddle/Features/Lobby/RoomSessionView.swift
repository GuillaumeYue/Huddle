import HuddleCore
import SwiftUI

/// One screen for the whole room session, morphing with server state:
/// LOBBY shows the approval gate, ACTIVE shows the shared deck. The UI
/// is a function of the authoritative room snapshot — no client-side
/// navigation decides what phase we're in, the server does. This also
/// keeps ONE .task (and therefore one socket) alive across the whole
/// session; pushing the deck on top of the lobby would cancel the
/// covered view's task and kill the connection mid-game.
struct RoomSessionView: View {
    @Environment(\.dismiss) private var dismiss
    @State var viewModel: RoomSessionViewModel

    var body: some View {
        Group {
            if viewModel.isActive, let deck = viewModel.deck {
                playStage(deck: deck)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            } else {
                lobbyStage
                    .transition(.opacity)
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85),
                   value: viewModel.isActive)
        .background(Color(.systemBackground))
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.listenWhileVisible() }
        .onChange(of: viewModel.wasRemoved) { _, removed in
            if removed { dismiss() }
        }
        .onChange(of: viewModel.hasEnded) { _, ended in
            // Host closed the room; guests leave quietly (the host
            // dismisses via their own button path).
            if ended { dismiss() }
        }
    }

    // MARK: ACTIVE — the shared deck

    private func playStage(deck: [Candidate]) -> some View {
        VStack(spacing: 0) {
            othersProgress
            SwipeDeckView(
                provider: RoomDeckProvider(deck: deck),
                deckSize: deck.count,
                allowsRestart: false,
                onDecision: { candidate, decision in
                    viewModel.sendSwipe(candidate: candidate, decision: decision)
                }
            )
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    /// The live payoff: everyone else's progress through the same deck.
    @ViewBuilder
    private var othersProgress: some View {
        let others = viewModel.room.participants.filter { $0.userId != viewModel.myUserId }
        if !others.isEmpty {
            HStack(spacing: 14) {
                ForEach(others) { participant in
                    HStack(spacing: 5) {
                        Text(participant.displayName)
                            .font(.system(.caption, design: .rounded, weight: .semibold))
                        Text("\(viewModel.progressByUser[participant.userId] ?? 0)/\(viewModel.deck?.count ?? 0)")
                            .font(.system(.caption, design: .rounded, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .contentTransition(.numericText())
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color(.secondarySystemBackground), in: Capsule())
                }
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .animation(.snappy, value: viewModel.progressByUser)
        }
    }

    // MARK: LOBBY — the approval gate

    private var lobbyStage: some View {
        VStack(spacing: 24) {
            codeCard
            roster
            Spacer()
            controls
        }
        .padding(24)
        .navigationTitle("Lobby")
        .navigationBarBackButtonHidden(true)
    }

    private var codeCard: some View {
        VStack(spacing: 6) {
            Text("SHARE THIS CODE")
                .font(.system(.caption2, design: .rounded, weight: .bold))
                .kerning(1.5)
                .foregroundStyle(.secondary)
            Text(viewModel.room.joinCode)
                .font(.system(size: 44, weight: .black, design: .monospaced))
                .kerning(6)
                .contentTransition(.identity)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .background(Color(.secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var roster: some View {
        VStack(spacing: 10) {
            ForEach(viewModel.room.participants) { participant in
                HStack(spacing: 12) {
                    Circle()
                        .fill(Color(.systemGreen))
                        .frame(width: 8, height: 8)
                    Text(participant.displayName)
                        .font(.system(.body, design: .rounded, weight: .semibold))
                    if participant.isHost {
                        Image(systemName: "crown.fill")
                            .font(.caption)
                            .foregroundStyle(Color(.systemYellow))
                    }
                    Spacer()
                    if viewModel.isHost && !participant.isHost {
                        Button("Kick") {
                            Task { await viewModel.kick(participant.userId) }
                        }
                        .font(.system(.footnote, design: .rounded, weight: .semibold))
                        .foregroundStyle(Color(.systemRed))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(Color(.secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.85),
                   value: viewModel.room.participants)
    }

    @ViewBuilder
    private var controls: some View {
        if let message = viewModel.errorMessage {
            Text(message)
                .font(.system(.footnote, design: .rounded))
                .foregroundStyle(Color(.systemRed))
        }
        if viewModel.isHost {
            Button {
                Task { await viewModel.start() }
            } label: {
                Text("Start swiping")
                    .font(.system(.headline, design: .rounded))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color.primary, in: Capsule())
                    .foregroundStyle(Color(.systemBackground))
            }
            Button("Close room") {
                Task {
                    await viewModel.close()
                    dismiss()
                }
            }
            .font(.system(.subheadline, design: .rounded, weight: .semibold))
            .foregroundStyle(Color(.systemRed))
        } else {
            Text("Waiting for the host to start…")
                .font(.system(.subheadline, design: .rounded))
                .foregroundStyle(.secondary)
            Button("Leave") { dismiss() }
                .font(.system(.subheadline, design: .rounded, weight: .semibold))
                .foregroundStyle(.secondary)
        }
    }
}

/// Adapter: the server's shared deck exposed through the engine's
/// provider socket. Content still enters the engine only as opaque
/// Candidates — the wall stands, the source just moved server-side.
struct RoomDeckProvider: CandidateProvider {
    let deck: [Candidate]

    func fetchCandidates(count: Int) async throws -> [Candidate] {
        Array(deck.prefix(count))
    }
}
