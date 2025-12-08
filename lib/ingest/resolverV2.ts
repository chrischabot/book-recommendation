/**
 * Resolver V2 - Multi-source book resolution with confidence scoring
 *
 * Resolution priority order:
 * 1. ISBN → Open Library (0.98) / Google Books (0.85) / Local (0.75)
 * 2. Google Books Volume ID (0.82)
 * 3. Title + Author → Google Books (0.80)
 * 4. ASIN only (0.65)
 * 5. Royal Road ID (0.60)
 * 6. Goodreads ID (0.55)
 * 7. Manual stub (0.40)
 */

import { query } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";
import { parseExternalIdsFromUrl } from "@/lib/util/urlParser";
import type {
  ResolveInput,
  ResolveResult,
  ResolutionPath,
  ResolverCacheEntry,
  ResolverLogEntry,
  WorkSource,
} from "./resolverV2/types";
import {
  resolveByIsbn,
  resolveByGoogleVolumeId,
  resolveByTitleAuthor,
  resolveByAsin,
  resolveByRoyalRoad,
  resolveByGoodreadsId,
  createManualStub,
} from "./resolverV2/paths";
import { findPotentialDuplicates, shouldMerge, mergeWorks } from "./resolverV2/merge";

// Re-export types and utilities
export * from "./resolverV2/types";
export { parseExternalIdsFromUrl } from "@/lib/util/urlParser";

/**
 * Build a normalized cache key from input
 * Priority: ISBN13 > ISBN10 > GoogleVolumeId > ASIN > RoyalRoadId > GoodreadsId > title+author
 */
function buildCacheKey(input: ResolveInput): string {
  if (input.isbn13) return `isbn13:${input.isbn13}`;
  if (input.isbn10) return `isbn10:${input.isbn10}`;
  if (input.googleVolumeId) return `gbid:${input.googleVolumeId}`;
  if (input.asin) return `asin:${input.asin.toUpperCase()}`;
  if (input.royalRoadId) return `rr:${input.royalRoadId}`;
  if (input.goodreadsId) return `gr:${input.goodreadsId}`;
  if (input.title) {
    const normalizedTitle = input.title.toLowerCase().trim();
    const normalizedAuthor = input.author?.toLowerCase().trim() || "";
    return `title:${normalizedTitle}|author:${normalizedAuthor}`;
  }
  throw new Error("Cannot build cache key: no identifiable fields in input");
}

/**
 * Check resolver cache for existing resolution
 */
async function checkCache(cacheKey: string): Promise<ResolverCacheEntry | null> {
  const { rows } = await query<{
    work_id: number;
    edition_id: number;
    confidence: string;
    path: ResolutionPath;
    source: string;
  }>(
    `SELECT rc.work_id, e.id as edition_id, rc.confidence, rl.path_taken as path, w.source
     FROM "ResolverCache" rc
     JOIN "Work" w ON w.id = rc.work_id
     LEFT JOIN "Edition" e ON e.work_id = rc.work_id
     LEFT JOIN "ResolverLog" rl ON rl.work_id = rc.work_id
     WHERE rc.lookup_key = $1
     AND rc.expires_at > NOW()
     LIMIT 1`,
    [cacheKey]
  );

  if (!rows[0]) return null;

  // Validate source is a known WorkSource value
  const validSources: WorkSource[] = ["openlibrary", "googlebooks", "amazon", "royalroad", "goodreads", "manual"];
  const rawSource = rows[0].source;
  const source: WorkSource = validSources.includes(rawSource as WorkSource)
    ? (rawSource as WorkSource)
    : "manual";

  return {
    workId: rows[0].work_id,
    editionId: rows[0].edition_id,
    confidence: parseFloat(rows[0].confidence),
    path: rows[0].path || "manual",
    source,
  };
}

/**
 * Store resolution in cache with upsert semantics
 * Uses ON CONFLICT to handle race conditions where two concurrent requests
 * attempt to cache the same key
 */
async function storeCache(
  cacheKey: string,
  result: ResolveResult
): Promise<void> {
  await query(
    `INSERT INTO "ResolverCache" (lookup_key, work_id, confidence, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '90 days')
     ON CONFLICT (lookup_key) DO UPDATE SET
       work_id = EXCLUDED.work_id,
       confidence = EXCLUDED.confidence,
       expires_at = NOW() + INTERVAL '90 days'`,
    [cacheKey, result.workId, result.confidence]
  );
}

/**
 * Try to acquire an advisory lock for a cache key to prevent duplicate resolution
 * Returns true if lock acquired, false if another process is already resolving
 */
