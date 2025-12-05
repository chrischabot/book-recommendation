#!/usr/bin/env tsx
/**
 * Import Kindle/Amazon data export
 *
 * Usage:
 *   pnpm import:kindle -- --user me --dir ./data/kindle
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { parseArgs } from "util";
import { existsSync } from "fs";
import { importKindle } from "@/lib/ingest/kindle";
import { aggregateKindleReading } from "@/lib/ingest/kindleAggregate";
import { invalidateUserCaches } from "@/lib/features/cache";
import { closePool } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";

const { values } = parseArgs({
  allowNegated: true,
  options: {
    user: { type: "string", default: "me" },
    dir: { type: "string", default: "./data/kindle" },
    clippings: { type: "boolean", default: true },
    ownership: { type: "boolean", default: true },
    completions: { type: "boolean", default: true },
    sessions: { type: "boolean", default: true },
    dayUnits: { type: "boolean", default: true },
    aggregate: { type: "boolean", default: true },
    force: { type: "boolean", default: false },
  },
});

async function main() {
  const userId = values.user!;
  const exportDir = values.dir!;
  const importClippings = values.clippings;
  const importOwnership = values.ownership;
  const importCompletions = values.completions;
  const importSessions = values.sessions;
  const importDayUnits = values.dayUnits;
  const runAggregate = values.aggregate;
  const force = values.force;

  if (!existsSync(exportDir)) {
    logger.error(`Export directory not found: ${exportDir}`);
    process.exit(1);
  }

  logger.info("Starting Kindle import", {
    userId,
    exportDir,
    importClippings,
    importOwnership,
    importCompletions,
    importSessions,
    importDayUnits,
  });

  const result = await importKindle({
    exportDir,
    userId,
    importClippings,
    ownership: importOwnership,
    completions: importCompletions,
    sessions: importSessions,
    dayUnits: importDayUnits,
    force,
  });

  if (runAggregate) {
    const aggResult = await aggregateKindleReading(userId);
    logger.info("Kindle aggregation complete", aggResult);
  }

  // Invalidate caches
  await invalidateUserCaches(userId);

  logger.info("Import complete", result);
  await closePool();
}

main().catch((error) => {
  logger.error("Import failed", { error: String(error) });
  process.exit(1);
});
