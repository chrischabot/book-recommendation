/**
 * Work enrichment pipeline
 * Backfills missing data for stub Works from Google Books
 */

import { query, transaction } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";
import { searchGoogleBooks, type GBSearchResult } from "./googlebooks";
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
}

/**
 * Find works that need enrichment
 * Priority: stubs first, then works missing description/cover
 */
export async function findWorksToEnrich(options: {
  limit?: number;
  stubsOnly?: boolean;
}): Promise<WorkToEnrich[]> {
  const { limit = 100, stubsOnly = false } = options;

  let whereClause = "w.is_stub = true";
  if (!stubsOnly) {
    whereClause = `(w.is_stub = true OR w.description IS NULL OR e.cover_url IS NULL)`;
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
     ORDER BY w.is_stub DESC, w.created_at ASC
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
  };

  // Search Google Books by ISBN first, then title/author
  let gbData: GBSearchResult | null = null;

  if (work.isbn13 || work.isbn10) {
    gbData = await searchGoogleBooks({
      isbn: work.isbn13 || work.isbn10 || undefined,
    });
  }

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
    if (gbData!.description && !work.hasDescription) {
      await client.query(
        `UPDATE "Work" SET
           description = $2,
           is_stub = FALSE,
           stub_reason = NULL,
           updated_at = NOW()
         WHERE id = $1 AND description IS NULL`,
        [work.workId, gbData!.description]
      );
      result.descriptionAdded = true;
    }

    // Update first_publish_year if missing
    if (gbData!.publishedDate) {
      const yearMatch = gbData!.publishedDate.match(/\b(19|20)\d{2}\b/);
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
    if (!work.hasCover && gbData!.coverUrl) {
      await client.query(
        `UPDATE "Edition" SET
           cover_url = COALESCE(cover_url, $2),
           google_volume_id = COALESCE(google_volume_id, $3),
           page_count = COALESCE(page_count, $4)
         WHERE work_id = $1`,
        [work.workId, gbData!.coverUrl, gbData!.volumeId, gbData!.pageCount]
      );
      result.coverAdded = true;
    }

    // Add categories as subjects
    if (gbData!.categories && gbData!.categories.length > 0) {
      for (const category of gbData!.categories) {
        const normalized = category
          .toLowerCase()
          .replace(/\s+/g, "_")
          .replace(/[^a-z0-9_]/g, "");

        if (!normalized) continue;

        await client.query(
          `INSERT INTO "Subject" (subject, typ) VALUES ($1, 'category')
           ON CONFLICT DO NOTHING`,
          [normalized]
        );

        const { rowCount } = await client.query(
          `INSERT INTO "WorkSubject" (work_id, subject) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [work.workId, normalized]
        );

        if (rowCount && rowCount > 0) {
          result.categoriesAdded++;
        }
      }
    }

    // Add Google Books rating
    if (gbData!.averageRating && gbData!.ratingsCount) {
      await client.query(
        `INSERT INTO "Rating" (work_id, source, avg, count, last_updated)
         VALUES ($1, 'googlebooks', $2, $3, NOW())
         ON CONFLICT (work_id, source) DO UPDATE SET
           avg = EXCLUDED.avg,
           count = EXCLUDED.count,
           last_updated = NOW()`,
        [work.workId, gbData!.averageRating, gbData!.ratingsCount]
      );
      result.ratingsAdded = true;
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
    result.ratingsAdded;

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
  delayMs?: number;
}): Promise<{
  total: number;
  enriched: number;
  failed: number;
  descriptions: number;
  covers: number;
  ratings: number;
}> {
  const { limit = 100, stubsOnly = false, delayMs = 1000 } = options;

  logger.info("Starting work enrichment", { limit, stubsOnly });
  const timer = createTimer("Work enrichment");

  const stats = {
    total: 0,
    enriched: 0,
    failed: 0,
    descriptions: 0,
    covers: 0,
    ratings: 0,
  };

  const works = await findWorksToEnrich({ limit, stubsOnly });
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
