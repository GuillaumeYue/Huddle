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
    @Environment(UserSession.self) private var session
    @State var viewModel: RoomSessionViewModel

    /// Every way out of the room goes through here, so the breadcrumb
    /// never outlives the session it points at.
    private func leave() {
        session.forgetRoom()
        dismiss()
    }

    var body: some View {
        Group {
            if viewModel.hasEnded {
                resultStage
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            } else if viewModel.isTallying {
                revealStage
                    .transition(.opacity)
            } else if viewModel.isActive, let deck = viewModel.deck {
                playStage(deck: deck)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            } else {
                lobbyStage
                    .transition(.opacity)
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85),
                   value: viewModel.room.state)
        .background(Color(.systemBackground))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { session.rememberRoom(viewModel.room.id) }
        .task { await viewModel.listenWhileVisible() }
        .onChange(of: viewModel.wasRemoved) { _, removed in
            if removed { leave() }
        }
    }

    // MARK: TALLY / REVEALING — the server's stage, input closed

    @ViewBuilder
    private var revealStage: some View {
        let tied = viewModel.tiedCandidates
        if !tied.isEmpty {
            blindPickStage(tied)
        } else {
            revealBeat
        }
    }

    /// The tie: every card here got everyone's yes. Face-down, tap one —
    /// first tap at the table wins (the server's row decides).
    private func blindPickStage(_ tied: [Candidate]) -> some View {
        VStack(spacing: 18) {
            Spacer(minLength: 8)
            Text("Everyone said yes to \(tied.count)")
                .font(.system(.title2, design: .rounded, weight: .heavy))
            Text("Tap a card to pick blind — first tap at the table wins.")
                .font(.system(.subheadline, design: .rounded))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 12)], spacing: 12) {
                ForEach(tied) { candidate in
                    Button {
                        Task { await viewModel.pick(candidate) }
                    } label: {
                        faceDownCard
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isPicking)
                }
            }
            .padding(.horizontal, 8)
            Spacer()
        }
        .padding(24)
        .toolbar(.hidden, for: .navigationBar)
    }

    private var faceDownCard: some View {
        RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(LinearGradient(colors: [Color(.systemPink), Color(.systemIndigo)],
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            .aspectRatio(3 / 4.2, contentMode: .fit)
            .overlay {
                Text("?")
                    .font(.system(size: 40, weight: .black, design: .rounded))
                    .foregroundStyle(.white.opacity(0.9))
            }
            .shadow(color: .black.opacity(0.14), radius: 10, y: 6)
    }

    private var revealBeat: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "sparkles")
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Color(.systemPink))
                .symbolEffect(.pulse, options: .repeating)
            Text(viewModel.room.state == .tally ? "Counting votes…" : "And the winner is…")
                .font(.system(.title2, design: .rounded, weight: .heavy))
                .contentTransition(.opacity)
            Text("Sit tight — the table decides together.")
                .font(.system(.subheadline, design: .rounded))
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(24)
        .toolbar(.hidden, for: .navigationBar)
    }

    // MARK: MATCHED / NO_RESULT — the outcome

    private var resultStage: some View {
        VStack(spacing: 20) {
            Spacer(minLength: 12)
            if let winner = viewModel.winner {
                Text("It's a match!")
                    .font(.system(.largeTitle, design: .rounded, weight: .heavy))
                CardView(candidate: winner)
                    .aspectRatio(3 / 4.2, contentMode: .fit)
                    .padding(.horizontal, 8)
                tallySummary
            } else {
                Spacer()
                Image(systemName: viewModel.room.state == .matched ? "questionmark" : "moon.zzz.fill")
                    .font(.system(size: 48, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text(viewModel.room.candidates == nil ? "Room closed" : "No match this time")
                    .font(.system(.title, design: .rounded, weight: .heavy))
                Text(viewModel.room.candidates == nil
                     ? "The host ended the room before it started."
                     : "Nothing got everyone's yes. Next time, fresh picks.")
                    .font(.system(.subheadline, design: .rounded))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                tallySummary
                Spacer()
            }
            Button {
                leave()
            } label: {
                Text("Done")
                    .font(.system(.headline, design: .rounded))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color.primary, in: Capsule())
                    .foregroundStyle(Color(.systemBackground))
            }
        }
        .padding(24)
        .toolbar(.hidden, for: .navigationBar)
    }

    /// How the table voted: top candidates, yes out of threshold.
    @ViewBuilder
    private var tallySummary: some View {
        let rows = Array(viewModel.tallyRows.prefix(4))
        if let threshold = viewModel.room.threshold, !rows.isEmpty {
            VStack(spacing: 8) {
                ForEach(rows, id: \.candidate.id) { row in
                    HStack(spacing: 10) {
                        Text(row.candidate.title)
                            .font(.system(.footnote, design: .rounded, weight: .semibold))
                            .lineLimit(1)
                        Spacer()
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(.quaternary)
                                Capsule()
                                    .fill(row.yes >= threshold ? Color(.systemPink) : Color.primary.opacity(0.5))
                                    .frame(width: geo.size.width * CGFloat(row.yes) / CGFloat(max(threshold, 1)))
                            }
                        }
                        .frame(width: 90, height: 6)
                        Text("\(row.yes)/\(threshold)")
                            .font(.system(.caption, design: .rounded, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .frame(width: 34, alignment: .trailing)
                    }
                }
            }
            .padding(.horizontal, 4)
        }
    }

    // MARK: ACTIVE — the shared deck

    private func playStage(deck: [Candidate]) -> some View {
        // Resume where the SERVER says we are: the deck order is frozen,
        // so "cards already recorded for me" == "skip this many from the
        // front". If a few outbox verdicts died with the old process,
        // we simply re-ask those cards; the server's idempotency key
        // keeps the first verdict and the re-swipe costs nothing.
        let alreadyDone = viewModel.progressByUser[viewModel.myUserId] ?? 0
        let remaining = Array(deck.dropFirst(alreadyDone))
        return VStack(spacing: 0) {
            othersProgress
            SwipeDeckView(
                provider: RoomDeckProvider(deck: remaining),
                deckSize: remaining.count,
                allowsRestart: false,
                onDecision: { candidate, decision in
                    viewModel.sendSwipe(candidate: candidate, decision: decision)
                }
            )
            // A new round is a new deck: re-key the view so SwiftUI
            // rebuilds its @State DeckViewModel instead of keeping the
            // finished one on screen.
            .id(viewModel.room.round)
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    /// The live payoff: everyone else's progress through the same deck.
    @ViewBuilder
    private var othersProgress: some View {
        let others = viewModel.room.participants.filter { $0.userId != viewModel.myUserId }
        if !others.isEmpty || viewModel.room.round > 1 {
            HStack(spacing: 14) {
                if viewModel.room.round > 1 {
                    Text("Round \(viewModel.room.round) · fresh picks")
                        .font(.system(.caption, design: .rounded, weight: .bold))
                        .foregroundStyle(Color(.systemPink))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color(.systemPink).opacity(0.12), in: Capsule())
                }
                ForEach(others) { participant in
                    HStack(spacing: 5) {
                        Circle()
                            .fill(ParticipantColor.for(participant.userId))
                            .frame(width: 7, height: 7)
                            .opacity(participant.connected ? 1 : 0.3)
                        Text(viewModel.label(for: participant.userId))
                            .font(.system(.caption, design: .rounded, weight: .semibold))
                            .foregroundStyle(participant.connected ? .primary : .tertiary)
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
                        .fill(ParticipantColor.for(participant.userId))
                        .frame(width: 10, height: 10)
                        .opacity(participant.connected ? 1 : 0.3)
                    Text(viewModel.label(for: participant.userId))
                        .font(.system(.body, design: .rounded, weight: .semibold))
                        .foregroundStyle(participant.connected ? .primary : .secondary)
                    if !participant.connected {
                        Text("offline")
                            .font(.system(.caption2, design: .rounded, weight: .semibold))
                            .foregroundStyle(.tertiary)
                    }
                    if participant.isHost {
                        Image(systemName: "crown.fill")
                            .font(.caption)
                            .foregroundStyle(Color(.systemYellow))
                    }
                    if participant.userId == viewModel.myUserId {
                        // With duplicates on screen, "which one am I" needs
                        // an answer too.
                        Text("you")
                            .font(.system(.caption2, design: .rounded, weight: .bold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Color(.tertiarySystemFill), in: Capsule())
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
                    leave()
                }
            }
            .font(.system(.subheadline, design: .rounded, weight: .semibold))
            .foregroundStyle(Color(.systemRed))
        } else {
            Text("Waiting for the host to start…")
                .font(.system(.subheadline, design: .rounded))
                .foregroundStyle(.secondary)
            Button("Leave") { leave() }
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

/// A stable recognition color per participant — one more channel on top
/// of the name suffix, never the only one (color-blind users, and the
/// palette is finite while numbering isn't).
///
/// Keyed to userId via stable hash, NOT to roster position: a kick must
/// not recolor everyone below (state belongs to identity, not role —
/// the ghost-card lesson, applied to pixels). Trade-off accepted: two
/// people can collide on a color; the suffix disambiguates them.
enum ParticipantColor {
    private static let palette: [Color] = [
        Color(.systemBlue), Color(.systemPink), Color(.systemOrange),
        Color(.systemTeal), Color(.systemPurple), Color(.systemGreen),
        Color(.systemIndigo), Color(.systemBrown),
    ]

    static func `for`(_ userId: String) -> Color {
        palette[Int(FNV1a.hash(userId) % UInt64(palette.count))]
    }
}
