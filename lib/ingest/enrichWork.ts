/**
 * Work enrichment pipeline
 * Backfills missing data for stub Works from Google Books
 */

import { query, transaction } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";
import { searchGoogleBooks, fetchGoogleBooksById, type GBSearchResult } from "./googlebooks";
import { STUB_THRESHOLD } from "./resolverV2/types";

interface WorkToEnrich {
  workId: number;
  title: string;
  authorName: string | null;
  isbn13: string | null;
  isbn10: string | null;
  googleVolumeId: string | null;
  hasDescription: boolean;
  hasCover: boolean;
}

interface EnrichmentResult {
  workId: number;
  enriched: boolean;
  descriptionAdded: boolean;
  coverAdded: boolean;
  categoriesAdded: number;
  ratingsAdded: boolean;
  authorsAdded: number;
}

/**
 * Find works that need enrichment
 * Priority: stubs first, then works missing description/cover/authors
 */
export async function findWorksToEnrich(options: {
  limit?: number;
  stubsOnly?: boolean;
  missingAuthorsOnly?: boolean;
  userBooksOnly?: boolean;
  userId?: string;
}): Promise<WorkToEnrich[]> {
  const { limit = 100, stubsOnly = false, missingAuthorsOnly = false, userBooksOnly = false, userId = "me" } = options;

  let whereClause = "w.is_stub = true";
  if (missingAuthorsOnly) {
    // Find works that have no authors linked
    whereClause = `NOT EXISTS (SELECT 1 FROM "WorkAuthor" wa WHERE wa.work_id = w.id)`;
  } else if (!stubsOnly) {
    whereClause = `(w.is_stub = true OR w.description IS NULL OR e.cover_url IS NULL)`;
  }

  // Optionally filter to only user's books
  if (userBooksOnly) {
    whereClause = `(${whereClause}) AND EXISTS (SELECT 1 FROM "UserEvent" ue WHERE ue.work_id = w.id AND ue.user_id = '${userId}')`;
  }

  const { rows } = await query<{
    work_id: number;
    title: string;
    author_name: string | null;
    isbn13: string | null;
    isbn10: string | null;
    google_volume_id: string | null;
    has_description: boolean;
    has_cover: boolean;
  }>(
    `SELECT
       w.id as work_id,
       w.title,
       a.name as author_name,
       e.isbn13,
       e.isbn10,
       e.google_volume_id,
       (w.description IS NOT NULL) as has_description,
       (e.cover_url IS NOT NULL OR e.cover_id IS NOT NULL) as has_cover
     FROM "Work" w
     LEFT JOIN "Edition" e ON e.work_id = w.id
     LEFT JOIN "WorkAuthor" wa ON wa.work_id = w.id
     LEFT JOIN "Author" a ON a.id = wa.author_id
     WHERE ${whereClause}
     ORDER BY
       -- Prioritize works with identifiers (higher success rate)
       CASE WHEN e.google_volume_id IS NOT NULL THEN 0
            WHEN e.isbn13 IS NOT NULL OR e.isbn10 IS NOT NULL THEN 1
            ELSE 2 END,
       w.is_stub DESC,
       w.created_at ASC
     LIMIT $1`,
    [limit]
  );

  return rows.map((r) => ({
    workId: r.work_id,
    title: r.title,
    authorName: r.author_name,
    isbn13: r.isbn13,
    isbn10: r.isbn10,
    googleVolumeId: r.google_volume_id,
    hasDescription: r.has_description,
    hasCover: r.has_cover,
  }));
}

/**
 * Enrich a single work from Google Books
 */
