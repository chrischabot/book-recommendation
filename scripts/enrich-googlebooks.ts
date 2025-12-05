#!/usr/bin/env tsx
/**
 * Enrich works with Google Books API data
 *
 * Usage:
 *   pnpm enrich:gb -- --max 10000
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { parseArgs } from "util";
import { enrichFromGoogleBooks } from "@/lib/ingest/googlebooks";
import { closePool } from "@/lib/db/pool";
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/util/logger";

const { values } = parseArgs({
  options: {
    max: { type: "string", default: "10000" },
    "missing-only": { type: "boolean", default: true },
  },
});

async function main() {
  const env = getEnv();

  if (!env.GOOGLE_BOOKS_API_KEY) {
    logger.error("GOOGLE_BOOKS_API_KEY is required");
    process.exit(1);
  }

  const maxItems = parseInt(values.max!, 10);
  const onlyMissingRatings = values["missing-only"];

  logger.info("Starting Google Books enrichment", { maxItems, onlyMissingRatings });

  const result = await enrichFromGoogleBooks({
    apiKey: env.GOOGLE_BOOKS_API_KEY,
    maxItems,
    onlyMissingRatings,
  });

  logger.info("Enrichment complete", result);
  await closePool();
}

main().catch((error) => {
  logger.error("Enrichment failed", { error: String(error) });
  process.exit(1);
});
