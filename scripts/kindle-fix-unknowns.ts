#!/usr/bin/env tsx
/**
 * Fix Works with unknown/placeholder titles using KindleOwnership product names.
 * Optionally reruns resolver to enrich metadata.
 *
 * Usage:
 *   pnpm kindle:fix-unknowns -- --limit 500 --enrich
 */

import "dotenv/config";
import { parseArgs } from "util";
import pLimit from "p-limit";
import { query, transaction, closePool } from "@/lib/db/pool";
import { resolveWork } from "@/lib/ingest/resolverV2";
import { logger, createTimer } from "@/lib/util/logger";

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string" },
    enrich: { type: "boolean", default: false },
    concurrency: { type: "string", default: "6" },
  },
});

interface UnknownRow {
  work_id: number;
  asin: string;
  product_name: string;
}

async function main() {
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const enrich = values.enrich;
  const concurrency = parseInt(values.concurrency ?? "6", 10);
  const limiter = pLimit(concurrency);

  logger.info("Fixing unknown Kindle titles", { limit, enrich, concurrency });
  const timer = createTimer("Fix unknown titles");

  const unknownRows = await fetchUnknowns(limit);
  if (unknownRows.length === 0) {
    logger.info("No unknown Kindle titles found");
    await closePool();
    return;
  }

  let updated = 0;
  let enriched = 0;
  let failures = 0;

  await Promise.all(
    unknownRows.map((row) =>
      limiter(async () => {
        try {
          await setWorkTitle(row.work_id, row.product_name);
          updated++;
          if (enrich) {
            await resolveWork({
              asin: row.asin,
              title: row.product_name,
              author: "",
            });
            enriched++;
          }
        } catch (error) {
          failures++;
          logger.warn("Failed to fix title", {
            workId: row.work_id,
            asin: row.asin,
            error: String(error),
          });
        }
      })
    )
  );

  await closePool();
  timer.end({ processed: unknownRows.length, updated, enriched, failures });
  logger.info("Unknown title fix complete", {
    processed: unknownRows.length,
    updated,
    enriched,
    failures,
  });
}

async function fetchUnknowns(limit?: number): Promise<UnknownRow[]> {
  const { rows } = await query<UnknownRow>(
    `
    SELECT DISTINCT ON (w.id)
      w.id AS work_id,
      e.asin,
      ko.product_name
    FROM "Work" w
    JOIN "Edition" e ON e.work_id = w.id
    JOIN "KindleOwnership" ko ON ko.asin = e.asin
    WHERE w.source = 'amazon'
      AND w.title ILIKE 'unknown%'
      AND ko.product_name IS NOT NULL
      AND ko.product_name NOT ILIKE 'not available%'
    ORDER BY w.id, ko.acquired_at DESC NULLS LAST
    ${limit ? "LIMIT " + limit : ""}
    `
  );
  return rows;
}

async function setWorkTitle(workId: number, title: string): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `
      UPDATE "Work"
      SET title = $2,
          is_stub = FALSE,
          stub_reason = NULL,
          updated_at = NOW()
      WHERE id = $1
      `,
      [workId, title]
    );
  });
}

main().catch((error) => {
  logger.error("Fix unknown titles failed", { error: String(error) });
  process.exit(1);
});
