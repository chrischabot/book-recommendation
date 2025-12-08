#!/usr/bin/env tsx
/**
 * Enrich descriptions for works that have embeddings but missing descriptions.
 *
 * Fetches from Open Library API first, then falls back to Google Books.
 * Only processes works that already have embeddings (~305k quality works).
 *
 * Usage:
 *   pnpm enrich:descriptions
 *   pnpm enrich:descriptions -- --batch 100
 *   pnpm enrich:descriptions -- --limit 1000  # Stop after N works
 */

import "dotenv/config";

import { parseArgs } from "util";
import Bottleneck from "bottleneck";
import { query, transaction } from "@/lib/db/pool";
import { closePool } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

const { values } = parseArgs({
  options: {
    batch: { type: "string", default: "50" },
    limit: { type: "string" },
  },
  allowPositionals: true,
});

// Rate limiters for external APIs
const olLimiter = new Bottleneck({
  minTime: 100, // 10 requests per second for Open Library
  maxConcurrent: 5,
});

const gbLimiter = new Bottleneck({
  minTime: 200, // 5 requests per second for Google Books (more conservative)
  maxConcurrent: 3,
});

interface WorkForEnrichment {
  id: number;
  title: string;
  olWorkKey: string | null;
  authorName: string | null;
}

/**
 * Get works that have embeddings but no description
 * Prioritizes works most similar to user's reading history (most likely to be recommended)
 */
async function getWorksNeedingDescriptions(
  limit: number
): Promise<WorkForEnrichment[]> {
  // First, try to prioritize by similarity to user's anchor books
  const { rows } = await query<{
    id: number;
    title: string;
    ol_work_key: string | null;
    author_name: string | null;
  }>(
    `
    WITH user_profile AS (
      SELECT profile_vec FROM "UserProfile" WHERE user_id = 'me' LIMIT 1
    )
    SELECT
      w.id,
      w.title,
      w.ol_work_key,
      (
        SELECT a.name
        FROM "WorkAuthor" wa
        JOIN "Author" a ON wa.author_id = a.id
        WHERE wa.work_id = w.id
        LIMIT 1
      ) AS author_name
    FROM "Work" w
    WHERE w.embedding IS NOT NULL
      AND (w.description IS NULL OR w.description = '')
      AND NOT EXISTS (SELECT 1 FROM "UserEvent" ue WHERE ue.work_id = w.id AND ue.user_id = 'me')
    ORDER BY
      CASE WHEN EXISTS (SELECT 1 FROM user_profile)
           THEN w.embedding <=> (SELECT profile_vec FROM user_profile)
           ELSE w.id::float END
    LIMIT $1
    `,
    [limit]
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    olWorkKey: r.ol_work_key,
    authorName: r.author_name,
  }));
}

/**
 * Clean and format description text
 */
function formatDescription(text: string): string {
  let result = text;

  // Convert HTML tags to newlines
  result = result.replace(/<br\s*\/?>/gi, "\n");
  result = result.replace(/<\/p>\s*<p>/gi, "\n\n");
  result = result.replace(/<\/?p>/gi, "\n");
  result = result.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  result = result
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Normalize whitespace
  result = result.replace(/[ \t]+/g, " ");
  result = result.replace(/\n /g, "\n");
  result = result.replace(/ \n/g, "\n");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Fetch description from Open Library work API
 */
async function fetchFromOpenLibrary(olWorkKey: string): Promise<string | null> {
  try {
    const response = await olLimiter.schedule(() =>
      fetch(`https://openlibrary.org/works/${olWorkKey}.json`)
    );

    if (!response.ok) return null;

    const data = await response.json();

    let description: string | null = null;
    if (typeof data.description === "string") {
      description = data.description;
    } else if (data.description?.value) {
      description = data.description.value;
    }

    return description ? formatDescription(description) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch description from Google Books API
 */
async function fetchFromGoogleBooks(
  title: string,
  authorName: string | null
): Promise<string | null> {
  try {
    let searchQuery = `intitle:${encodeURIComponent(title)}`;
    if (authorName) {
      searchQuery += `+inauthor:${encodeURIComponent(authorName)}`;
    }

    const response = await gbLimiter.schedule(() =>
      fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${searchQuery}&maxResults=1`
      )
    );

    if (!response.ok) return null;

    const data = await response.json();
    const book = data.items?.[0];

    if (book?.volumeInfo?.description) {
      return formatDescription(book.volumeInfo.description);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch description for a work, trying Open Library first, then Google Books
 */
async function fetchDescription(work: WorkForEnrichment): Promise<string | null> {
  // Try Open Library first if we have a work key
  if (work.olWorkKey) {
    const olDescription = await fetchFromOpenLibrary(work.olWorkKey);
    if (olDescription) {
      return olDescription;
    }
  }

  // Fall back to Google Books
  const gbDescription = await fetchFromGoogleBooks(work.title, work.authorName);
  return gbDescription;
}

async function main() {
  const batchSize = parseInt(values.batch!, 10);
  const maxLimit = values.limit ? parseInt(values.limit, 10) : undefined;

  // Get count of works needing descriptions
  const { rows: countRows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM "Work" WHERE embedding IS NOT NULL AND description IS NULL`
  );
  const totalNeeding = parseInt(countRows[0]?.count ?? "0", 10);

  logger.info("Starting description enrichment", {
    batchSize,
    maxLimit,
    totalNeeding,
  });

  const timer = createTimer("Description enrichment");

  let processed = 0;
  let enriched = 0;
  let failed = 0;

  while (true) {
    // Check if we've hit the limit
    if (maxLimit && processed >= maxLimit) {
      logger.info("Reached limit", { processed, maxLimit });
      break;
    }

    const remaining = maxLimit ? Math.min(batchSize, maxLimit - processed) : batchSize;
    const works = await getWorksNeedingDescriptions(remaining);

    if (works.length === 0) {
      logger.info("No more works need descriptions");
      break;
    }

    // Process batch concurrently
    const results = await Promise.all(
      works.map(async (work) => {
        try {
          const description = await fetchDescription(work);
          return { work, description };
        } catch (error) {
          logger.warn(`Failed to fetch description for work ${work.id}`, {
            error: String(error),
          });
          return { work, description: null };
        }
      })
    );

    // Update database with results
    await transaction(async (client) => {
      for (const { work, description } of results) {
        if (description) {
          await client.query(
            `UPDATE "Work" SET description = $1, updated_at = NOW() WHERE id = $2`,
            [description, work.id]
          );
          enriched++;
        } else {
          // Mark as processed (set empty string) so we don't retry forever
          // Use a sentinel value to indicate we tried but found nothing
          await client.query(
            `UPDATE "Work" SET description = '', updated_at = NOW() WHERE id = $1`,
            [work.id]
          );
          failed++;
        }
      }
    });

    processed += works.length;
    const progress = ((processed / totalNeeding) * 100).toFixed(1);
    logger.info(`Progress: ${processed}/${totalNeeding} (${progress}%)`, {
      enriched,
      failed,
    });
  }

  timer.end({ processed, enriched, failed });
  await closePool();
}

main().catch((error) => {
  logger.error("Description enrichment failed", { error: String(error) });
  process.exit(1);
});
