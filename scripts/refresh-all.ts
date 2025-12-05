#!/usr/bin/env tsx
/**
 * Refresh all features and caches
 *
 * Usage:
 *   pnpm refresh:all -- --user me
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { parseArgs } from "util";
import { buildWorkEmbeddings } from "@/lib/features/embeddings";
import { computeWorkQuality } from "@/lib/features/ratings";
import { buildUserProfile } from "@/lib/features/userProfile";
import { computeGraphFeatures } from "@/lib/features/graph";
import { cleanupExpiredCaches, invalidateUserCaches } from "@/lib/features/cache";
import { closePool } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "me" },
    embeddings: { type: "boolean", default: true },
    quality: { type: "boolean", default: true },
    profile: { type: "boolean", default: true },
    graph: { type: "boolean", default: true },
    cleanup: { type: "boolean", default: true },
  },
});

async function main() {
  const userId = values.user!;
  const timer = createTimer("Full refresh");

  logger.info("Starting full refresh", { userId, options: values });

  const stats: Record<string, unknown> = {};

  // 1. Build new embeddings for works without them
  if (values.embeddings) {
    logger.info("Step 1: Building embeddings for quality works");
    const embResult = await buildWorkEmbeddings({ batchSize: 50 });
    stats.embeddings = embResult;
  }

  // 2. Compute/refresh work quality scores
  if (values.quality) {
    logger.info("Step 2: Computing quality scores");
    stats.qualityWorks = await computeWorkQuality();
  }

  // 3. Rebuild user profile
  if (values.profile) {
    logger.info("Step 3: Building user profile");
    const profile = await buildUserProfile(userId);
    stats.profileAnchors = profile.anchors.length;
  }

  // 4. Compute graph features
  if (values.graph) {
    logger.info("Step 4: Computing graph features");
    stats.graphFeatures = await computeGraphFeatures(userId);
  }

  // 5. Cleanup expired caches
  if (values.cleanup) {
    logger.info("Step 5: Cleaning up caches");
    const cleanup = await cleanupExpiredCaches();
    stats.cacheCleanup = cleanup;
  }

  // Invalidate user recommendation caches to force re-generation
  await invalidateUserCaches(userId);

  timer.end(stats);
  logger.info("Full refresh complete", stats);

  await closePool();
}

main().catch((error) => {
  logger.error("Refresh failed", { error: String(error) });
  process.exit(1);
});
