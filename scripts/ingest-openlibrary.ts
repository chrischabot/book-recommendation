#!/usr/bin/env tsx
/**
 * Ingest Open Library dump files into the database
 *
 * Usage:
 *   pnpm ingest:ol -- --dir ./data/openlibrary
 *   pnpm ingest:ol -- --dir ./data/openlibrary --tables works,authors
 *   pnpm ingest:ol -- --dir ./data/openlibrary --preset core
 *
 * Presets:
 *   core     - works, editions, authors (base catalog)
 *   activity - ratings, reading-log (user activity)
 *   meta     - redirects, covers-metadata, wikidata, lists (enrichment)
 *   full     - everything (default)
 */

// Load .env BEFORE other imports that may use process.env
import "dotenv/config";

import { parseArgs } from "util";
import { existsSync } from "fs";
import { join } from "path";
import {
  ingestWorks,
  ingestEditions,
  ingestAuthors,
  ingestRatings,
  ingestReadingLog,
  ingestRedirects,
  ingestCoversMetadata,
  ingestWikidata,
  ingestLists,
  linkWorkAuthors,
  computePageCountMedian,
  refreshMaterializedViews,
} from "@/lib/ingest/openlibrary";
import { closePool } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";

const DUMP_FILES: Record<string, string> = {
  works: "ol_dump_works_latest.txt",
  editions: "ol_dump_editions_latest.txt",
  authors: "ol_dump_authors_latest.txt",
  ratings: "ol_dump_ratings_latest.txt",
  "reading-log": "ol_dump_reading-log_latest.txt",
  redirects: "ol_dump_redirects_latest.txt",
  "covers-metadata": "ol_dump_covers_metadata_latest.txt",
  wikidata: "ol_dump_wikidata_latest.txt",
  lists: "ol_dump_lists_latest.txt",
};

const PRESETS: Record<string, string[]> = {
  core: ["authors", "works", "editions"],
  activity: ["ratings", "reading-log"],
  meta: ["redirects", "covers-metadata", "wikidata", "lists"],
  full: Object.keys(DUMP_FILES),
};

const args = process.argv.slice(2).filter((arg) => arg !== "--");

const { values } = parseArgs({
  args,
  options: {
    dir: { type: "string", default: "./data/openlibrary" },
    tables: { type: "string" },
    preset: { type: "string", default: "full" },
    max: { type: "string", default: "" },
    "skip-lines": { type: "string", default: "" },
    "skip-refresh": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

async function main() {
  const dir = values.dir!;
  const maxItems = values.max ? parseInt(values.max, 10) : undefined;
  const skipLines = values["skip-lines"] ? parseInt(values["skip-lines"], 10) : undefined;
  const skipRefresh = values["skip-refresh"];

  // Determine tables to ingest: explicit --tables overrides --preset
  let tables: string[];
  if (values.tables) {
    tables = values.tables.split(",").map((t) => t.trim().toLowerCase());
  } else {
    const presetName = values.preset ?? "full";
    if (!PRESETS[presetName]) {
      logger.error(`Unknown preset: ${presetName}`);
      logger.error(`Available presets: ${Object.keys(PRESETS).join(", ")}`);
      process.exit(1);
    }
    tables = PRESETS[presetName];
  }

  logger.info("Starting Open Library ingestion", { dir, tables, maxItems });

  if (!existsSync(dir)) {
    logger.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const stats: Record<string, number> = {};

  // Helper to ingest a table if requested and file exists
  async function tryIngest(
    name: string,
    ingestFn: (path: string, opts: { maxItems?: number }) => Promise<number>
  ) {
    if (!tables.includes(name)) return;
    const filePath = join(dir, DUMP_FILES[name]);
    if (existsSync(filePath)) {
      stats[name] = await ingestFn(filePath, { maxItems });
    } else {
      logger.warn(`${name} file not found: ${filePath}`);
    }
  }

  // Process tables in dependency order
  // 1. Core catalog (authors first, then works, then editions)
  await tryIngest("authors", ingestAuthors);

  if (tables.includes("works")) {
    const filePath = join(dir, DUMP_FILES.works);
    if (existsSync(filePath)) {
      stats.works = await ingestWorks(filePath, { maxItems, skipLines });
      // Link works to authors
      if (tables.includes("authors")) {
        await linkWorkAuthors(filePath);
      }
    } else {
      logger.warn(`Works file not found: ${filePath}`);
    }
  }

  if (tables.includes("editions")) {
    const filePath = join(dir, DUMP_FILES.editions);
    if (existsSync(filePath)) {
      stats.editions = await ingestEditions(filePath, { maxItems });
      await computePageCountMedian();
    } else {
      logger.warn(`Editions file not found: ${filePath}`);
    }
  }

  // 2. User activity data
  await tryIngest("ratings", ingestRatings);
  await tryIngest("reading-log", ingestReadingLog);

  // 3. Metadata enrichment
  await tryIngest("redirects", ingestRedirects);
  await tryIngest("covers-metadata", ingestCoversMetadata);
  await tryIngest("wikidata", ingestWikidata);
  await tryIngest("lists", ingestLists);

  // Refresh materialized views if we ingested activity data
  if (!skipRefresh && (tables.includes("ratings") || tables.includes("reading-log"))) {
    logger.info("Refreshing materialized views...");
    await refreshMaterializedViews();
  }

  logger.info("Ingestion complete", stats);
  await closePool();
}

main().catch((error) => {
  logger.error("Ingestion failed", { error: String(error) });
  process.exit(1);
});
