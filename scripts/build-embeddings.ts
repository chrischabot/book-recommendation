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
    batch: { type: "string", default: "50" },
  },
});

async function main() {
  const env = getEnv();

  if (!env.OPENAI_API_KEY) {
    logger.error("OPENAI_API_KEY is required");
    process.exit(1);
  }

  const batchSize = parseInt(values.batch!, 10);

  logger.info("Starting embedding generation for quality works", { batchSize });

  const result = await buildWorkEmbeddings({
    batchSize,
  });

  logger.info("Embedding generation complete", result);
  await closePool();
}

main().catch((error) => {
  logger.error("Embedding generation failed", { error: String(error) });
  process.exit(1);
});
