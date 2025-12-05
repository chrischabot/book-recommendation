#!/usr/bin/env tsx
/**
 * Aggregate Kindle reading sessions into UserReadingAggregate and update UserEvent recency.
 *
 * Usage:
 *   pnpm tsx scripts/aggregate-kindle-reading.ts --user me
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { parseArgs } from "util";
import { aggregateKindleReading } from "@/lib/ingest/kindleAggregate";
import { invalidateUserCaches } from "@/lib/features/cache";
import { closePool } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "me" },
  },
});

async function main() {
  const userId = values.user!;
  logger.info("Aggregating Kindle reading", { userId });

  const result = await aggregateKindleReading(userId);
  await invalidateUserCaches(userId);

  logger.info("Kindle aggregation complete", result);
  await closePool();
}

main().catch((error) => {
  logger.error("Aggregation failed", { error: String(error) });
  process.exit(1);
});
