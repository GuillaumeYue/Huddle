import HuddleCore

/// Phase-1 stand-in for the Google Places provider (phase 5).
///
/// This file is the *only* place (besides the card view) that knows what a
/// restaurant is. The metadata keys used here are a rehearsal for the real
/// Places schema — when the real provider lands, the card view should not
/// have to change.
///
/// Metadata schema (provider ↔ card view contract):
///   cuisine        — human-readable label, e.g. "Sichuan"
///   priceLevel     — "1"..."4", rendered as ¥...¥¥¥¥
///   rating         — "0.0"..."5.0"
///   distanceMeters — integer string, rendered as "800 m" / "1.2 km"
struct MockRestaurantProvider: CandidateProvider {

    func fetchCandidates(count: Int) async throws -> [Candidate] {
        Array(Self.sampleRestaurants.prefix(count))
    }

    private static let sampleRestaurants: [Candidate] = [
        Candidate(id: "mock-001", title: "Sichuan Palace", metadata: [
            "cuisine": "Sichuan", "priceLevel": "2",
            "rating": "4.5", "distanceMeters": "800",
        ]),
        Candidate(id: "mock-002", title: "Sakura Sushi Bar", metadata: [
            "cuisine": "Japanese", "priceLevel": "3",
            "rating": "4.7", "distanceMeters": "1200",
        ]),
        Candidate(id: "mock-003", title: "La Piccola Trattoria", metadata: [
            "cuisine": "Italian", "priceLevel": "3",
            "rating": "4.3", "distanceMeters": "650",
        ]),
        Candidate(id: "mock-004", title: "Golden Wok Express", metadata: [
            "cuisine": "Cantonese", "priceLevel": "1",
            "rating": "4.0", "distanceMeters": "300",
        ]),
        Candidate(id: "mock-005", title: "El Fuego Taqueria", metadata: [
            "cuisine": "Mexican", "priceLevel": "2",
            "rating": "4.4", "distanceMeters": "950",
        ]),
        Candidate(id: "mock-006", title: "Punjab Spice House", metadata: [
            "cuisine": "Indian", "priceLevel": "2",
            "rating": "4.6", "distanceMeters": "1500",
        ]),
        Candidate(id: "mock-007", title: "Le Petit Bistro", metadata: [
            "cuisine": "French", "priceLevel": "4",
            "rating": "4.8", "distanceMeters": "2100",
        ]),
        Candidate(id: "mock-008", title: "Seoul Kitchen", metadata: [
            "cuisine": "Korean", "priceLevel": "2",
            "rating": "4.2", "distanceMeters": "700",
        ]),
        Candidate(id: "mock-009", title: "The Burger Joint", metadata: [
            "cuisine": "American", "priceLevel": "1",
            "rating": "3.9", "distanceMeters": "450",
        ]),
        Candidate(id: "mock-010", title: "Pho Saigon", metadata: [
            "cuisine": "Vietnamese", "priceLevel": "1",
            "rating": "4.5", "distanceMeters": "1100",
        ]),
    ]
}
