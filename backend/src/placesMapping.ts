import type { CandidateSeed } from "./candidates.js";

/**
 * Pure mapping for Google Places wire objects — no I/O, importable by
 * tests without dragging Redis connections along (the liveEvents.ts
 * lesson, applied the day it recurred instead of the day it hurt).
 */
export interface PlaceDTO {
  id: string;
  displayName?: { text?: string };
  rating?: number;
  priceLevel?: string;
  primaryTypeDisplayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
}

const PRICE: Record<string, string> = {
  PRICE_LEVEL_FREE: "1",
  PRICE_LEVEL_INEXPENSIVE: "1",
  PRICE_LEVEL_MODERATE: "2",
  PRICE_LEVEL_EXPENSIVE: "3",
  PRICE_LEVEL_VERY_EXPENSIVE: "4",
};

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** Pure mapping, exported for unit tests: one wire place → one opaque
 *  seed. Every metadata value is a string — the provider ↔ card-view
 *  contract the mock has been rehearsing since phase 1. */
export function mapPlace(place: PlaceDTO, centerLat: number, centerLng: number): CandidateSeed | null {
  const title = place.displayName?.text;
  if (!place.id || !title) return null;
  const metadata: Record<string, string> = {
    cuisine: place.primaryTypeDisplayName?.text ?? "Restaurant",
  };
  if (place.rating !== undefined) metadata["rating"] = place.rating.toFixed(1);
  const price = PRICE[place.priceLevel ?? ""];
  if (price) metadata["priceLevel"] = price;
  if (place.location?.latitude !== undefined && place.location.longitude !== undefined) {
    metadata["distanceMeters"] = String(haversineMeters(
      centerLat, centerLng, place.location.latitude, place.location.longitude));
  }
  return { id: place.id, title, metadata };
}

