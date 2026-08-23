/**
 * Server-side candidate sourcing — mirror of HuddleCore's
 * CandidateProvider protocol. The deck is generated HERE (server is the
 * source of truth; one shared generation per room; the API key for the
 * real provider never ships in a client) and the engine side of the wall
 * still never reads metadata.
 *
 * MockRestaurantProvider is the phase-5 stand-in: Google Places replaces
 * the data, not the shape. Same ten restaurants as the iOS mock so the
 * two ends of the project rehearse the same schema.
 */

export interface CandidateSeed {
  id: string;
  title: string;
  metadata: Record<string, string>;
}

export interface CandidateProvider {
  /** Up to `count` candidates, none of whose ids are in `excluding` —
   *  overtime rounds must never re-deal a card the room has seen. */
  fetchCandidates(count: number, excluding?: ReadonlySet<string>): Promise<CandidateSeed[]>;
}

const SAMPLE_RESTAURANTS: CandidateSeed[] = [
  { id: "mock-001", title: "Sichuan Palace",
    metadata: { cuisine: "Sichuan", priceLevel: "2", rating: "4.5", distanceMeters: "800" } },
  { id: "mock-002", title: "Sakura Sushi Bar",
    metadata: { cuisine: "Japanese", priceLevel: "3", rating: "4.7", distanceMeters: "1200" } },
  { id: "mock-003", title: "La Piccola Trattoria",
    metadata: { cuisine: "Italian", priceLevel: "3", rating: "4.3", distanceMeters: "650" } },
  { id: "mock-004", title: "Golden Wok Express",
    metadata: { cuisine: "Cantonese", priceLevel: "1", rating: "4.0", distanceMeters: "300" } },
  { id: "mock-005", title: "El Fuego Taqueria",
    metadata: { cuisine: "Mexican", priceLevel: "2", rating: "4.4", distanceMeters: "950" } },
  { id: "mock-006", title: "Punjab Spice House",
    metadata: { cuisine: "Indian", priceLevel: "2", rating: "4.6", distanceMeters: "1500" } },
  { id: "mock-007", title: "Le Petit Bistro",
    metadata: { cuisine: "French", priceLevel: "4", rating: "4.8", distanceMeters: "2100" } },
  { id: "mock-008", title: "Seoul Kitchen",
    metadata: { cuisine: "Korean", priceLevel: "2", rating: "4.2", distanceMeters: "700" } },
  { id: "mock-009", title: "The Burger Joint",
    metadata: { cuisine: "American", priceLevel: "1", rating: "3.9", distanceMeters: "450" } },
  { id: "mock-010", title: "Pho Saigon",
    metadata: { cuisine: "Vietnamese", priceLevel: "1", rating: "4.5", distanceMeters: "1100" } },
  // A second ten so overtime has a fresh deck to deal.
  { id: "mock-011", title: "Schwartz's Deli",
    metadata: { cuisine: "Deli", priceLevel: "2", rating: "4.4", distanceMeters: "900" } },
  { id: "mock-012", title: "La Banquise",
    metadata: { cuisine: "Poutine", priceLevel: "1", rating: "4.1", distanceMeters: "1700" } },
  { id: "mock-013", title: "Olive et Gourmando",
    metadata: { cuisine: "Café", priceLevel: "2", rating: "4.6", distanceMeters: "1300" } },
  { id: "mock-014", title: "Kazu",
    metadata: { cuisine: "Japanese", priceLevel: "2", rating: "4.5", distanceMeters: "2000" } },
  { id: "mock-015", title: "Damas",
    metadata: { cuisine: "Syrian", priceLevel: "4", rating: "4.7", distanceMeters: "2400" } },
  { id: "mock-016", title: "Satay Brothers",
    metadata: { cuisine: "Singaporean", priceLevel: "2", rating: "4.3", distanceMeters: "1600" } },
  { id: "mock-017", title: "Chez Claudette",
    metadata: { cuisine: "Diner", priceLevel: "1", rating: "4.0", distanceMeters: "1100" } },
  { id: "mock-018", title: "Le Vin Papillon",
    metadata: { cuisine: "Wine bar", priceLevel: "3", rating: "4.6", distanceMeters: "2200" } },
  { id: "mock-019", title: "Gyu-Kaku",
    metadata: { cuisine: "Yakiniku", priceLevel: "3", rating: "4.2", distanceMeters: "800" } },
  { id: "mock-020", title: "Pizzeria Napoletana",
    metadata: { cuisine: "Pizza", priceLevel: "2", rating: "4.3", distanceMeters: "1900" } },
];

export class MockRestaurantProvider implements CandidateProvider {
  async fetchCandidates(
    count: number, excluding: ReadonlySet<string> = new Set(),
  ): Promise<CandidateSeed[]> {
    // Fisher–Yates so each room gets its own deck order; within a room
    // the order is frozen at start time (position column) — everyone
    // swipes the same sequence.
    const deck = SAMPLE_RESTAURANTS.filter((c) => !excluding.has(c.id));
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    return deck.slice(0, count);
  }
}
