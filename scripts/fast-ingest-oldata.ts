#!/usr/bin/env tsx
/**
 * Fast OL data ingestion using COPY protocol
 * Handles ratings, reading-log, and lists files
 */

import { createReadStream, createWriteStream, existsSync } from "fs";
import { createInterface } from "readline";
import { spawn } from "child_process";
import { join } from "path";
import { query } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

function extractOlId(key: string): string {
  return key.split("/").pop() ?? key;
}

function escapeTsv(val: string | null): string {
  if (val === null || val === "") return "\\N";
  return val.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "");
}

async function copyLoad(tableName: string, stagingPath: string, columns: string): Promise<number> {
  const psqlCopy = spawn("psql", [
    "-h", "localhost",
    "-U", "books",
    "-d", "books",
    "-c", `\\COPY "${tableName}" (${columns}) FROM '${stagingPath}' WITH (FORMAT text, NULL '\\N')`
  ], {
    env: { ...process.env, PGPASSWORD: "books" }
  });

  return new Promise<number>((resolve, reject) => {
    let stderr = "";
    psqlCopy.stderr.on("data", (data) => { stderr += data; });
    psqlCopy.on("close", async (code) => {
      if (code === 0) {
        const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int as count FROM "${tableName}"`);
        resolve(count);
      } else {
        reject(new Error(`psql COPY failed: ${stderr}`));
      }
    });
  });
}

async function ingestRatings(dir: string): Promise<void> {
  const inputPath = join(dir, "ol_dump_ratings_latest.txt");
  const stagingPath = join(dir, "ratings_staging.tsv");

  if (!existsSync(inputPath)) {
    logger.info("Ratings file not found, skipping");
    return;
  }

  const timer = createTimer("Fast ratings ingestion");

  // Step 1: Pre-process to TSV
  logger.info("Ratings: Pre-processing to TSV...");
  const inputStream = createReadStream(inputPath);
  const outputStream = createWriteStream(stagingPath);
  const rl = createInterface({ input: inputStream, crlfDelay: Infinity });

  let processed = 0;
  let userIdx = 0;

  for await (const line of rl) {
    const fields = line.split("\t");
    if (fields.length < 4) continue;

    const [workKeyRaw, editionKeyRaw, ratingStr, dateStr] = fields;
    const rating = parseInt(ratingStr, 10);
    if (isNaN(rating) || rating < 1 || rating > 5) continue;

    const workKey = extractOlId(workKeyRaw);
    const editionKey = editionKeyRaw ? extractOlId(editionKeyRaw) : null;
    const olUserKey = `anon_${++userIdx}`;  // Generate unique user key

    outputStream.write([
      escapeTsv(workKey),
      escapeTsv(editionKey),
      escapeTsv(olUserKey),
      rating.toString(),
      escapeTsv(dateStr || null)
    ].join("\t") + "\n");

    processed++;
    if (processed % 100000 === 0) {
      logger.info(`Ratings: processed ${processed}`);
    }
  }

  outputStream.end();
  await new Promise<void>(resolve => outputStream.on("close", () => resolve()));
  logger.info(`Ratings: Pre-processed ${processed} rows`);

  // Step 2: Truncate and COPY
  logger.info("Ratings: Truncating and loading via COPY...");
  await query(`TRUNCATE "OLRating"`);
  const count = await copyLoad("OLRating", stagingPath, "work_key, edition_key, ol_user_key, rating, rated_date");

  timer.end({ ratings: count });
  logger.info(`Ratings complete: ${count} rows`);
}

// Normalize status values from various formats
function normalizeStatus(status: string): string | null {
  const s = status.toLowerCase().replace(/\s+/g, "-");
  const mapping: Record<string, string> = {
    "already-read": "already-read",
    "want-to-read": "want-to-read",
    "currently-reading": "currently-reading",
    // Alternative formats
    "read": "already-read",
    "want": "want-to-read",
    "reading": "currently-reading",
  };
  return mapping[s] ?? null;
}

async function ingestReadingLog(dir: string): Promise<void> {
  const inputPath = join(dir, "ol_dump_reading-log_latest.txt");
  const stagingPath = join(dir, "reading_log_staging.tsv");

  if (!existsSync(inputPath)) {
    logger.info("Reading log file not found, skipping");
    return;
  }

  const timer = createTimer("Fast reading log ingestion");

  // Step 1: Pre-process to TSV
  logger.info("ReadingLog: Pre-processing to TSV...");
  const inputStream = createReadStream(inputPath);
  const outputStream = createWriteStream(stagingPath);
  const rl = createInterface({ input: inputStream, crlfDelay: Infinity });

  let processed = 0;
  let skipped = 0;
  let userIdx = 0;

  // Format: work_key, edition_key (optional), status, date
  // NOTE: This dump does NOT have user keys - we generate pseudo-users
  for await (const line of rl) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;

    const [workKeyRaw, editionKeyRaw, statusRaw, dateStr] = fields;

    const workKey = extractOlId(workKeyRaw);
    const status = normalizeStatus(statusRaw);

    if (!status) {
      skipped++;
      continue;
    }

    // Generate unique pseudo-user for each row (for view aggregation)
    const olUserKey = `anon_${++userIdx}`;
    const logDate = dateStr || null;

    outputStream.write([
      escapeTsv(workKey),
      escapeTsv(olUserKey),
      escapeTsv(status),
      escapeTsv(logDate)
    ].join("\t") + "\n");

    processed++;
    if (processed % 1000000 === 0) {
      logger.info(`ReadingLog: processed ${(processed / 1000000).toFixed(1)}M, skipped ${skipped}`);
    }
  }

  outputStream.end();
  await new Promise<void>(resolve => outputStream.on("close", () => resolve()));
  logger.info(`ReadingLog: Pre-processed ${processed} rows, skipped ${skipped}`);

  // Step 2: Truncate and COPY
  logger.info("ReadingLog: Truncating and loading via COPY...");
  await query(`TRUNCATE "OLReadingLog"`);
  const count = await copyLoad("OLReadingLog", stagingPath, "work_key, ol_user_key, status, logged_date");

  timer.end({ readingLog: count });
  logger.info(`ReadingLog complete: ${count} rows`);
}

async function main() {
  const dir = process.env.OPENLIBRARY_DUMPS_DIR || "./data/openlibrary";
  const tables = process.argv.slice(2);

  const timer = createTimer("Fast OL data ingestion");

  if (tables.length === 0 || tables.includes("ratings")) {
    await ingestRatings(dir);
  }

  if (tables.length === 0 || tables.includes("reading-log")) {
    await ingestReadingLog(dir);
  }

  timer.end();
  logger.info("Fast OL data ingestion complete!");
  process.exit(0);
}

main().catch((error) => {
  logger.error("Fast OL data ingestion failed", { error: String(error) });
  process.exit(1);
});
