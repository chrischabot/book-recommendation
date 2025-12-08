#!/usr/bin/env tsx
/**
 * Build and populate the Apache AGE graph, compute graph features
 *
 * Usage:
 *   pnpm graph:build -- --user me
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { parseArgs } from "util";
import { populateGraph, computeGraphFeatures } from "@/lib/features/graph";
import { computeWorkQuality } from "@/lib/features/ratings";
import { closePool } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    user: { type: "string", default: "me" },
    "skip-populate": { type: "boolean", default: false },
    "skip-quality": { type: "boolean", default: false },
  },
});

async function main() {
  const userId = values.user!;
  const skipPopulate = values["skip-populate"];
  const skipQuality = values["skip-quality"];

  // Populate graph from relational tables
  if (!skipPopulate) {
    logger.info("Populating AGE graph");
    const graphStats = await populateGraph();
    logger.info("Graph populated", graphStats);
  }

  // Compute work quality scores
  if (!skipQuality) {
    logger.info("Computing work quality scores");
    const qualityCount = await computeWorkQuality();
    logger.info("Quality scores computed", { count: qualityCount });
  }

  // Compute graph features for user
  logger.info("Computing graph features", { userId });
  const featureCount = await computeGraphFeatures(userId);
  logger.info("Graph features computed", { count: featureCount });

  await closePool();
}

main().catch((error) => {
  logger.error("Graph build failed", { error: String(error) });
  process.exit(1);
});
