/**
 * Google Books API enrichment
 * Fetches additional metadata including ratings from Google Books
 */

import Bottleneck from "bottleneck";
import { query, transaction } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";
import { cachedFetch } from "@/lib/util/httpCache";
import { getEnv } from "@/lib/config/env";

export interface GoogleBooksVolume {
  id: string;
  volumeInfo: {
    title: string;
    subtitle?: string;
    authors?: string[];
    description?: string;
    publishedDate?: string;
    pageCount?: number;
    categories?: string[];
    averageRating?: number;
    ratingsCount?: number;
    language?: string;
    imageLinks?: {
      thumbnail?: string;
      smallThumbnail?: string;
    };
    industryIdentifiers?: Array<{
      type: string;
      identifier: string;
    }>;
  };
}

export interface GBSearchParams {
  title?: string;
  author?: string;
  isbn?: string;
  year?: string;
}

export interface GBSearchResult {
  volumeId: string;
  isbn13: string | null;
  isbn10: string | null;
  title: string;
  authors: string[];
  description: string | null;
  categories: string[];
  publishedDate: string | null;
  pageCount: number | null;
  coverUrl: string | null;
  averageRating: number | null;
  ratingsCount: number | null;
}

interface GoogleBooksResponse {
  totalItems: number;
  items?: GoogleBooksVolume[];
}

// Rate limiter: Conservative to avoid hitting Google's strict limits
// Google Books API allows ~100 requests per 100 seconds, but bursts trigger 429
const limiter = new Bottleneck({
  minTime: 500,        // 2 requests per second max
  maxConcurrent: 1,    // Only 1 concurrent request
  reservoir: 10,       // Start with 10 tokens
  reservoirRefreshInterval: 60000, // Refresh every minute
  reservoirRefreshAmount: 10,      // Add 10 tokens per minute (~10 req/min)
});

// Cache TTL for Google Books responses (5 days)
const CACHE_TTL_DAYS = 5;

// Retry configuration for rate limits - longer backoffs
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 30000; // Start with 30 seconds

/**
 * Thread-safe global backoff state manager.
 * Prevents race conditions when multiple requests hit rate limits.
 */
class BackoffManager {
  private backoffUntil = 0;
  private pendingWait: Promise<void> | null = null;

  /**
   * Get the current backoff timestamp.
   * Returns 0 if no backoff is active.
   */
  getBackoffUntil(): number {
    return this.backoffUntil;
  }

  /**
   * Atomically set backoff if the new time is later than current.
   * Returns true if backoff was updated.
   */
  setBackoff(untilTimestamp: number): boolean {
    if (untilTimestamp > this.backoffUntil) {
      this.backoffUntil = untilTimestamp;
      return true;
    }
    return false;
  }

  /**
   * Wait for any active backoff to expire.
   * Coalesces multiple waiters to avoid redundant waits.
   */
  async waitForBackoff(context: string): Promise<void> {
    const now = Date.now();
    if (this.backoffUntil <= now) {
      return;
    }

    // If there's already a pending wait, join it
    if (this.pendingWait) {
      await this.pendingWait;
      return;
    }

    const waitTime = this.backoffUntil - now;
    logger.debug(`Waiting for global backoff: ${Math.ceil(waitTime / 1000)}s`, { context });

    this.pendingWait = new Promise((resolve) => setTimeout(resolve, waitTime));
    try {
      await this.pendingWait;
    } finally {
      this.pendingWait = null;
    }
  }

  /**
   * Clear backoff state (useful for testing).
   */
  reset(): void {
    this.backoffUntil = 0;
    this.pendingWait = null;
  }
}

const backoffManager = new BackoffManager();

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with automatic retry on rate limit (429)
 * Uses exponential backoff starting at 30s
 * Global backoff ensures ALL requests pause when rate limited
 */
async function fetchWithRetry(
  url: string,
  context: string
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Check global backoff - if any request was rate limited, all wait
    await backoffManager.waitForBackoff(context);

    // Use rate limiter to space out requests
    const response = await limiter.schedule(() =>
      cachedFetch(url, undefined, CACHE_TTL_DAYS)
    );

    if (response.status !== 429) {
      return response;
    }

    // Rate limited - set global backoff so ALL requests pause
    const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
    const newBackoffUntil = Date.now() + backoffMs;
    backoffManager.setBackoff(newBackoffUntil);

    if (attempt < MAX_RETRIES) {
      logger.warn(`Rate limited by Google Books API, all requests paused for ${backoffMs / 1000}s`, {
        context,
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
      });
      await sleep(backoffMs);
    } else {
      lastError = new Error("Rate limited after max retries");
    }
  }

  throw lastError ?? new Error("Rate limited");
}