async function tryAcquireResolutionLock(cacheKey: string): Promise<boolean> {
  // Use PostgreSQL advisory lock with hash of cache key
  const lockKey = Math.abs(hashCode(cacheKey));
  const { rows } = await query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock($1) as acquired`,
    [lockKey]
  );
  return rows[0]?.acquired ?? false;
}

/**
 * Release advisory lock for a cache key
 */
async function releaseResolutionLock(cacheKey: string): Promise<void> {
  const lockKey = Math.abs(hashCode(cacheKey));
  await query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
}

/**
 * Simple hash code function for strings
 */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash;
}

/**
 * Log resolution for analytics and debugging
 */
async function logResolution(
  cacheKey: string,
  input: ResolveInput,
  result: ResolveResult
): Promise<void> {
  await query(
    `INSERT INTO "ResolverLog" (input_key, input_data, path_taken, work_id, edition_id, confidence, created, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      cacheKey,
      JSON.stringify(input),
      result.path,
      result.workId,
      result.editionId,
      result.confidence,
      result.created,
    ]
  );
}

/**
 * Check for and handle potential duplicates after resolution
 * If a better identifier links to an existing Work, merge them
 */
async function checkAndMergeDuplicates(
  result: ResolveResult,
  input: ResolveInput
): Promise<void> {
  if (!result.created) return; // Only check for newly created works

  // Find potential duplicates based on title/author similarity
  const potentialDupes = await findPotentialDuplicates(
    result.workId,
    input.title,
    input.author
  );

  for (const dupeWorkId of potentialDupes) {
    const mergeCheck = await shouldMerge(result.workId, dupeWorkId);

    if (mergeCheck.shouldMerge && mergeCheck.reason) {
      // Lower ID is canonical (older = more established)
      const [fromId, toId] =
        result.workId > dupeWorkId
          ? [result.workId, dupeWorkId]
          : [dupeWorkId, result.workId];

      logger.info("Merging duplicate works", {
        fromWorkId: fromId,
        toWorkId: toId,
        reason: mergeCheck.reason,
      });

      await mergeWorks(fromId, toId, mergeCheck.reason);

      // Update result to point to canonical work
      if (result.workId === fromId) {
        result.workId = toId;
      }

      break; // Only merge once per resolution
    }
  }
}

/** Format path name for display */
function formatPath(path: ResolutionPath): string {
  const pathNames: Record<ResolutionPath, string> = {
    isbn_ol: "Open Library",
    isbn_gb: "Google Books",
    isbn_local: "ISBN only",
    gbid: "Google Books",
    title_gb: "Google Books",
    asin: "Kindle",
    royalroad: "Royal Road",
    goodreads: "Goodreads",
    manual: "manual",
  };
  return pathNames[path] || path;
}

/**
 * Main resolution function
 * Routes to appropriate path based on available identifiers
 * Uses advisory locking to prevent duplicate work creation from concurrent requests
 */
export async function resolveWork(input: ResolveInput): Promise<ResolveResult> {
  // Validate input has at least some identifiable data
  const hasIdentifier =
    input.isbn13 ||
    input.isbn10 ||
    input.googleVolumeId ||
    input.asin ||
    input.royalRoadId ||
    input.goodreadsId ||
    input.title;

  if (!hasIdentifier) {
    throw new Error("resolveWork requires at least one identifier or title");
  }

  const cacheKey = buildCacheKey(input);
  const displayTitle = input.title?.slice(0, 50) || "Unknown";

  // Check cache first
  const cached = await checkCache(cacheKey);

  if (cached) {
    logger.debug("Resolved (cached)", { title: displayTitle, workId: cached.workId });
    return {
      workId: cached.workId,
      editionId: cached.editionId,
      confidence: cached.confidence,
      created: false,
      path: cached.path,
      source: cached.source,
    };
  }

  // Try to acquire lock to prevent concurrent duplicate resolution
  const lockAcquired = await tryAcquireResolutionLock(cacheKey);

  if (!lockAcquired) {
    // Another process is resolving this key - wait a bit and check cache again
    await new Promise((resolve) => setTimeout(resolve, 100));
    const recheckCached = await checkCache(cacheKey);
    if (recheckCached) {
      logger.debug("Resolved (concurrent cache)", { title: displayTitle, workId: recheckCached.workId });
      return {
        workId: recheckCached.workId,
        editionId: recheckCached.editionId,
        confidence: recheckCached.confidence,
        created: false,
        path: recheckCached.path,
        source: recheckCached.source,
      };
    }
    // Proceed without lock if cache still empty (concurrent process may have failed)
  }

  let result: ResolveResult;

  try {
    // Route to appropriate path based on available identifiers
    // Priority order ensures highest-confidence paths are tried first

    if (input.isbn13 || input.isbn10) {
      // Path 1: ISBN-based resolution (highest priority)
      result = await resolveByIsbn(input);
    } else if (input.googleVolumeId) {
      // Path 2: Google Books Volume ID
      result = await resolveByGoogleVolumeId(input);
    } else if (input.title && input.author) {
      // Path 3: Title + Author via Google Books search
      result = await resolveByTitleAuthor(input);
    } else if (input.asin) {
      // Path 4: ASIN only (Kindle)
      result = await resolveByAsin(input);
    } else if (input.royalRoadId) {
      // Path 5: Royal Road fiction ID
      result = await resolveByRoyalRoad(input);
    } else if (input.goodreadsId) {
      // Path 6: Goodreads book ID
      result = await resolveByGoodreadsId(input);
    } else if (input.title) {
      // Path 7: Title only - try Google Books then manual
      result = await resolveByTitleAuthor(input);
    } else {
      // This shouldn't happen given the hasIdentifier check above
      throw new Error("No resolution path available for input");
    }

    // Cache and log the resolution
    await storeCache(cacheKey, result);
    await logResolution(cacheKey, input, result);
  } finally {
    // Always release lock if we acquired it
    if (lockAcquired) {
      await releaseResolutionLock(cacheKey);
    }
  }

  // Check for and merge duplicates (requires GIN trigram index from migration 013)
  await checkAndMergeDuplicates(result, input);

  // Log result
  const status = result.created ? "+" : "=";
  const pathDisplay = formatPath(result.path);
  logger.info(`${status} ${displayTitle}`, { via: pathDisplay, workId: result.workId });

  return result;
}

