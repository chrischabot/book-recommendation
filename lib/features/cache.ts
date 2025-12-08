/**
 * Caching utilities for recommendations
 * Multi-layer cache with Redis (optional) and Postgres
 */

import { Redis } from "ioredis";
import { query, transaction } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";
import { getEnv } from "@/lib/config/env";

let redis: Redis | null = null;

/**
 * Check if Redis is configured with a valid URL
 */
function hasValidRedisConfig(): boolean {
  const redisUrl = getEnv().REDIS_URL;
  return typeof redisUrl === "string" && redisUrl.length > 0;
}

/**
 * Get Redis client if configured
 */
function getRedis(): Redis | null {
  if (!hasValidRedisConfig()) return null;

  if (!redis) {
    const redisUrl = getEnv().REDIS_URL;
    if (!redisUrl) return null; // Type guard for TypeScript

    redis = new Redis(redisUrl);
    redis.on("error", (err) => {
      logger.warn("Redis error", { error: String(err) });
    });
  }

  return redis;
}

/**
 * Cache key namespaces
 */
const NAMESPACE = {
  recommendations: "recs",
  candidates: "cand",
  explanations: "expl",
};

/**
 * Build cache key
 */
function buildKey(
  namespace: string,
  userId: string,
  mode: string,
  key?: string
): string {
  const parts = [namespace, userId, mode];
  if (key) parts.push(key);
  return parts.join(":");
}

/**
 * Get from Redis cache
 */
async function getFromRedis<T>(key: string): Promise<T | null> {
  const client = getRedis();
  if (!client) return null;

  try {
    const value = await client.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    logger.warn("Redis get error", { key, error: String(error) });
    return null;
  }
}

/**
 * Set in Redis cache
 */
async function setInRedis(
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    await client.setex(key, ttlSeconds, JSON.stringify(value));
  } catch (error) {
    logger.warn("Redis set error", { key, error: String(error) });
  }
}

/**
 * Delete from Redis cache
 */
async function deleteFromRedis(pattern: string): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(...keys);
    }
  } catch (error) {
    logger.warn("Redis delete error", { pattern, error: String(error) });
  }
}

/**
 * Candidate cache entry
 */
export interface CandidateCacheEntry {
  workIds: number[];
  scores: number[];
  createdAt: Date;
}

/**
 * Get cached candidates
 */
export async function getCachedCandidates(
  userId: string,
  mode: string,
  cacheKey: string
): Promise<CandidateCacheEntry | null> {
  const key = buildKey(NAMESPACE.candidates, userId, mode, cacheKey);

  // Try Redis first
  const redisResult = await getFromRedis<CandidateCacheEntry>(key);
  if (redisResult) return redisResult;

  // Fall back to Postgres
  const { rows } = await query<{
    work_ids: number[];
    scores: number[] | string[];
    created_at: Date;
  }>(
    `
    SELECT work_ids, scores, created_at
    FROM "CandidateCache"
    WHERE user_id = $1 AND mode = $2 AND cache_key = $3
      AND expires_at > NOW()
    `,
    [userId, mode, cacheKey]
  );

  if (rows.length === 0) return null;

  // PostgreSQL array columns may return as number[] or string[] depending on driver
  const scores = rows[0].scores.map((s) =>
    typeof s === "number" ? s : parseFloat(s)
  );

  const entry: CandidateCacheEntry = {
    workIds: rows[0].work_ids,
    scores,
    createdAt: rows[0].created_at,
  };

  // Populate Redis for next time
  await setInRedis(key, entry, 3600); // 1 hour

  return entry;
}

/**
 * Store candidates in cache
 */
