/**
 * Identity resolution for books
 * Maps ISBNs and title/author combinations to work IDs
 */

import { search } from "fast-fuzzy";
import { query, transaction } from "@/lib/db/pool";
import { normalizeIsbn, isbn10ToIsbn13, stringSimilarity, normalizeAuthorName } from "@/lib/util/text";
import { logger } from "@/lib/util/logger";

// In-memory LRU cache for hot lookups
const LRU_SIZE = 10000;
const lruCache = new Map<string, number | null>();

/**
 * Add to LRU cache, evicting oldest if needed
 */
function cachePut(key: string, value: number | null): void {
  if (lruCache.size >= LRU_SIZE) {
    const firstKey = lruCache.keys().next().value;
    if (firstKey) lruCache.delete(firstKey);
  }
  lruCache.set(key, value);
}

/**
 * Get from LRU cache and refresh position
 */
function cacheGet(key: string): number | null | undefined {
  const value = lruCache.get(key);
  if (value !== undefined) {
    // Refresh position by re-inserting
    lruCache.delete(key);
    lruCache.set(key, value);
  }
  return value;
}

/**
 * Check persistent cache in database
 */
async function checkDbCache(lookupKey: string): Promise<number | null> {
  const { rows } = await query<{ work_id: number }>(
    `
    SELECT work_id FROM "ResolverCache"
    WHERE lookup_key = $1 AND expires_at > NOW()
    `,
    [lookupKey]
  );

  return rows[0]?.work_id ?? null;
}

/**
 * Store in persistent cache
 */
async function storeDbCache(
  lookupKey: string,
  workId: number,
  confidence: number
): Promise<void> {
  await query(
    `
    INSERT INTO "ResolverCache" (lookup_key, work_id, confidence, expires_at)
    VALUES ($1, $2, $3, NOW() + INTERVAL '90 days')
    ON CONFLICT (lookup_key) DO UPDATE SET
      work_id = EXCLUDED.work_id,
      confidence = EXCLUDED.confidence,
      expires_at = NOW() + INTERVAL '90 days'
    `,
    [lookupKey, workId, confidence]
  );
}

/**
 * Resolve book by ISBN to work ID
 */
export async function resolveByIsbn(isbn: string): Promise<number | null> {
  const normalized = normalizeIsbn(isbn);
  const isbn13 = normalized.isbn13 ?? (normalized.isbn10 ? isbn10ToIsbn13(normalized.isbn10) : null);
  const isbn10 = normalized.isbn10;

  if (!isbn13 && !isbn10) return null;

  const cacheKey = `isbn:${isbn13 ?? isbn10}`;

  // Check LRU cache
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  // Check DB cache
  const dbCached = await checkDbCache(cacheKey);
  if (dbCached !== null) {
    cachePut(cacheKey, dbCached);
    return dbCached;
  }

  // Query database
  const { rows } = await query<{ work_id: number }>(
    `
    SELECT work_id FROM "Edition"
    WHERE isbn13 = $1 OR isbn10 = $2
    LIMIT 1
    `,
    [isbn13, isbn10]
  );

  const workId = rows[0]?.work_id ?? null;

  // Cache result
  cachePut(cacheKey, workId);
  if (workId !== null) {
    await storeDbCache(cacheKey, workId, 1.0);
  }

  return workId;
}

/**
 * Resolve book by title and author to work ID
 * Uses fuzzy matching when exact match not found
 */
export async function resolveByTitleAuthor(
  title: string,
  author: string
): Promise<number | null> {
  const normalizedTitle = title.toLowerCase().trim();
  const normalizedAuthor = normalizeAuthorName(author).toLowerCase().trim();

  const cacheKey = `title:${normalizedTitle}|author:${normalizedAuthor}`;

  // Check LRU cache
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  // Check DB cache
  const dbCached = await checkDbCache(cacheKey);
  if (dbCached !== null) {
    cachePut(cacheKey, dbCached);
    return dbCached;
  }

  // Try exact title match first
  const exactMatch = await findExactTitleMatch(normalizedTitle, normalizedAuthor);
  if (exactMatch) {
    cachePut(cacheKey, exactMatch.workId);
    await storeDbCache(cacheKey, exactMatch.workId, exactMatch.confidence);
    return exactMatch.workId;
  }

  // Try fuzzy matching
  const fuzzyMatch = await findFuzzyTitleMatch(normalizedTitle, normalizedAuthor);
  if (fuzzyMatch && fuzzyMatch.confidence >= 0.7) {
    cachePut(cacheKey, fuzzyMatch.workId);
    await storeDbCache(cacheKey, fuzzyMatch.workId, fuzzyMatch.confidence);
    return fuzzyMatch.workId;
  }

  // Cache negative result
  cachePut(cacheKey, null);
  return null;
}

/**
 * Find exact title match with author verification
 */
