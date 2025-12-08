#!/usr/bin/env tsx
/**
 * Enrich works missing authors with Google Books API data
 *
 * Usage:
 *   pnpm enrich:authors                       # Enrich user's books missing authors (default)
 *   pnpm enrich:authors -- --max 500          # Limit to 500 books
 *   pnpm enrich:authors -- --all              # Enrich all books missing authors (not just user's)
 *   pnpm enrich:authors -- --user jane        # Different user ID
 *   pnpm enrich:authors -- --delay 2000       # 2 second delay between API calls
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { parseArgs } from "util";
import { enrichWorks } from "@/lib/ingest/enrichWork";
import { closePool } from "@/lib/db/pool";
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/util/logger";

// Filter out leading '--' that pnpm passes
const args = process.argv.slice(2).filter((arg, i, arr) => !(arg === "--" && i === 0));

const { values } = parseArgs({
  args,
  options: {
    max: { type: "string", default: "1000" },
    user: { type: "string", default: "me" },
    all: { type: "boolean", default: false },
    delay: { type: "string", default: "1000" },
  },
  allowPositionals: true,
});

async function main() {
  const env = getEnv();

  if (!env.GOOGLE_BOOKS_API_KEY) {
    logger.error("GOOGLE_BOOKS_API_KEY is required for Google Books enrichment");
    process.exit(1);
  }

  const limit = parseInt(values.max!, 10);
  const userId = values.user!;
  const userBooksOnly = !values.all;
  const delayMs = parseInt(values.delay!, 10);

  logger.info("Starting author enrichment", {
    limit,
    userId,
    userBooksOnly,
    delayMs,
  });

  const result = await enrichWorks({
    limit,
    missingAuthorsOnly: true,
    userBooksOnly,
    userId,
    delayMs,
  });

  logger.info("Author enrichment complete", result);

  if (result.authors > 0) {
    logger.info(`Successfully added ${result.authors} author links to ${result.enriched} works`);
  } else if (result.total === 0) {
    logger.info("No works found that need author enrichment");
  } else {
    logger.warn(`Processed ${result.total} works but couldn't find authors. This may indicate Google Books API issues.`);
  }

  await closePool();
}

main().catch((error) => {
  logger.error("Author enrichment failed", { error: String(error) });
  process.exit(1);
});
