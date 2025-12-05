#!/usr/bin/env tsx
/**
 * Build user profile vector from reading history
 *
 * Usage:
 *   pnpm profile:build -- --user me
 */

import { config } from "dotenv";
config(); // Load .env before any other imports that need it

import { parseArgs } from "util";
import { buildUserProfile, getUserTasteSummary } from "@/lib/features/userProfile";
import { closePool } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";

const { values } = parseArgs({
  options: {
    user: { type: "string", default: "me" },
  },
  allowPositionals: true,
});

async function main() {
  const userId = values.user!;

  logger.info("Building user profile", { userId });

  const profile = await buildUserProfile(userId);

  if (profile.profileVec.length === 0) {
    logger.warn("No profile could be built - no events with embeddings found");
    await closePool();
    return;
  }

  logger.info("Profile built", {
    vectorDimension: profile.profileVec.length,
    anchorCount: profile.anchors.length,
    topAnchors: profile.anchors.slice(0, 3).map((a) => a.title),
  });

  // Get taste summary
  const taste = await getUserTasteSummary(userId);
  logger.info("Taste summary", taste);

  await closePool();
}

main().catch((error) => {
  logger.error("Profile build failed", { error: String(error) });
  process.exit(1);
});