/**
 * Fetch volume info from Google Books API by ISBN
 * Uses database-backed HTTP caching with 5-day TTL
 */
async function fetchVolumeByIsbn(
  isbn: string,
  apiKey: string
): Promise<GoogleBooksVolume | null> {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `isbn:${isbn}`);
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetchWithRetry(url.toString(), `isbn:${isbn}`);

    if (!response.ok) {
      logger.warn("Google Books API error", { status: response.status });
      return null;
    }

    const data: GoogleBooksResponse = await response.json();

    if (!data.items || data.items.length === 0) {
      return null;
    }

    return data.items[0];
  } catch (error) {
    logger.error("Failed to fetch from Google Books", { isbn, error: String(error) });
    throw error;
  }
}

/**
 * Extract ISBN-13 from Google Books industry identifiers
 */
function extractIsbn13(volume: GoogleBooksVolume): string | null {
  const identifiers = volume.volumeInfo.industryIdentifiers;
  if (!identifiers) return null;

  const isbn13 = identifiers.find((id) => id.type === "ISBN_13");
  return isbn13?.identifier ?? null;
}

/**
 * Extract ISBN-10 from Google Books industry identifiers
 */
function extractIsbn10(volume: GoogleBooksVolume): string | null {
  const identifiers = volume.volumeInfo.industryIdentifiers;
  if (!identifiers) return null;

  const isbn10 = identifiers.find((id) => id.type === "ISBN_10");
  return isbn10?.identifier ?? null;
}

/**
 * Convert GoogleBooksVolume to GBSearchResult
 */
function volumeToSearchResult(volume: GoogleBooksVolume): GBSearchResult {
  const { volumeInfo } = volume;
  return {
    volumeId: volume.id,
    isbn13: extractIsbn13(volume),
    isbn10: extractIsbn10(volume),
    title: volumeInfo.title,
    authors: volumeInfo.authors ?? [],
    description: volumeInfo.description ?? null,
    categories: volumeInfo.categories ?? [],
    publishedDate: volumeInfo.publishedDate ?? null,
    pageCount: volumeInfo.pageCount ?? null,
    coverUrl: volumeInfo.imageLinks?.thumbnail ?? null,
    averageRating: volumeInfo.averageRating ?? null,
    ratingsCount: volumeInfo.ratingsCount ?? null,
  };
}

/**
 * Search Google Books by title and/or author
 * Uses intitle: and inauthor: query operators for better matching
 *
 * @param params Search parameters (title, author, isbn, year)
 * @returns Best matching result or null
 */
