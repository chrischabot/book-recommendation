#!/usr/bin/env tsx
/**
 * Refresh materialized views and compute quality scores
 *
 * This script:
 * 1. Refreshes WorkPopularity materialized view
 * 2. Refreshes WorkOLRating materialized view
 * 3. Populates Rating table from OL ratings
 * 4. Computes blended quality scores
 *
 * Usage:
 *   pnpm refresh:views
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { refreshMaterializedViews } from "@/lib/ingest/openlibrary";
import { computeWorkQuality } from "@/lib/features/ratings";
import { closePool } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

async function main() {
  const timer = createTimer("Refresh views and quality");

  logger.info("Starting materialized view refresh and quality computation");

  // Step 1: Refresh materialized views (populates Rating table from OL ratings)
  logger.info("Step 1: Refreshing materialized views...");
  await refreshMaterializedViews();

  // Step 2: Compute work quality scores from blended ratings
  logger.info("Step 2: Computing work quality scores...");
  const qualityCount = await computeWorkQuality();

  timer.end({ qualityWorksUpdated: qualityCount });
  logger.info("Refresh complete", { qualityWorksUpdated: qualityCount });

  await closePool();
}

main().catch((error) => {
  logger.error("Refresh failed", { error: String(error) });
  process.exit(1);
});
