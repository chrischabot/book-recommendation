#!/usr/bin/env tsx
/**
 * Embed works that appear in a user's events but currently lack embeddings.
 *
 * Usage:
 *   pnpm embed:user-events -- --user me --batch 50
 */

import "dotenv/config";
import { parseArgs } from "util";
import { buildUserEventEmbeddings } from "@/lib/features/embeddings";
import { closePool } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "me" },
    batch: { type: "string", default: "50" },
  },
  allowPositionals: true,
});

async function main() {
  const userId = values.user!;
  const batchSize = parseInt(values.batch!, 10);

  logger.info("Embedding user-event works", { userId, batchSize });

  const result = await buildUserEventEmbeddings(userId, { batchSize });

  logger.info("User-event embedding complete", result);
  await closePool();
}

main().catch((error) => {
  logger.error("User-event embedding failed", { error: String(error) });
  process.exit(1);
});
