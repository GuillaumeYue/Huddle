import { redisPub } from "../redis.js";

/** The job queue: a Redis list. Settlement pushes userIds; the worker
 *  BRPOPs and rebuilds their profiles. Duplicate jobs are harmless —
 *  a rebuild is idempotent. */
export const PROFILE_QUEUE = "jobs:profiles";

export async function enqueueProfileJobs(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await redisPub.lpush(PROFILE_QUEUE, ...userIds);
}