export async function setCachedCandidates(
  userId: string,
  mode: string,
  cacheKey: string,
  workIds: number[],
  scores: number[]
): Promise<void> {
  const key = buildKey(NAMESPACE.candidates, userId, mode, cacheKey);

  // Store in Postgres
  await transaction(async (client) => {
    await client.query(
      `
      INSERT INTO "CandidateCache" (user_id, mode, cache_key, work_ids, scores, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '24 hours')
      ON CONFLICT (user_id, mode, cache_key) DO UPDATE SET
        work_ids = EXCLUDED.work_ids,
        scores = EXCLUDED.scores,
        created_at = NOW(),
        expires_at = NOW() + INTERVAL '24 hours'
      `,
      [userId, mode, cacheKey, workIds, scores]
    );
  });

  // Store in Redis
  await setInRedis(
    key,
    { workIds, scores, createdAt: new Date() },
    86400 // 24 hours
  );
}

/**
 * Invalidate caches for a user
 */
export async function invalidateUserCaches(userId: string): Promise<void> {
  logger.info("Invalidating caches for user", { userId });

  // Clear Redis
  await deleteFromRedis(`${NAMESPACE.candidates}:${userId}:*`);
  await deleteFromRedis(`${NAMESPACE.recommendations}:${userId}:*`);
  await deleteFromRedis(`${NAMESPACE.explanations}:${userId}:*`);

  // Clear Postgres
  await query(`DELETE FROM "CandidateCache" WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM "ExplanationCache" WHERE user_id = $1`, [userId]);
}

/**
 * Explanation cache entry
 */
export interface ExplanationCacheEntry {
  reasons: string[];
  quality: string;
  confidence: number;
}

/**
 * Get cached explanation
 */
export async function getCachedExplanation(
  userId: string,
  workId: number,
  anchorsHash: string
): Promise<ExplanationCacheEntry | null> {
  const key = buildKey(
    NAMESPACE.explanations,
    userId,
    String(workId),
    anchorsHash
  );

  // Try Redis
  const redisResult = await getFromRedis<ExplanationCacheEntry>(key);
  if (redisResult) return redisResult;

  // Fall back to Postgres
  const { rows } = await query<{
    reasons: string[];
    quality: string;
    confidence: number | string;
  }>(
    `
    SELECT reasons, quality, confidence
    FROM "ExplanationCache"
    WHERE user_id = $1 AND work_id = $2 AND anchors_hash = $3
    `,
    [userId, workId, anchorsHash]
  );

  if (rows.length === 0) return null;

  const entry: ExplanationCacheEntry = {
    reasons: rows[0].reasons,
    quality: rows[0].quality,
    confidence: typeof rows[0].confidence === "number"
      ? rows[0].confidence
      : parseFloat(rows[0].confidence),
  };

  await setInRedis(key, entry, 604800); // 7 days

  return entry;
}

/**
 * Store explanation in cache
 */
export async function setCachedExplanation(
  userId: string,
  workId: number,
  anchorsHash: string,
  entry: ExplanationCacheEntry
): Promise<void> {
  const key = buildKey(
    NAMESPACE.explanations,
    userId,
    String(workId),
    anchorsHash
  );

  await transaction(async (client) => {
    await client.query(
      `
      INSERT INTO "ExplanationCache" (user_id, work_id, anchors_hash, reasons, quality, confidence)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, work_id, anchors_hash) DO UPDATE SET
        reasons = EXCLUDED.reasons,
        quality = EXCLUDED.quality,
        confidence = EXCLUDED.confidence,
        created_at = NOW()
      `,
      [userId, workId, anchorsHash, entry.reasons, entry.quality, entry.confidence]
    );
  });

  await setInRedis(key, entry, 604800); // 7 days
}

/**
 * Clean up expired cache entries
 */
export async function cleanupExpiredCaches(): Promise<{
  candidates: number;
  resolver: number;
}> {
  logger.info("Cleaning up expired caches");

  const { rowCount: candidates } = await query(
    `DELETE FROM "CandidateCache" WHERE expires_at < NOW()`
  );

  const { rowCount: resolver } = await query(
    `DELETE FROM "ResolverCache" WHERE expires_at < NOW()`
  );

  return {
    candidates: candidates ?? 0,
    resolver: resolver ?? 0,
  };
}

/**
 * Close Redis connection
 */
export async function closeCache(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
