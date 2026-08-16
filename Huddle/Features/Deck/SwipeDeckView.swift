import HuddleCore
import SwiftUI

/// The swipe stage: card stack, drag physics, verdict badges, action
/// buttons, progress, and the finished summary.
///
/// Animation timing rules used throughout:
/// - Everything is a spring. Fixed-duration curves read as mechanical;
///   springs read as physical.
/// - State mutation (popping the card) happens in the animation
///   *completion*, never on a timer guess — so model and motion cannot
///   drift out of sync.
struct SwipeDeckView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel: DeckViewModel

    /// Live translation of the card being dragged. Keyed to a specific
    /// card via `draggedID`, never to "whoever is on top": roles change
    /// hands mid-animation (the next card is promoted while the old one's
    /// offset is still live), and a promoted card must not inherit its
    /// predecessor's offset. Binding state to identity instead of role is
    /// what makes the ghost-card glitch unrepresentable.
    @State private var drag: CGSize = .zero
    @State private var draggedID: Candidate.ID?
    /// True while a card is flying off; gates gestures and buttons so a
    /// fast second input cannot double-commit.
    @State private var isAnimatingOut = false
    /// Whether the drag currently crosses the commit threshold — drives a
    /// selection haptic exactly on the boundary, both directions.
    @State private var isPastThreshold = false

    /// Horizontal travel needed to commit. Predicted (flick) travel counts
    /// at 1.8×, so a quick confident flick works without dragging far.
    private let commitThreshold: CGFloat = 120

    init(provider: any CandidateProvider) {
        _viewModel = State(initialValue: DeckViewModel(provider: provider))
    }

    var body: some View {
        VStack(spacing: 20) {
            header
            stage
            actionButtons
                .opacity(viewModel.phase == .swiping ? 1 : 0)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 24)
        .background(Color(.systemBackground))
        .toolbar(.hidden, for: .navigationBar)
        .task { await viewModel.loadDeck() }
        .sensoryFeedback(.selection, trigger: isPastThreshold)
        .sensoryFeedback(.impact(weight: .light), trigger: viewModel.completedCount)
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: viewModel.phase)
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: 12) {
            HStack(alignment: .center) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 36, height: 36)
                        .background(Color(.secondarySystemBackground), in: Circle())
                }
                .accessibilityLabel("Close")
                Spacer()
                if viewModel.phase == .swiping {
                    Text("\(min(viewModel.completedCount + 1, viewModel.totalCount)) / \(viewModel.totalCount)")
                        .font(.system(.subheadline, design: .rounded, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                        .animation(.snappy, value: viewModel.completedCount)
                }
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule()
                        .fill(.primary)
                        .frame(width: geo.size.width * viewModel.progress)
                        .animation(.spring(response: 0.5, dampingFraction: 0.9),
                                   value: viewModel.progress)
                }
            }
            .frame(height: 4)
        }
        .padding(.top, 8)
    }

    // MARK: Stage

    @ViewBuilder
    private var stage: some View {
        GeometryReader { geo in
            ZStack {
                switch viewModel.phase {
                case .loading:
                    ProgressView().controlSize(.large)
                case .failed(let message):
                    failedView(message)
                case .finished:
                    FinishedView(liked: viewModel.liked, total: viewModel.totalCount) {
                        Task { await viewModel.loadDeck() }
                    }
                    .transition(.opacity.combined(with: .scale(scale: 0.94)))
                case .swiping:
                    cardStack(in: geo.size)
                        .transition(.opacity)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    private func cardStack(in size: CGSize) -> some View {
        // Top 3 cards only: rendering the whole deck is invisible work.
        // reversed() puts the top card last in the ZStack (frontmost).
        ZStack {
            ForEach(Array(viewModel.stack.prefix(3).enumerated()).reversed(),
                    id: \.element.id) { depth, candidate in
                let isTop = depth == 0
                // Identity, not role: only the card that owns the drag
                // wears the offset/rotation/badges. A card promoted to the
                // top mid-animation can never inherit stale drag state.
                let isDragged = candidate.id == draggedID
                CardView(candidate: candidate)
                    .overlay { if isDragged { verdictBadges } }
                    // Depth stagger: each card behind shrinks and sinks a
                    // touch. Promotion animates via the withAnimation
                    // wrapping commit() — the single animation authority.
                    .scaleEffect(isTop ? 1 : 1 - 0.045 * CGFloat(depth))
                    .offset(y: isTop ? 0 : CGFloat(depth) * 14)
                    .offset(isDragged ? drag : .zero)
                    // Pendulum feel: rotate around the bottom edge, driven
                    // by horizontal travel only.
                    .rotationEffect(
                        .degrees(isDragged ? Double(drag.width / 22).clamped(to: -12...12) : 0),
                        anchor: .bottom
                    )
                    // Removal is instant: the committed card is already
                    // off-screen, and a default opacity fade would keep a
                    // ghost copy alive for the length of the promotion
                    // spring. Insertion fades in at the back of the stack.
                    .transition(.asymmetric(insertion: .opacity, removal: .identity))
                    .gesture(isTop ? dragGesture(for: candidate) : nil)
                    .allowsHitTesting(isTop && !isAnimatingOut)
            }
        }
        .padding(.vertical, 8)
    }

    // MARK: Drag physics

    private func dragGesture(for candidate: Candidate) -> some Gesture {
        DragGesture()
            .onChanged { value in
                guard !isAnimatingOut else { return }
                draggedID = candidate.id
                drag = value.translation
                isPastThreshold = abs(value.translation.width) > commitThreshold
            }
            .onEnded { value in
                guard !isAnimatingOut else { return }
                let travel = value.translation.width
                // A flick is a commit even if the finger didn't travel far:
                // trust where the gesture was *going*, not just where it is.
                let predicted = value.predictedEndTranslation.width
                let decisive = abs(travel) > commitThreshold
                    ? travel
                    : (abs(predicted) > commitThreshold * 1.8 ? predicted : 0)

                if decisive != 0 {
                    performSwipe(decisive > 0 ? .yes : .no)
                } else {
                    // Snap back with a lively spring — the "no" that
                    // still feels good. draggedID is released only when
                    // the spring lands, so the offset stays owned while
                    // it is still animating home.
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.65)) {
                        drag = .zero
                    } completion: {
                        draggedID = nil
                    }
                    isPastThreshold = false
                }
            }
    }

    /// Single commit path — the buttons and the gesture both land here, so
    /// the fly-off motion is identical no matter how the verdict was cast.
    private func performSwipe(_ decision: SwipeDecision) {
        guard let top = viewModel.stack.first, !isAnimatingOut else { return }
        isAnimatingOut = true
        // Button-initiated swipes never started a drag, so the top card
        // adopts the offset ownership here before any motion begins.
        draggedID = top.id
        let direction: CGFloat = decision == .yes ? 1 : -1

        withAnimation(.easeOut(duration: 0.3)) {
            drag = CGSize(
                width: direction * 640,
                // Keep whatever vertical drift the drag had, plus a touch
                // more — a dead-horizontal exit looks robotic.
                height: drag.height + 40
            )
        } completion: {
            // Mutate the model only now: the card is off-screen, so the
            // pop + promotion spring can't visually fight the fly-off.
            //
            // Render-order note: commit and the drag reset below may land
            // in different transactions — there is no single-frame
            // guarantee. That is exactly why the offset is keyed to
            // draggedID: even if a frame renders between these mutations,
            // the promoted card doesn't match draggedID and renders in
            // place, not wearing this card's stale off-screen offset.
            withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
                viewModel.commit(decision, for: top)
            }
            drag = .zero
            draggedID = nil
            isPastThreshold = false
            isAnimatingOut = false
        }
    }

    // MARK: Verdict badges

    /// LIKE / PASS stamps that fade in with drag progress.
    private var verdictBadges: some View {
        let progress = Double((abs(drag.width) / commitThreshold).clamped(to: 0...1))
        return ZStack {
            badge("LIKE", color: .green, angle: -14)
                .frame(maxWidth: .infinity, maxHeight: .infinity,
                       alignment: .topLeading)
                .opacity(drag.width > 0 ? progress : 0)
            badge("PASS", color: .red, angle: 14)
                .frame(maxWidth: .infinity, maxHeight: .infinity,
                       alignment: .topTrailing)
                .opacity(drag.width < 0 ? progress : 0)
        }
        .padding(28)
    }

    private func badge(_ text: String, color: Color, angle: Double) -> some View {
        Text(text)
            .font(.system(.title2, design: .rounded, weight: .black))
            .kerning(2)
            .foregroundStyle(color)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(color, lineWidth: 3.5))
            .rotationEffect(.degrees(angle))
    }

    // MARK: Action buttons

    private var actionButtons: some View {
        HStack(spacing: 44) {
            circleButton("xmark", tint: Color(.systemRed)) { performSwipe(.no) }
                .accessibilityLabel("Pass")
            circleButton("heart.fill", tint: Color(.systemPink)) { performSwipe(.yes) }
                .accessibilityLabel("Like")
        }
        .disabled(isAnimatingOut || viewModel.phase != .swiping)
    }

    private func circleButton(_ symbol: String, tint: Color,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(tint)
                .frame(width: 64, height: 64)
                .background(.background, in: Circle())
                .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
        }
        .buttonStyle(PressableButtonStyle())
    }

    private func failedView(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Couldn't load the deck", systemImage: "wifi.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") { Task { await viewModel.loadDeck() } }
                .buttonStyle(.borderedProminent)
        }
    }
}

