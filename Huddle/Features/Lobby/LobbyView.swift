import SwiftUI

/// The approval gate, live. Shows the code to read out loud, the roster
/// as the server sees it (pushed over the room socket), and host
/// controls. When the server says ACTIVE, everyone here — host and
/// guests alike — moves to the deck, because the *server* moved, not
/// because a button did.
struct LobbyView: View {
    @Environment(\.dismiss) private var dismiss
    @State var viewModel: LobbyViewModel
    @State private var deckPresented = false

    var body: some View {
        VStack(spacing: 24) {
            codeCard
            roster
            Spacer()
            controls
        }
        .padding(24)
        .background(Color(.systemBackground))
        .navigationTitle("Lobby")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .task { await viewModel.listenWhileVisible() }
        .onChange(of: viewModel.isActive) { _, started in
            if started { deckPresented = true }
        }
        .onChange(of: viewModel.wasRemoved) { _, removed in
            if removed { dismiss() }
        }
        .onChange(of: viewModel.hasEnded) { _, ended in
            // Host closed the room: guests leave quietly (host dismisses
            // via their own button path).
            if ended && !deckPresented { dismiss() }
        }
        .navigationDestination(isPresented: $deckPresented) {
            // Phase-2 seam: the deck is still the local mock. Phase 3
            // replaces the provider with the server's shared deck; this
            // navigation stays exactly as is.
            SwipeDeckView(provider: MockRestaurantProvider())
        }
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
