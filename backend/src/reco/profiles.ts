import { pool } from "../db.js";
import { redisPub } from "../redis.js";
import {
  emptyProfile, profileFromRows, type SwipeRow, type TasteProfile,
} from "./scoring.js";

/**
 * Profile storage — the OFFLINE/ONLINE seam of the recommender.
 * buildProfile (heavy: scans a user's whole swipe history) runs only in
 * the worker; the deal path only ever GETs the cached result. Profiles
 * are rebuildable from Postgres at any time, so Redis stays volume-less
 * in spirit: nothing here is a fact that can be lost.
 */

const profileKey = (userId: string): string => `reco:profile:${userId}`;
const PROFILE_TTL_S = 30 * 24 * 60 * 60; // refreshed on every rebuild

export async function buildProfile(userId: string): Promise<TasteProfile> {
  const { rows } = await pool.query<{ decision: "YES" | "NO"; metadata: Record<string, string> }>(
    `SELECT s.decision, c.metadata
       FROM swipes s
       JOIN room_candidates c
         ON c.room_id = s.room_id AND c.candidate_id = s.candidate_id
      WHERE s.user_id = $1`,
    [userId],
  );
  const profile = profileFromRows(rows as SwipeRow[]);
  await redisPub.set(profileKey(userId), JSON.stringify(profile), "EX", PROFILE_TTL_S);
  return profile;
}

/** Online path: cached profiles only — a miss is a cold start (neutral
 *  profile), NEVER a rebuild. The deal path must stay light. */
export async function getProfiles(userIds: string[]): Promise<TasteProfile[]> {
  if (userIds.length === 0) return [];
  const cached = await redisPub.mget(userIds.map(profileKey));
  return cached.map((raw) =>
    raw ? (JSON.parse(raw) as TasteProfile) : emptyProfile());
}
