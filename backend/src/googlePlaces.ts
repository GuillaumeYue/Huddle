import { Redis } from "ioredis";
import { redisPub } from "./redis.js";
import type { CandidateProvider, CandidateSeed } from "./candidates.js";
import { mapPlace, type PlaceDTO } from "./placesMapping.js";

/**
 * The real RestaurantProvider — Google Places API (New), server-side
 * only (invariant: the shared deck is one generation, and the API key
 * never ships in a client).
 *
 * Cost discipline: one Nearby Search feeds every room in the same
 * ~1km grid cell for CACHE_TTL_S. The engine never sees any of this —
 * it still receives opaque CandidateSeeds (invariant 1 holds with real
 * data exactly as it did with the mock).
 *
 * Language: the deck is shared, so language is per ROOM, not per user
 * (one generation = one rendering); v1 pins it via PLACES_LANG.
 * Photos are a separately billed second request — deliberately not
 * fetched yet; the card's mesh gradient stays for now.
 */

const API_KEY = process.env["GOOGLE_PLACES_API_KEY"] ?? "";
const LAT = Number(process.env["PLACES_LAT"] ?? 45.5019);   // Montréal
const LNG = Number(process.env["PLACES_LNG"] ?? -73.5674);
const RADIUS_M = Number(process.env["PLACES_RADIUS_M"] ?? 1500);
const LANG = process.env["PLACES_LANG"] ?? "en";
const CACHE_TTL_S = Number(process.env["PLACES_CACHE_TTL_S"] ?? 6 * 60 * 60);

export const placesConfigured = (): boolean => API_KEY.length > 0;

export class GooglePlacesProvider implements CandidateProvider {
  constructor(private readonly redis: Redis = redisPub) {}

  async fetchCandidates(
    count: number, excluding: ReadonlySet<string> = new Set(),
  ): Promise<CandidateSeed[]> {
    const pool = await this.cellCandidates();
    const fresh = pool.filter((c) => !excluding.has(c.id));
    // Fisher–Yates; the caller freezes the order per room.
    for (let i = fresh.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [fresh[i], fresh[j]] = [fresh[j]!, fresh[i]!];
    }
    return fresh.slice(0, count);
  }

  /** The grid cell's pool: Redis first, one real API call on a miss. */
  private async cellCandidates(): Promise<CandidateSeed[]> {
    // ~1km grid: rounding to 0.01° keeps every room in the same cell on
    // the same cache entry.
    const cell = `${LAT.toFixed(2)}:${LNG.toFixed(2)}:${RADIUS_M}:${LANG}`;
    const key = `places:v1:${cell}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as CandidateSeed[];

    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        // FieldMask is the billing lever: ask for exactly what the card
        // renders, nothing more.
        "X-Goog-FieldMask": [
          "places.id", "places.displayName", "places.rating",
          "places.priceLevel", "places.primaryTypeDisplayName", "places.location",
        ].join(","),
      },
      body: JSON.stringify({
        // Primary type, not type-list membership: a hotel with a dining
        // room has "restaurant" among its types — includedTypes let the
        // Fairmont and a public square onto the deck in field testing.
        includedPrimaryTypes: ["restaurant"],
        maxResultCount: 20,
        languageCode: LANG,
        locationRestriction: {
          circle: { center: { latitude: LAT, longitude: LNG }, radius: RADIUS_M },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Places API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json() as { places?: PlaceDTO[] };
    const seeds = (body.places ?? [])
      .map((p) => mapPlace(p, LAT, LNG))
      .filter((s): s is CandidateSeed => s !== null);
    if (seeds.length > 0) {
      await this.redis.set(key, JSON.stringify(seeds), "EX", CACHE_TTL_S);
    }
    return seeds;
  }
}
