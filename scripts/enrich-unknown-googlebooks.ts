#!/usr/bin/env tsx
/**
 * Enrich "unknown" works (title ILIKE 'unknown%') that have ISBNs by calling Google Books directly.
 * This is a faster, targeted pass than the generic enrich:gb script and skips works without ISBNs.
 *
 * Usage:
 *   pnpm enrich:unknown-gb -- --limit 50 --concurrency 2
 */

import "dotenv/config";
import { parseArgs } from "util";
import pLimit from "p-limit";
import { query, transaction, closePool } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

const { values } = parseArgs({
  options: {
    limit: { type: "string", default: "50" }, // small batches to stay snappy
    concurrency: { type: "string", default: "2" }, // avoid rate limits
  },
  allowPositionals: true,
});

interface TargetRow {
  workId: number;
  editionId: number;
  isbn13: string | null;
  isbn10: string | null;
}

async function main() {
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  if (!apiKey) {
    logger.error("GOOGLE_BOOKS_API_KEY is required");
    process.exit(1);
  }

  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const concurrency = parseInt(values.concurrency ?? "4", 10);
  const limiter = pLimit(concurrency);
  const timer = createTimer("Unknown GB enrichment");

  const targets = await getUnknownIsbnTargets(limit);
  if (targets.length === 0) {
    logger.info("No unknown works with ISBNs found");
    await closePool();
    return;
  }

  logger.info("Enriching unknown works via Google Books", {
    count: targets.length,
    concurrency,
  });

  let enriched = 0;
  let failed = 0;

  await Promise.all(
    targets.map((t, idx) =>
      limiter(async () => {
        const isbn = t.isbn13 ?? t.isbn10;
        if (!isbn) return;
        try {
          logger.info(`[${idx + 1}/${targets.length}] Fetching ISBN ${isbn}...`);
          const volume = await fetchByIsbn(isbn, apiKey);
          if (!volume) {
            logger.info(`[${idx + 1}/${targets.length}] No result for ISBN ${isbn}`);
            return;
          }

          await applyEnrichment(t.workId, t.editionId, volume);
          enriched++;
          logger.info(`[${idx + 1}/${targets.length}] ✓ Enriched: "${volume.title}"`);
        } catch (error) {
          failed++;
          logger.warn("Failed to enrich unknown work", {
            workId: t.workId,
            editionId: t.editionId,
            isbn,
            error: String(error),
          });
        }
      })
    )
  );

  timer.end({ processed: targets.length, enriched, failed });
  const notFound = targets.length - enriched - failed;
  logger.info(`\n=== Enrichment Complete ===`);
  logger.info(`Total processed: ${targets.length}`);
  logger.info(`  ✓ Enriched: ${enriched}`);
  logger.info(`  ✗ Not found: ${notFound}`);
  logger.info(`  ⚠ Failed: ${failed}`);
  await closePool();
}

async function getUnknownIsbnTargets(limit?: number): Promise<TargetRow[]> {
  const { rows } = await query<TargetRow>(
    `
    SELECT
      w.id AS "workId",
      e.id AS "editionId",
      e.isbn13,
      e.isbn10
    FROM "Work" w
    JOIN "Edition" e ON e.work_id = w.id
    WHERE w.title ILIKE 'unknown%'
      AND (e.isbn13 IS NOT NULL OR e.isbn10 IS NOT NULL)
    ORDER BY w.id
    ${limit ? "LIMIT " + limit : ""}
    `
  );
  return rows;
}

async function fetchByIsbn(isbn: string, apiKey: string) {
  const base = "https://www.googleapis.com/books/v1/volumes";
  const url = `${base}?q=isbn:${encodeURIComponent(isbn)}&key=${apiKey}`;
  let backoff = 2000;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 5000); // 5s hard timeout per request
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(to);

      if (res.status === 429 || res.status === 503) {
        await sleep(backoff);
        backoff *= 2;
        continue;
      }
      if (!res.ok) {
        throw new Error(`Google Books error ${res.status}`);
      }

      const data = (await res.json()) as { items?: any[] };
      const item = data.items?.[0];
      if (!item?.volumeInfo) return null;
      return item.volumeInfo as {
        title?: string;
        authors?: string[];
        description?: string;
        categories?: string[];
        averageRating?: number;
        ratingsCount?: number;
        publishedDate?: string;
        pageCount?: number;
      };
    } catch (err) {
      clearTimeout(to);
      if (err instanceof DOMException && err.name === "AbortError") {
        // timed out, retry once
        continue;
      }
      throw err;
    }
  }

  return null; // give up quickly; caller will log
}

async function applyEnrichment(
  workId: number,
  editionId: number,
  volumeInfo: {
    title?: string;
    authors?: string[];
    description?: string;
    categories?: string[];
    averageRating?: number;
    ratingsCount?: number;
    publishedDate?: string;
    pageCount?: number;
  }
) {
  await transaction(async (client) => {
    if (volumeInfo.description) {
      await client.query(
        `UPDATE "Work" SET description = COALESCE(description, $2), updated_at = NOW() WHERE id = $1`,
        [workId, volumeInfo.description]
      );
    }

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
        [workId, volumeInfo.averageRating, volumeInfo.ratingsCount]
      );
    }

    if (volumeInfo.categories) {
      for (const category of volumeInfo.categories) {
        const normalized = category.toLowerCase().replace(/\s+/g, "_");
        await client.query(
          `INSERT INTO "Subject" (subject, typ) VALUES ($1, 'category') ON CONFLICT DO NOTHING`,
          [normalized]
        );
        await client.query(
          `INSERT INTO "WorkSubject" (work_id, subject) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [workId, normalized]
        );
      }
    }

    if (volumeInfo.publishedDate || volumeInfo.pageCount) {
      await client.query(
        `
        UPDATE "Edition"
        SET ol_data = COALESCE(ol_data, '{}'::jsonb) || jsonb_strip_nulls(
          jsonb_build_object(
            'publishedDate', $2::text,
            'pageCount', $3::int
          )
        )
        WHERE id = $1
        `,
        [editionId, volumeInfo.publishedDate ?? null, volumeInfo.pageCount ?? null]
      );
    }
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  logger.error("Unknown GB enrichment failed", { error: String(error) });
  process.exit(1);
});
