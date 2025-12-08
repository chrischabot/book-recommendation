#!/usr/bin/env tsx
/**
 * Build embeddings for works using OpenAI
 *
 * Processes all works with community engagement (2+ users OR 1+ ratings),
 * ordered by popularity. This ensures we embed all recommendable books
 * while skipping obscure works with no audience.
 *
 * Usage:
 *   pnpm features:embed
 *   pnpm features:embed -- --batch 100
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { parseArgs } from "util";
import { buildWorkEmbeddings } from "@/lib/features/embeddings";
import { closePool } from "@/lib/db/pool";
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/util/logger";

const { values } = parseArgs({
  options: {
    batch: { type: "string", default: "100" },
    parallel: { type: "string", default: "4" },
  },
});

// Cleanup on exit
async function cleanup() {
  await closePool();
}

// Handle process signals
process.on("SIGINT", async () => {
  logger.info("Received SIGINT, cleaning up...");
  await cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM, cleaning up...");
  await cleanup();
  process.exit(0);
});

async function main() {
  const env = getEnv();

  if (!env.OPENAI_API_KEY) {
    logger.error("OPENAI_API_KEY is required");
    process.exit(1);
  }

  const batchSize = parseInt(values.batch ?? "100", 10);
  const parallelBatches = parseInt(values.parallel ?? "4", 10);

  if (isNaN(batchSize) || batchSize < 1) {
    logger.error("batch must be a positive integer");
    process.exit(1);
  }
  if (isNaN(parallelBatches) || parallelBatches < 1) {
    logger.error("parallel must be a positive integer");
    process.exit(1);
  }

  logger.info("Starting embedding generation for quality works", {
    batchSize,
    parallelBatches,
    effectiveWorkRate: `${batchSize * parallelBatches} works per round`,
  });

  const result = await buildWorkEmbeddings({
    batchSize,
    parallelBatches,
  });

  logger.info("Embedding generation complete", result);
}

main()
  .catch((error) => {
    logger.error("Embedding generation failed", { error: String(error) });
    process.exit(1);
  })
  .finally(cleanup);