// MARK: - Finished summary

private struct FinishedView: View {
    let liked: [Candidate]
    let total: Int
    let restart: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            VStack(spacing: 8) {
                Text(liked.isEmpty ? "Tough crowd" : "Nice picks")
                    .font(.system(.largeTitle, design: .rounded, weight: .heavy))
                Text("You liked \(liked.count) of \(total)")
                    .font(.system(.body, design: .rounded))
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 12)

            if !liked.isEmpty {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 10) {
                        ForEach(liked) { candidate in
                            likedRow(candidate)
                        }
                    }
                }
            } else {
                Spacer()
                Text("Everything got a pass this round.\nFresh deck?")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Spacer()
            }

            Button(action: restart) {
                Text("Swipe again")
                    .font(.system(.headline, design: .rounded))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(.primary, in: Capsule())
                    .foregroundStyle(Color(.systemBackground))
            }
            .buttonStyle(PressableButtonStyle())
        }
    }

    private func likedRow(_ candidate: Candidate) -> some View {
        HStack(spacing: 14) {
            // Mini swatch reuses the card's palette so the summary visually
            // rhymes with the cards just swiped.
            CardView(candidate: candidate)
                .frame(width: 52, height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .allowsHitTesting(false)
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.title)
                    .font(.system(.body, design: .rounded, weight: .semibold))
                Text([candidate.metadata["cuisine"],
                      candidate.metadata["rating"].map { "★ \($0)" }]
                    .compactMap(\.self)
                    .joined(separator: "  ·  "))
                    .font(.system(.footnote, design: .rounded))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "heart.fill")
                .foregroundStyle(Color(.systemPink))
        }
        .padding(12)
        .background(Color(.secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

// MARK: - Helpers

/// Slight shrink on press — cheap, and everything instantly feels tactile.
private struct PressableButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7),
                       value: configuration.isPressed)
    }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

#Preview {
    SwipeDeckView(provider: MockRestaurantProvider())
}