async function findExactTitleMatch(
  title: string,
  author: string
): Promise<{ workId: number; confidence: number } | null> {
  const { rows } = await query<{ id: number; author_name: string }>(
    `
    SELECT w.id, a.name AS author_name
    FROM "Work" w
    LEFT JOIN "WorkAuthor" wa ON w.id = wa.work_id
    LEFT JOIN "Author" a ON wa.author_id = a.id
    WHERE LOWER(w.title) = $1
    LIMIT 10
    `,
    [title]
  );

  if (rows.length === 0) return null;

  // If only one match, use it
  if (rows.length === 1) {
    return { workId: rows[0].id, confidence: 0.9 };
  }

  // Multiple matches - verify by author
  if (author) {
    for (const row of rows) {
      if (row.author_name) {
        const authorSim = stringSimilarity(author, row.author_name.toLowerCase());
        if (authorSim >= 0.8) {
          return { workId: row.id, confidence: 0.95 };
        }
      }
    }
  }

  // Return first match with lower confidence
  return { workId: rows[0].id, confidence: 0.7 };
}

/**
 * Find fuzzy title match
 */
async function findFuzzyTitleMatch(
  title: string,
  author: string
): Promise<{ workId: number; confidence: number } | null> {
  // Get candidate titles (first word match for efficiency)
  const firstWord = title.split(/\s+/)[0];
  if (!firstWord || firstWord.length < 2) return null;

  const { rows } = await query<{ id: number; title: string; author_name: string | null }>(
    `
    SELECT w.id, w.title, a.name AS author_name
    FROM "Work" w
    LEFT JOIN "WorkAuthor" wa ON w.id = wa.work_id
    LEFT JOIN "Author" a ON wa.author_id = a.id
    WHERE LOWER(w.title) LIKE $1 || '%'
    LIMIT 100
    `,
    [firstWord]
  );

  if (rows.length === 0) return null;

  // Find best match using fuzzy search
  const candidates = rows.map((r) => ({
    id: r.id,
    title: r.title.toLowerCase(),
    author: r.author_name?.toLowerCase() ?? "",
  }));

  let bestMatch: { workId: number; confidence: number } | null = null;

  for (const candidate of candidates) {
    const titleSim = stringSimilarity(title, candidate.title);

    if (titleSim < 0.6) continue;

    let confidence = titleSim;

    // Boost confidence if author matches
    if (author && candidate.author) {
      const authorSim = stringSimilarity(author, candidate.author);
      if (authorSim >= 0.7) {
        confidence = Math.min(1.0, confidence + 0.1);
      }
    }

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = { workId: candidate.id, confidence };
    }
  }

  return bestMatch;
}

/**
 * Resolve multiple ISBNs in batch with single database query
 */
export async function resolveByIsbnBatch(
  isbns: string[]
): Promise<Map<string, number | null>> {
  const results = new Map<string, number | null>();
  if (isbns.length === 0) return results;

  // Normalize and deduplicate ISBNs
  const normalizedIsbns: Array<{ original: string; isbn13: string | null; isbn10: string | null }> = [];
  const allIsbnsToQuery: string[] = [];

  for (const isbn of isbns) {
    const normalized = normalizeIsbn(isbn);
    const isbn13 = normalized.isbn13 ?? (normalized.isbn10 ? isbn10ToIsbn13(normalized.isbn10) : null);
    const isbn10 = normalized.isbn10 ?? null;

    if (!isbn13 && !isbn10) {
      results.set(isbn, null);
      continue;
    }

    normalizedIsbns.push({ original: isbn, isbn13, isbn10 });

    // Check LRU cache first
    const cacheKey = `isbn:${isbn13 ?? isbn10}`;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
      results.set(isbn, cached);
    } else {
      if (isbn13) allIsbnsToQuery.push(isbn13);
      if (isbn10) allIsbnsToQuery.push(isbn10);
    }
  }

  // If everything was cached, return early
  if (allIsbnsToQuery.length === 0) return results;

  // Single batch query for all uncached ISBNs
  const { rows } = await query<{ isbn13: string | null; isbn10: string | null; work_id: number }>(
    `SELECT isbn13, isbn10, work_id FROM "Edition"
     WHERE isbn13 = ANY($1) OR isbn10 = ANY($1)`,
    [allIsbnsToQuery]
  );

  // Build lookup map from results
  const isbnToWorkId = new Map<string, number>();
  for (const row of rows) {
    if (row.isbn13) isbnToWorkId.set(row.isbn13, row.work_id);
    if (row.isbn10) isbnToWorkId.set(row.isbn10, row.work_id);
  }

  // Map back to original ISBNs and populate cache
  for (const { original, isbn13, isbn10 } of normalizedIsbns) {
    if (results.has(original)) continue; // Already cached

    const workId = (isbn13 && isbnToWorkId.get(isbn13)) || (isbn10 && isbnToWorkId.get(isbn10)) || null;
    results.set(original, workId);

    // Populate LRU cache
    const cacheKey = `isbn:${isbn13 ?? isbn10}`;
    cachePut(cacheKey, workId);
  }

  return results;
}

/**
 * Clear resolver caches (for testing/admin)
 */
export async function clearResolverCache(): Promise<void> {
  lruCache.clear();
  await query(`DELETE FROM "ResolverCache"`);
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { lruSize: number } {
  return { lruSize: lruCache.size };
}