export async function searchGoogleBooks(params: GBSearchParams): Promise<GBSearchResult | null> {
  const queryParts: string[] = [];

  // ISBN search takes priority (more precise)
  if (params.isbn) {
    queryParts.push(`isbn:${params.isbn}`);
  } else {
    // Title/author search with operators
    if (params.title) {
      // Escape quotes in title and wrap for exact phrase matching
      const escapedTitle = params.title.replace(/"/g, "");
      queryParts.push(`intitle:"${escapedTitle}"`);
    }
    if (params.author) {
      const escapedAuthor = params.author.replace(/"/g, "");
      queryParts.push(`inauthor:"${escapedAuthor}"`);
    }
  }

  if (queryParts.length === 0) {
    return null;
  }

  const apiKey = getEnv().GOOGLE_BOOKS_API_KEY;
  if (!apiKey) {
    logger.warn("GOOGLE_BOOKS_API_KEY not configured");
    return null;
  }

  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", queryParts.join("+"));
  url.searchParams.set("maxResults", "5");
  url.searchParams.set("key", apiKey);

  const context = params.isbn
    ? `isbn:${params.isbn}`
    : `title:${params.title?.slice(0, 30)}`;

  try {
    const response = await fetchWithRetry(url.toString(), context);

    if (!response.ok) {
      logger.warn("Google Books API error", { status: response.status });
      return null;
    }

    const data: GoogleBooksResponse = await response.json();

    if (!data.items || data.items.length === 0) {
      return null;
    }

    // Rank results: prefer English, prefer those with ISBNs
    const ranked = data.items
      .filter((v) => {
        const lang = v.volumeInfo.language ?? "en";
        return lang.startsWith("en");
      })
      .sort((a, b) => {
        // Prefer items with ISBN-13
        const aHasIsbn = a.volumeInfo.industryIdentifiers?.some((x) => x.type === "ISBN_13") ? 1 : 0;
        const bHasIsbn = b.volumeInfo.industryIdentifiers?.some((x) => x.type === "ISBN_13") ? 1 : 0;
        return bHasIsbn - aHasIsbn;
      });

    const best = ranked[0];
    if (!best) {
      return null;
    }

    return volumeToSearchResult(best);
  } catch (error) {
    logger.error("Failed to search Google Books", {
      params,
      error: String(error),
    });
    throw error;
  }
}

/**
 * Fetch a specific Google Books volume by ID
 */
export async function fetchGoogleBooksById(volumeId: string): Promise<GBSearchResult | null> {
  const apiKey = getEnv().GOOGLE_BOOKS_API_KEY;
  if (!apiKey) {
    logger.warn("GOOGLE_BOOKS_API_KEY not configured");
    return null;
  }

  const url = `https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(volumeId)}?key=${apiKey}`;

  try {
    const response = await fetchWithRetry(url, `volumeId:${volumeId}`);

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      logger.warn("Google Books API error", { status: response.status, volumeId });
      return null;
    }

    const volume: GoogleBooksVolume = await response.json();
    return volumeToSearchResult(volume);
  } catch (error) {
    logger.error("Failed to fetch Google Books volume", {
      volumeId,
      error: String(error),
    });
    throw error;
  }
}

/**
 * Enrich works with Google Books data
 * Fetches ratings, descriptions, and categories for works missing this data
 */
export async function enrichFromGoogleBooks(options: {
  apiKey: string;
  maxItems?: number;
  onlyMissingRatings?: boolean;
}): Promise<{ enriched: number; failed: number }> {
  const { apiKey, maxItems = 10000, onlyMissingRatings = true } = options;

  logger.info("Starting Google Books enrichment", { maxItems });
  const timer = createTimer("Google Books enrichment");

  // Get editions with ISBNs that need enrichment
  let whereClause = "";
  if (onlyMissingRatings) {
    whereClause = `
      AND NOT EXISTS (
        SELECT 1 FROM "Rating" r
        WHERE r.work_id = e.work_id AND r.source = 'googlebooks'
      )
    `;
  }

  const { rows: editions } = await query<{
    edition_id: number;
    work_id: number;
    isbn13: string;
  }>(
    `
    SELECT e.id AS edition_id, e.work_id, e.isbn13
    FROM "Edition" e
    WHERE e.isbn13 IS NOT NULL
    ${whereClause}
    LIMIT $1
    `,
    [maxItems]
  );

  logger.info(`Found ${editions.length} editions to enrich`);

  let enriched = 0;
  let failed = 0;

  for (const edition of editions) {
    try {
      const volume = await limiter.schedule(() =>
        fetchVolumeByIsbn(edition.isbn13, apiKey)
      );

      if (!volume) {
        failed++;
        continue;
      }

      const { volumeInfo } = volume;

      await transaction(async (client) => {
        // Insert/update rating
        if (volumeInfo.averageRating && volumeInfo.ratingsCount) {
          await client.query(
            `
            INSERT INTO "Rating" (work_id, source, avg, count, last_updated)
            VALUES ($1, 'googlebooks', $2, $3, NOW())
            ON CONFLICT (work_id, source) DO UPDATE SET
              avg = EXCLUDED.avg,
              count = EXCLUDED.count,
              last_updated = NOW()
            `,
            [edition.work_id, volumeInfo.averageRating, volumeInfo.ratingsCount]
          );
        }

        // Update work description if missing
        if (volumeInfo.description) {
          await client.query(
            `
            UPDATE "Work"
            SET description = $2, updated_at = NOW()
            WHERE id = $1 AND description IS NULL
            `,
            [edition.work_id, volumeInfo.description]
          );
        }

        // Add categories as subjects
        if (volumeInfo.categories) {
          for (const category of volumeInfo.categories) {
            const normalized = category.toLowerCase().replace(/\s+/g, "_");

            await client.query(
              `INSERT INTO "Subject" (subject, typ) VALUES ($1, 'category') ON CONFLICT (subject) DO NOTHING`,
              [normalized]
            );

            await client.query(
              `
              INSERT INTO "WorkSubject" (work_id, subject) VALUES ($1, $2)
              ON CONFLICT (work_id, subject) DO NOTHING
              `,
              [edition.work_id, normalized]
            );
          }
        }
      });

      enriched++;

      if (enriched % 100 === 0) {
        logger.info(`Enriched ${enriched} works`);
      }
    } catch (error) {
      failed++;
      logger.warn("Failed to enrich edition", {
        editionId: edition.edition_id,
        error: String(error),
      });

      // If rate limited, wait longer
      if (String(error).includes("Rate limited")) {
        await new Promise((resolve) => setTimeout(resolve, 60000));
      }
    }
  }

  timer.end({ enriched, failed });
  return { enriched, failed };
}