/**
 * Resolve from a URL (Amazon, Goodreads, Royal Road, Google Books)
 * Extracts external IDs from the URL and resolves
 */
export async function resolveFromUrl(
  url: string,
  metadata?: { title?: string; author?: string }
): Promise<ResolveResult> {
  const externalIds = parseExternalIdsFromUrl(url);

  const input: ResolveInput = {
    ...metadata,
    asin: externalIds.asin,
    goodreadsId: externalIds.goodreadsId,
    royalRoadId: externalIds.royalRoadId,
    googleVolumeId: externalIds.googleVolumeId,
  };

  return resolveWork(input);
}

/**
 * Batch resolve multiple inputs
 * Uses parallel processing with controlled concurrency
 */
export async function resolveWorkBatch(
  inputs: ResolveInput[],
  options: { concurrency?: number } = {}
): Promise<Map<number, ResolveResult>> {
  const { concurrency = 5 } = options;
  const results = new Map<number, ResolveResult>();

  // Process in batches to control concurrency
  for (let i = 0; i < inputs.length; i += concurrency) {
    const batch = inputs.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((input, idx) =>
        resolveWork(input)
          .then((result) => ({ index: i + idx, result }))
          .catch((error) => {
            logger.warn("Failed to resolve work in batch", {
              index: i + idx,
              title: input.title,
              error: String(error),
            });
            return null;
          })
      )
    );

    for (const item of batchResults) {
      if (item) {
        results.set(item.index, item.result);
      }
    }
  }

  return results;
}

/**
 * Get resolution statistics
 */
export async function getResolverStats(): Promise<{
  totalResolutions: number;
  byPath: Record<ResolutionPath, number>;
  avgConfidence: number;
  cacheHitRate: number;
}> {
  const { rows: pathStats } = await query<{ path_taken: ResolutionPath; count: string }>(
    `SELECT path_taken, COUNT(*) as count
     FROM "ResolverLog"
     GROUP BY path_taken`
  );

  const { rows: avgStats } = await query<{ avg_confidence: string; total: string }>(
    `SELECT AVG(confidence) as avg_confidence, COUNT(*) as total
     FROM "ResolverLog"`
  );

  const byPath: Record<ResolutionPath, number> = {
    isbn_ol: 0,
    isbn_gb: 0,
    isbn_local: 0,
    gbid: 0,
    title_gb: 0,
    asin: 0,
    royalroad: 0,
    goodreads: 0,
    manual: 0,
  };

  for (const row of pathStats) {
    if (row.path_taken in byPath) {
      byPath[row.path_taken] = parseInt(row.count, 10);
    }
  }

  const total = parseInt(avgStats[0]?.total || "0", 10);

  // Estimate cache hit rate from logs (resolutions with created=false)
  const { rows: hitStats } = await query<{ hits: string }>(
    `SELECT COUNT(*) as hits FROM "ResolverLog" WHERE created = false`
  );
  const hits = parseInt(hitStats[0]?.hits || "0", 10);

  return {
    totalResolutions: total,
    byPath,
    avgConfidence: parseFloat(avgStats[0]?.avg_confidence || "0"),
    cacheHitRate: total > 0 ? hits / total : 0,
  };
}
