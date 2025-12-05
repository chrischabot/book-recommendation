/**
 * HTTP response cache for external API calls
 * Caches successful responses in PostgreSQL with configurable TTL
 */

import { createHash } from "crypto";
import { query } from "@/lib/db/pool";
import { logger } from "./logger";

const DEFAULT_TTL_DAYS = 5;

interface CachedResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

interface HttpCacheRow {
  cache_key: string;
  status: number;
  body: string;
  headers: Record<string, string> | null;
}

/**
 * Create a cache key from URL and request options
 */
function createCacheKey(url: string, options?: RequestInit): string {
  const hash = createHash("sha256");
  hash.update(url);
  hash.update(options?.method ?? "GET");
  if (options?.body) {
    hash.update(
      typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body)
    );
  }
  return `http:${hash.digest("hex").slice(0, 32)}`;
}

/**
 * Get cached response from database
 */
async function getCachedResponse(
  cacheKey: string
): Promise<CachedResponse | null> {
  try {
    const { rows } = await query<HttpCacheRow>(
      `SELECT status, body, headers FROM "HttpCache"
       WHERE cache_key = $1 AND expires_at > NOW()`,
      [cacheKey]
    );

    if (rows.length === 0) return null;

    return {
      status: rows[0].status,
      body: rows[0].body,
      headers: rows[0].headers ?? {},
    };
  } catch (error) {
    logger.warn("Failed to read from HTTP cache", { error: String(error) });
    return null;
  }
}

/**
 * Store response in cache
 */
async function setCachedResponse(
  cacheKey: string,
  url: string,
  response: CachedResponse,
  ttlDays: number = DEFAULT_TTL_DAYS
): Promise<void> {
  try {
    await query(
      `INSERT INTO "HttpCache" (cache_key, url, status, body, headers, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 day' * $6)
       ON CONFLICT (cache_key) DO UPDATE SET
         status = EXCLUDED.status,
         body = EXCLUDED.body,
         headers = EXCLUDED.headers,
         expires_at = NOW() + INTERVAL '1 day' * $6`,
      [cacheKey, url, response.status, response.body, response.headers, ttlDays]
    );
  } catch (error) {
    logger.warn("Failed to write to HTTP cache", { error: String(error) });
  }
}

/**
 * Fetch with caching - wraps native fetch with database-backed cache
 *
 * @param url - URL to fetch
 * @param options - Standard fetch options
 * @param ttlDays - Cache TTL in days (default 5)
 * @returns Response object (from cache or network)
 */
export async function cachedFetch(
  url: string,
  options?: RequestInit,
  ttlDays: number = DEFAULT_TTL_DAYS
): Promise<Response> {
  const cacheKey = createCacheKey(url, options);

  // Check cache first
  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      headers: new Headers(cached.headers),
    });
  }

  // Make real request
  const response = await fetch(url, options);

  // Cache successful responses only
  if (response.ok) {
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    await setCachedResponse(cacheKey, url, { status: response.status, body, headers }, ttlDays);

    // Return new Response since we consumed the body
    return new Response(body, {
      status: response.status,
      headers: new Headers(headers),
    });
  }

  return response;
}

/**
 * Clear expired cache entries
 */
export async function cleanupHttpCache(): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM "HttpCache" WHERE expires_at < NOW()`
  );
  return rowCount ?? 0;
}

/**
 * Clear all cache entries (for testing/debugging)
 */
export async function clearHttpCache(): Promise<void> {
  await query(`DELETE FROM "HttpCache"`);
}

/**
 * Get cache statistics
 */
export async function getHttpCacheStats(): Promise<{
  totalEntries: number;
  expiredEntries: number;
  totalSizeBytes: number;
}> {
  const { rows } = await query<{
    total: string;
    expired: string;
    size_bytes: string;
  }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE expires_at < NOW()) AS expired,
       COALESCE(SUM(LENGTH(body)), 0) AS size_bytes
     FROM "HttpCache"`
  );

  return {
    totalEntries: parseInt(rows[0].total, 10),
    expiredEntries: parseInt(rows[0].expired, 10),
    totalSizeBytes: parseInt(rows[0].size_bytes, 10),
  };
}
