#!/usr/bin/env tsx
/**
 * Full update pipeline
 *
 * Runs all import, ingestion, and feature-building steps in order.
 * Can skip steps that aren't needed or have already been done.
 *
 * Usage:
 *   pnpm update                           # Run full update pipeline
 *   pnpm update -- --skip-download        # Skip OL download (use existing files)
 *   pnpm update -- --skip-ingest          # Skip OL ingestion
 *   pnpm update -- --skip-enrich          # Skip Google Books enrichment
 *   pnpm update -- --skip-refresh-views   # Skip materialized view refresh & quality
 *   pnpm update -- --user jane            # Use different user ID
 *   pnpm update -- --quick                # Skip download/ingest, only refresh features
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { parseArgs } from "util";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { getEnv } from "@/lib/config/env";
import { runDataQualityCheck } from "@/lib/util/dataQuality";
import { closePool } from "@/lib/db/pool";

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    user: { type: "string", default: "me" },
    // Skip flags
    "skip-download": { type: "boolean", default: false },
    "skip-ingest": { type: "boolean", default: false },
    "skip-enrich": { type: "boolean", default: false },
    "skip-goodreads": { type: "boolean", default: false },
    "skip-kindle": { type: "boolean", default: false },
    "skip-kindle-aggregate": { type: "boolean", default: false },
    // skip-kindle-reenrich: deprecated, kept for compatibility
    "skip-kindle-reenrich": { type: "boolean", default: false },
    "skip-kindle-enrich": { type: "boolean", default: false },
    "skip-kindle-dedupe": { type: "boolean", default: false },
    "skip-kindle-fixunknown": { type: "boolean", default: false },
    "skip-cross-source-dedupe": { type: "boolean", default: false },
    "skip-refresh-views": { type: "boolean", default: false },
    "skip-features": { type: "boolean", default: false },
    // Quick mode: only refresh features (skip download, ingest, enrich)
    quick: { type: "boolean", default: false },
  },
});

interface StepResult {
  step: string;
  status: "success" | "skipped" | "failed";
  duration?: number;
  error?: string;
}

function runScript(command: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    // Filter out bare "--" separators that were used for pnpm arg passing
    const cleanArgs = args.filter((arg) => arg !== "--");
    console.log(`  Running: pnpm ${command} ${cleanArgs.join(" ")}`);
    const child = spawn("pnpm", [command, ...cleanArgs], {
      stdio: "inherit",
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Script "${command}" exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

async function runStep(
  name: string,
  fn: () => Promise<void>,
  skip: boolean
): Promise<StepResult> {
  if (skip) {
    console.log(`\n[SKIP] ${name}`);
    return { step: name, status: "skipped" };
  }

  console.log(`\n[STEP] ${name}`);
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    console.log(`  Done in ${(duration / 1000).toFixed(1)}s`);
    return { step: name, status: "success", duration };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`  FAILED: ${errorMsg}`);
    return { step: name, status: "failed", error: errorMsg };
  }
}

async function main() {
  const env = getEnv();
  const userId = values.user!;
  const quickMode = values.quick;

  const skipDownload = quickMode || values["skip-download"];
  const skipIngest = quickMode || values["skip-ingest"];
  const skipEnrich = quickMode || values["skip-enrich"];
  const skipGoodreads = values["skip-goodreads"];
  const skipKindle = values["skip-kindle"];
  const skipKindleAggregate = values["skip-kindle-aggregate"];
  const skipKindleReenrich = values["skip-kindle-reenrich"] || values["skip-kindle-enrich"];
  const skipKindleDedupe = values["skip-kindle-dedupe"];
  const skipKindleFixUnknown = values["skip-kindle-fixunknown"];
  const skipCrossSourceDedupe = values["skip-cross-source-dedupe"];
  const skipRefreshViews = values["skip-refresh-views"];
  const skipFeatures = values["skip-features"];

  console.log("========================================");
  console.log("  Book Recommender - Full Update");
  console.log("========================================");
  console.log(`User: ${userId}`);
  console.log(`Quick mode: ${quickMode}`);
  console.log("");

  const startTime = Date.now();
  const results: StepResult[] = [];

  // Step 1: Download Open Library data
  results.push(
    await runStep(
      "1. Download Open Library data",
      () => runScript("download:ol"),
      skipDownload
    )
  );

  // Step 1b: Backup embeddings before OL ingest (they get wiped by fast mode)
  results.push(
    await runStep(
      "1b. Backup embeddings",
      () => runScript("embeddings:backup"),
      skipIngest // Skip backup if we're skipping ingest
    )
  );

  // Step 2: Ingest Open Library data
  results.push(
    await runStep(
      "2. Ingest Open Library data",
      () => runScript("ingest:ol"),
      skipIngest
    )
  );

  // Step 2b: Restore embeddings after OL ingest
  results.push(
    await runStep(
      "2b. Restore embeddings",
      () => runScript("embeddings:restore"),
      skipIngest // Skip restore if we skipped ingest
    )
  );

  // Step 3: Enrich with Google Books API
  const hasGoogleKey = !!env.GOOGLE_BOOKS_API_KEY;
  results.push(
    await runStep(
      "3. Enrich with Google Books",
      () => runScript("enrich:gb"),
      skipEnrich || !hasGoogleKey
    )
  );
  if (!hasGoogleKey && !skipEnrich) {
    console.log("  (Skipped: GOOGLE_BOOKS_API_KEY not set)");
  }

  // Step 4: Import Goodreads data
  const goodreadsPath = env.GOODREADS_EXPORT_CSV;
  const goodreadsExists = existsSync(goodreadsPath);
  results.push(
    await runStep(
      "4. Import Goodreads history",
      () => runScript("import:goodreads", ["--", "--user", userId]),
      skipGoodreads || !goodreadsExists
    )
  );
  if (!goodreadsExists && !skipGoodreads) {
    console.log(`  (Skipped: ${goodreadsPath} not found)`);
  }

  // Step 5: Import Kindle data
  const kindleDir = env.KINDLE_EXPORT_DIR;
  const kindleExists = existsSync(kindleDir);
  results.push(
    await runStep(
      "5. Import Kindle history",
      () => runScript("import:kindle", ["--", "--user", userId]),
      skipKindle || !kindleExists
    )
  );
  if (!kindleExists && !skipKindle) {
    console.log(`  (Skipped: ${kindleDir} not found)`);
  }

  // Step 5b: Kindle aggregation
  results.push(
    await runStep(
      "5b. Aggregate Kindle reading",
      () => runScript("aggregate:kindle", ["--", "--user", userId]),
      skipKindleAggregate || skipKindle || !kindleExists
    )
  );

  // Step 5c: Kindle re-enrichment (ASIN metadata cleanup)
  results.push(
    await runStep(
      "5c. Re-enrich Kindle ASINs",
      () => runScript("kindle:enrich", ["--", "--user", userId]),
      skipKindleReenrich || skipKindle || !kindleExists
    )
  );

  // Step 5d: Kindle dedupe
  results.push(
    await runStep(
      "5d. Dedupe Kindle ASINs",
      () => runScript("kindle:dedupe"),
      skipKindleDedupe || skipKindle || !kindleExists
    )
  );

  // Step 5e: Fix unknown Kindle titles
  results.push(
    await runStep(
      "5e. Fix unknown Kindle titles",
      () => runScript("kindle:fix-unknowns"),
      skipKindleFixUnknown || skipKindle || !kindleExists
    )
  );

  // Step 5f: Cross-source deduplication (merge Amazon stubs into OL canonical)
  results.push(
    await runStep(
      "5f. Cross-source deduplication",
      () => runScript("dedupe:cross-source"),
      skipCrossSourceDedupe
    )
  );

  // Step 5g: Refresh materialized views and compute quality scores
  results.push(
    await runStep(
      "5g. Refresh views & quality scores",
      () => runScript("refresh:views"),
      skipRefreshViews
    )
  );

  // Step 6: Build embeddings
  results.push(
    await runStep(
      "6. Build work embeddings",
      () => runScript("features:embed"),
      skipFeatures
    )
  );

  // Step 6b: Embed user-event works (ensures profile has vectors)
  results.push(
    await runStep(
      "6b. Embed user-event works",
      () => runScript("embed:user-events", ["--", "--user", userId]),
      skipFeatures
    )
  );

  // Step 7: Build user profile
  results.push(
    await runStep(
      "7. Build user profile",
      () => runScript("profile:build", ["--", "--user", userId]),
      skipFeatures
    )
  );

  // Step 8: Compute graph features
  results.push(
    await runStep(
      "8. Compute graph features",
      () => runScript("graph:build", ["--", "--user", userId]),
      skipFeatures
    )
  );

  // Summary
  const totalDuration = Date.now() - startTime;

  console.log("");
  console.log("========================================");
  console.log("  Update Complete");
  console.log("========================================");

  const successful = results.filter((r) => r.status === "success").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  console.log(`Results: ${successful} successful, ${skipped} skipped, ${failed} failed`);
  console.log(`Total time: ${(totalDuration / 1000 / 60).toFixed(1)} minutes`);
  console.log("");

  // Show summary
  for (const result of results) {
    const icon = result.status === "success" ? "OK" : result.status === "skipped" ? "--" : "XX";
    const durationStr = result.duration ? ` (${(result.duration / 1000).toFixed(0)}s)` : "";
    console.log(`  [${icon}] ${result.step}${durationStr}`);
  }

  // Run data quality check
  try {
    await runDataQualityCheck(userId);
  } catch (error) {
    console.error("Data quality check failed:", error);
  }

  // Clean up database connections
  await closePool();

  if (failed > 0) {
    console.log("");
    console.log("Some steps failed. Check output above for details.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Update pipeline failed:", error);
  process.exit(1);
});
