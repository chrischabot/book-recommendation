#!/usr/bin/env tsx
/**
 * Deduplicate Works that share the same ASIN.
 *
 * Chooses the lowest work_id as canonical and merges others into it.
 *
 * Usage:
 *   pnpm kindle:dedupe
 */

import "dotenv/config";
import pLimit from "p-limit";
import { query, closePool } from "@/lib/db/pool";
import { mergeWorks } from "@/lib/ingest/resolverV2/merge";
import { logger, createTimer } from "@/lib/util/logger";

const CONCURRENCY = 2;

async function main() {
  logger.info("Starting Kindle ASIN dedupe");
  const timer = createTimer("Kindle dedupe");

  const { rows } = await query<{ asin: string; work_ids: number[] }>(
    `
    SELECT asin, ARRAY_AGG(DISTINCT work_id ORDER BY work_id) AS work_ids
    FROM "Edition"
    WHERE asin IS NOT NULL
    GROUP BY asin
    HAVING COUNT(DISTINCT work_id) > 1
    ORDER BY asin
    `
  );

  if (rows.length === 0) {
    logger.info("No duplicate ASINs found");
    await closePool();
    return;
  }

  const limiter = pLimit(CONCURRENCY);
  let merged = 0;
  let errors = 0;

  await Promise.all(
    rows.map((row) =>
      limiter(async () => {
        const canonical = row.work_ids[0];
        const duplicates = row.work_ids.slice(1);

        for (const from of duplicates) {
          try {
            await mergeWorks(from, canonical, `Duplicate ASIN ${row.asin}`);
            merged++;
          } catch (error) {
            errors++;
            logger.error("Failed to merge duplicate work", {
              asin: row.asin,
              fromWorkId: from,
              toWorkId: canonical,
              error: String(error),
            });
          }
        }
      })
    )
  );

  await closePool();
  timer.end({ duplicates: rows.length, merged, errors });
  logger.info("Kindle dedupe complete", { duplicates: rows.length, merged, errors });
}

main().catch((error) => {
  logger.error("Kindle dedupe failed", { error: String(error) });
  process.exit(1);
});