export async function enrichWork(work: WorkToEnrich): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    workId: work.workId,
    enriched: false,
    descriptionAdded: false,
    coverAdded: false,
    categoriesAdded: 0,
    ratingsAdded: false,
    authorsAdded: 0,
  };

  // Search Google Books: volume ID > ISBN > title/author
  let gbData: GBSearchResult | null = null;

  // Try direct volume ID lookup first (most reliable)
  if (work.googleVolumeId) {
    gbData = await fetchGoogleBooksById(work.googleVolumeId);
  }

  // Fall back to ISBN search
  if (!gbData && (work.isbn13 || work.isbn10)) {
    gbData = await searchGoogleBooks({
      isbn: work.isbn13 || work.isbn10 || undefined,
    });
  }

  // Fall back to title/author search
  if (!gbData && work.title) {
    gbData = await searchGoogleBooks({
      title: work.title,
      author: work.authorName || undefined,
    });
  }

  if (!gbData) {
    logger.debug("No Google Books match for work", {
      workId: work.workId,
      title: work.title,
    });
    return result;
  }

  // Update work and edition with enriched data
  await transaction(async (client) => {
    // Update Work description and remove stub flag if enriched
    if (gbData.description && !work.hasDescription) {
      await client.query(
        `UPDATE "Work" SET
           description = $2,
           is_stub = FALSE,
           stub_reason = NULL,
           updated_at = NOW()
         WHERE id = $1 AND description IS NULL`,
        [work.workId, gbData.description]
      );
      result.descriptionAdded = true;
    }

    // Update first_publish_year if missing
    if (gbData.publishedDate) {
      const yearMatch = gbData.publishedDate.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) {
        await client.query(
          `UPDATE "Work" SET
             first_publish_year = COALESCE(first_publish_year, $2),
             updated_at = NOW()
           WHERE id = $1`,
          [work.workId, parseInt(yearMatch[0], 10)]
        );
      }
    }

    // Update Edition with cover and identifiers
    if (!work.hasCover && gbData.coverUrl) {
      await client.query(
        `UPDATE "Edition" SET
           cover_url = COALESCE(cover_url, $2),
           google_volume_id = COALESCE(google_volume_id, $3),
           page_count = COALESCE(page_count, $4)
         WHERE work_id = $1`,
        [work.workId, gbData.coverUrl, gbData.volumeId, gbData.pageCount]
      );
      result.coverAdded = true;
    }

    // Add categories as subjects
    if (gbData.categories && gbData.categories.length > 0) {
      for (const category of gbData.categories) {
        const normalized = category
          .toLowerCase()
          .replace(/\s+/g, "_")
          .replace(/[^a-z0-9_]/g, "");

        if (!normalized) continue;

        await client.query(
          `INSERT INTO "Subject" (subject, typ) VALUES ($1, 'category')
           ON CONFLICT (subject) DO NOTHING`,
          [normalized]
        );

        const { rowCount } = await client.query(
          `INSERT INTO "WorkSubject" (work_id, subject) VALUES ($1, $2)
           ON CONFLICT (work_id, subject) DO NOTHING`,
          [work.workId, normalized]
        );

        if (rowCount && rowCount > 0) {
          result.categoriesAdded++;
        }
      }
    }

    // Add Google Books rating
    if (gbData.averageRating && gbData.ratingsCount) {
      await client.query(
        `INSERT INTO "Rating" (work_id, source, avg, count, last_updated)
         VALUES ($1, 'googlebooks', $2, $3, NOW())
         ON CONFLICT (work_id, source) DO UPDATE SET
           avg = EXCLUDED.avg,
           count = EXCLUDED.count,
           last_updated = NOW()`,
        [work.workId, gbData.averageRating, gbData.ratingsCount]
      );
      result.ratingsAdded = true;
    }

    // Add authors from Google Books
    if (gbData.authors && gbData.authors.length > 0) {
      for (const authorName of gbData.authors) {
        const trimmedName = authorName.trim();
        if (!trimmedName) continue;

        // Find or create author
        let authorId: number | null = null;
        const { rows: existingAuthors } = await client.query<{ id: number }>(
          `SELECT id FROM "Author" WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [trimmedName]
        );

        if (existingAuthors.length > 0) {
          authorId = existingAuthors[0].id;
        } else {
          const { rows: newAuthor } = await client.query<{ id: number }>(
            `INSERT INTO "Author" (name, created_at) VALUES ($1, NOW()) RETURNING id`,
            [trimmedName]
          );
          authorId = newAuthor[0]?.id ?? null;
        }

        if (authorId) {
          // Link author to work
          const { rowCount } = await client.query(
            `INSERT INTO "WorkAuthor" (work_id, author_id, role)
             VALUES ($1, $2, 'author')
             ON CONFLICT (work_id, author_id, role) DO NOTHING`,
            [work.workId, authorId]
          );

          if (rowCount && rowCount > 0) {
            result.authorsAdded++;
          }
        }
      }
    }

    // Clear stub status if we got meaningful data
    if (result.descriptionAdded || result.coverAdded) {
      await client.query(
        `UPDATE "Work" SET is_stub = FALSE, stub_reason = NULL WHERE id = $1`,
        [work.workId]
      );
    }
  });

  result.enriched =
    result.descriptionAdded ||
    result.coverAdded ||
    result.categoriesAdded > 0 ||
    result.ratingsAdded ||
    result.authorsAdded > 0;

  if (result.enriched) {
    logger.debug("Enriched work from Google Books", {
      title: work.title,
      ...result,
    });
  }

  return result;
}

/**
 * Batch enrich works needing data
 */
export async function enrichWorks(options: {
  limit?: number;
  stubsOnly?: boolean;
  missingAuthorsOnly?: boolean;
  userBooksOnly?: boolean;
  userId?: string;
  delayMs?: number;
}): Promise<{
  total: number;
  enriched: number;
  failed: number;
  descriptions: number;
  covers: number;
  ratings: number;
  authors: number;
}> {
  const { limit = 100, stubsOnly = false, missingAuthorsOnly = false, userBooksOnly = false, userId = "me", delayMs = 1000 } = options;

  logger.info("Starting work enrichment", { limit, stubsOnly, missingAuthorsOnly, userBooksOnly });
  const timer = createTimer("Work enrichment");

  const stats = {
    total: 0,
    enriched: 0,
    failed: 0,
    descriptions: 0,
    covers: 0,
    ratings: 0,
    authors: 0,
  };

  const works = await findWorksToEnrich({ limit, stubsOnly, missingAuthorsOnly, userBooksOnly, userId });
  stats.total = works.length;

  logger.info(`Found ${works.length} works to enrich`);

  for (const work of works) {
    try {
      const result = await enrichWork(work);

      if (result.enriched) {
        stats.enriched++;
        if (result.descriptionAdded) stats.descriptions++;
        if (result.coverAdded) stats.covers++;
        if (result.ratingsAdded) stats.ratings++;
        stats.authors += result.authorsAdded;
      }

      // Rate limit to avoid hitting Google Books API limits
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      stats.failed++;
      logger.warn("Failed to enrich work", {
        workId: work.workId,
        title: work.title,
        error: String(error),
      });

      // If rate limited, wait longer
      if (String(error).includes("Rate limited")) {
        await new Promise((resolve) => setTimeout(resolve, 60000));
      }
    }
  }

  timer.end(stats);
  return stats;
}

/**
 * Get enrichment statistics
 */
export async function getEnrichmentStats(): Promise<{
  totalWorks: number;
  stubs: number;
  missingDescription: number;
  missingCover: number;
  withGoogleRatings: number;
}> {
  const { rows } = await query<{
    total_works: string;
    stubs: string;
    missing_description: string;
    missing_cover: string;
    with_google_ratings: string;
  }>(
    `SELECT
       COUNT(*) as total_works,
       COUNT(*) FILTER (WHERE is_stub = true) as stubs,
       COUNT(*) FILTER (WHERE description IS NULL) as missing_description,
       (SELECT COUNT(DISTINCT work_id) FROM "Edition" WHERE cover_url IS NULL AND cover_id IS NULL) as missing_cover,
       (SELECT COUNT(DISTINCT work_id) FROM "Rating" WHERE source = 'googlebooks') as with_google_ratings
     FROM "Work"`
  );

  const row = rows[0];
  return {
    totalWorks: parseInt(row.total_works, 10),
    stubs: parseInt(row.stubs, 10),
    missingDescription: parseInt(row.missing_description, 10),
    missingCover: parseInt(row.missing_cover, 10),
    withGoogleRatings: parseInt(row.with_google_ratings, 10),
  };
}
