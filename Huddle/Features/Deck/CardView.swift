import HuddleCore
import SwiftUI

/// The face of one candidate card.
///
/// This view is the other end of the metadata contract written by
/// `MockRestaurantProvider` — it knows the restaurant keys (cuisine,
/// priceLevel, rating, distanceMeters). That knowledge is allowed here
/// and in providers, never inside HuddleCore.
///
/// The backdrop: the real photo when the provider resolved one
/// (metadata "photoUrl", a keyless public link — the API key never
/// reaches this app), with the deterministic mesh gradient as loading
/// placeholder and no-photo fallback. Google requires crediting the
/// photographer ("photoAttribution") — the tiny caption is a term of
/// service, not decoration.
struct CardView: View {
    let candidate: Candidate

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            backdrop
            photoLayer
            scrim
            info
        }
        .overlay(alignment: .topTrailing) {
            if let credit = candidate.metadata["photoAttribution"],
               candidate.metadata["photoUrl"] != nil {
                Text("Photo: \(credit)")
                    .font(.system(size: 9, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.75))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.black.opacity(0.25), in: Capsule())
                    .padding(10)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .shadow(color: .black.opacity(0.16), radius: 20, y: 12)
    }

    // MARK: Backdrop

    @ViewBuilder
    private var photoLayer: some View {
        if let url = candidate.metadata["photoUrl"].flatMap(URL.init(string:)) {
            GeometryReader { geo in
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image
                            .resizable()
                            .scaledToFill()
                            .frame(width: geo.size.width, height: geo.size.height)
                            .clipped()
                            .transition(.opacity)
                    }
                }
                .animation(.easeIn(duration: 0.25), value: url)
            }
        }
    }

    private var backdrop: some View {
        let p = Palette.for(candidate.id)
        return MeshGradient(
            width: 3, height: 3,
            points: [
                [0.0, 0.0], [0.5, 0.0], [1.0, 0.0],
                [0.0, 0.5], [0.6, 0.4], [1.0, 0.5],
                [0.0, 1.0], [0.5, 1.0], [1.0, 1.0],
            ],
            colors: [
                p.light, p.mid, p.light,
                p.mid, p.deep, p.mid,
                p.deep, p.mid, p.deep,
            ]
        )
        .overlay {
            // Soft glow spots — the "shot through a window at golden hour"
            // texture that flat gradients lack.
            GeometryReader { geo in
                Circle()
                    .fill(.white.opacity(0.28))
                    .frame(width: geo.size.width * 0.7)
                    .blur(radius: 60)
                    .offset(x: geo.size.width * 0.45, y: -geo.size.width * 0.15)
                Circle()
                    .fill(p.light.opacity(0.5))
                    .frame(width: geo.size.width * 0.5)
                    .blur(radius: 50)
                    .offset(x: -geo.size.width * 0.15, y: geo.size.height * 0.55)
            }
        }
    }

    private var scrim: some View {
        LinearGradient(
            colors: [.clear, .black.opacity(0.05), .black.opacity(0.48)],
            startPoint: .center, endPoint: .bottom
        )
    }

    // MARK: Info

    private var info: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let rating = candidate.metadata["rating"] {
                Label(rating, systemImage: "star.fill")
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .labelStyle(.titleAndIcon)
                    .chipStyle()
            }
            Text(candidate.title)
                .font(.system(.largeTitle, design: .rounded, weight: .heavy))
                .foregroundStyle(.white)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .shadow(color: .black.opacity(0.25), radius: 8, y: 2)

            HStack(spacing: 8) {
                if let cuisine = candidate.metadata["cuisine"] {
                    Text(cuisine).chipStyle()
                }
                if let price = priceText {
                    Text(price).chipStyle()
                }
                if let distance = distanceText {
                    Label(distance, systemImage: "figure.walk").chipStyle()
                }
            }
            .font(.system(.footnote, design: .rounded, weight: .medium))
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var priceText: String? {
        candidate.metadata["priceLevel"]
            .flatMap(Int.init)
            .map { String(repeating: "$", count: max(1, min($0, 4))) }
    }

    private var distanceText: String? {
        guard let meters = candidate.metadata["distanceMeters"].flatMap(Int.init)
        else { return nil }
        return meters < 1000
            ? "\(meters) m"
            : String(format: "%.1f km", Double(meters) / 1000)
    }
}

// MARK: - Palette

/// Deterministic pastel palette per candidate.
///
/// Note the hand-rolled FNV-1a: Swift's `hashValue` is seeded per launch
/// (deliberately, against hash-flooding), so it would repaint every card
/// on every run. Stable identity needs a stable hash.
private struct Palette {
    let light: Color
    let mid: Color
    let deep: Color

    static func `for`(_ id: String) -> Palette {
        all[Int(FNV1a.hash(id) % UInt64(all.count))]
    }

    private static let all: [Palette] = [
        Palette(light: Color(0xFFE29F), mid: Color(0xFFA99F), deep: Color(0xFF719A)), // sunset
        Palette(light: Color(0xFBC2EB), mid: Color(0xA18CD1), deep: Color(0x7367F0)), // lavender
        Palette(light: Color(0xA8EDEA), mid: Color(0x7EC8E3), deep: Color(0x5B8DEF)), // ocean
        Palette(light: Color(0xD4FC79), mid: Color(0x96E6A1), deep: Color(0x38B2AC)), // matcha
        Palette(light: Color(0xFFECD2), mid: Color(0xFCB69F), deep: Color(0xE8836B)), // peach
        Palette(light: Color(0xFF9A9E), mid: Color(0xFF758C), deep: Color(0xD5476E)), // berry
        Palette(light: Color(0xE0C3FC), mid: Color(0x8EC5FC), deep: Color(0x5E7CE2)), // periwinkle
        Palette(light: Color(0xF6D365), mid: Color(0xFDA085), deep: Color(0xF2707C)), // mango
    ]
}

private extension Color {
    init(_ hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

private extension View {
    func chipStyle() -> some View {
        self
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.white.opacity(0.18), in: Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.25), lineWidth: 0.5))
    }
}

#Preview {
    CardView(candidate: Candidate(
        id: "mock-001",
        title: "Sichuan Palace",
        metadata: [
            "cuisine": "Sichuan", "priceLevel": "2",
            "rating": "4.5", "distanceMeters": "800",
        ]
    ))
    .padding(24)
    .aspectRatio(3 / 4.2, contentMode: .fit)
}
