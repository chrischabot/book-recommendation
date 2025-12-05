#!/usr/bin/env tsx
/**
 * Re-enrich Kindle ASINs by re-running resolverV2.
 * Useful to clean up "Unknown" titles or fix earlier duplicate ASIN conflicts.
 *
 * Usage:
 *   pnpm kindle:enrich -- --user me --limit 500 --concurrency 6
 */

import "dotenv/config";
import { parseArgs } from "util";
import pLimit from "p-limit";
import { query, closePool } from "@/lib/db/pool";
import { resolveWork } from "@/lib/ingest/resolverV2";
import { invalidateUserCaches } from "@/lib/features/cache";
import { logger, createTimer } from "@/lib/util/logger";

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    user: { type: "string", default: "me" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "6" },
  },
});

async function main() {
  const userId = values.user!;
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const concurrency = parseInt(values.concurrency ?? "6", 10);
  const limiter = pLimit(concurrency);

  logger.info("Starting Kindle ASIN re-enrichment", { userId, limit, concurrency });
  const timer = createTimer("Kindle re-enrich");

  const { rows } = await query<{ asin: string; product_name: string | null }>(
    `
    SELECT asin, product_name
    FROM "KindleOwnership"
    WHERE user_id = $1
    ORDER BY acquired_at DESC NULLS LAST
    ${limit ? "LIMIT " + limit : ""}
    `,
    [userId]
  );

  let resolved = 0;
  let failed = 0;

  await Promise.all(
    rows.map((row) =>
      limiter(async () => {
        try {
          await resolveWork({
            asin: row.asin,
            title: row.product_name || undefined,
            author: "",
          });
          resolved++;
        } catch (error) {
          failed++;
          logger.warn("Re-enrich failed", { asin: row.asin, error: String(error) });
        }
      })
    )
  );

  await invalidateUserCaches(userId);
  await closePool();

  timer.end({ processed: rows.length, resolved, failed });
  logger.info("Kindle re-enrichment complete", { processed: rows.length, resolved, failed });
}

main().catch((error) => {
  logger.error("Re-enrichment failed", { error: String(error) });
  process.exit(1);
});
