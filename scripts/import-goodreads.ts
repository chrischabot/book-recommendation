#!/usr/bin/env tsx
/**
 * Import Goodreads CSV export
 *
 * Usage:
 *   pnpm import:goodreads -- --user me --csv ./data/goodreads/export.csv
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { parseArgs } from "util";
import { existsSync } from "fs";
import { importGoodreads, getImportStats } from "@/lib/ingest/goodreads";
import { invalidateUserCaches } from "@/lib/features/cache";
import { closePool } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "me" },
    csv: { type: "string", default: "./data/goodreads/export.csv" },
    resolve: { type: "boolean", default: true },
  },
});

async function main() {
  const userId = values.user!;
  const csvPath = values.csv!;
  const resolveUnknown = values.resolve;

  if (!existsSync(csvPath)) {
    logger.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  logger.info("Starting Goodreads import", { userId, csvPath, resolveUnknown });

  const result = await importGoodreads({
    csvPath,
    userId,
    resolveUnknown,
  });

  // Invalidate caches
  await invalidateUserCaches(userId);

  // Get stats
  const stats = await getImportStats(userId);

  logger.info("Import complete", { result, stats });
  await closePool();
}

main().catch((error) => {
  logger.error("Import failed", { error: String(error) });
  process.exit(1);
});
