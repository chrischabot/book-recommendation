#!/usr/bin/env tsx
/**
 * Fast works ingestion using COPY protocol
 *
 * Strategy:
 * 1. Pre-process OL dump to clean TSV (only needed columns)
 * 2. COPY into unlogged staging table
 * 3. INSERT...SELECT with ON CONFLICT from staging to main
 * 4. Drop staging table
 */

import { createReadStream, createWriteStream } from "fs";
import { createInterface } from "readline";
import { spawn } from "child_process";
import { join } from "path";
import { query, withClient } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

interface OLWork {
  key: string;
  title: string;
  subtitle?: string;
  description?: string | { value: string };
  first_publish_date?: string;
}

function extractDescription(desc: string | { value: string } | undefined): string | null {
  if (!desc) return null;
  if (typeof desc === "string") return desc;
  return desc.value ?? null;
}

function extractYear(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const match = dateStr.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
  return match ? parseInt(match[1], 10) : null;
}

function extractOlId(key: string): string {
  return key.split("/").pop() ?? key;
}

// Escape for TSV format (tabs and newlines)
function escapeTsv(val: string | null): string {
  if (val === null) return "\\N";
  return val.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "");
}

async function main() {
  const dir = process.env.OPENLIBRARY_DUMPS_DIR || "./data/openlibrary";
  const inputPath = join(dir, "ol_dump_works_latest.txt");
  const stagingPath = join(dir, "works_staging.tsv");

  const timer = createTimer("Fast works ingestion");

  // Step 1: Pre-process dump to clean TSV
  logger.info("Step 1: Pre-processing dump to TSV...");
  const preTimer = createTimer("Pre-processing");

  const inputStream = createReadStream(inputPath);
  const outputStream = createWriteStream(stagingPath);
  const rl = createInterface({ input: inputStream, crlfDelay: Infinity });

  let processed = 0;
  let skipped = 0;

  for await (const line of rl) {
    try {
      const parts = line.split("\t");
      if (parts.length < 5) {
        skipped++;
        continue;
      }

      const [_type, _key, revisionStr, lastModified, rawJson] = parts;
      const revision = revisionStr ? parseInt(revisionStr, 10) : null;
      const work = JSON.parse(rawJson) as OLWork;

      if (!work.title) {
        skipped++;
        continue;
      }

      const olKey = extractOlId(work.key);
      const title = work.title;
      const subtitle = work.subtitle ?? null;
      const description = extractDescription(work.description);
      const year = extractYear(work.first_publish_date);

      // Write TSV line: ol_work_key, title, subtitle, description, first_publish_year, ol_revision, ol_last_modified
      const tsvLine = [
        escapeTsv(olKey),
        escapeTsv(title),
        escapeTsv(subtitle),
        escapeTsv(description),
        year === null ? "\\N" : year.toString(),
        revision === null || isNaN(revision) ? "\\N" : revision.toString(),
        escapeTsv(lastModified || null),
      ].join("\t");

      outputStream.write(tsvLine + "\n");
      processed++;

      if (processed % 500000 === 0) {
        logger.info(`Pre-processed ${processed} works, skipped ${skipped}`);
      }
    } catch {
      skipped++;
    }
  }

  outputStream.end();
  await new Promise<void>(resolve => outputStream.on("close", () => resolve()));
  preTimer.end({ processed, skipped });

  // Step 2: Create staging table and COPY data
  logger.info("Step 2: Creating staging table and loading via COPY...");
  const copyTimer = createTimer("COPY loading");

  await query(`DROP TABLE IF EXISTS "Work_staging"`);
  await query(`
    CREATE UNLOGGED TABLE "Work_staging" (
      ol_work_key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      description TEXT,
      first_publish_year INT,
      ol_revision INT,
      ol_last_modified DATE
    )
  `);

  // Use psql COPY command directly (much faster than streaming through Node)
  const psqlCopy = spawn("psql", [
    "-h", "localhost",
    "-U", "books",
    "-d", "books",
    "-c", `\\COPY "Work_staging" FROM '${stagingPath}' WITH (FORMAT text, NULL '\\N')`
  ], {
    env: { ...process.env, PGPASSWORD: "books" }
  });

  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    psqlCopy.stderr.on("data", (data) => { stderr += data; });
    psqlCopy.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`psql COPY failed with code ${code}: ${stderr}`));
      }
    });
  });

  const { rows: [{ count: stagingCount }] } = await query(`SELECT COUNT(*)::int as count FROM "Work_staging"`);
  copyTimer.end({ stagingRows: stagingCount });

  // Step 3: Merge staging into main table
  logger.info("Step 3: Merging staging into main table...");
  const mergeTimer = createTimer("Merge");

  const { rowCount } = await query(`
    INSERT INTO "Work" (ol_work_key, title, subtitle, description, first_publish_year, ol_revision, ol_last_modified, updated_at)
    SELECT ol_work_key, title, subtitle, description, first_publish_year, ol_revision, ol_last_modified, NOW()
    FROM "Work_staging"
    ON CONFLICT (ol_work_key) DO UPDATE SET
      title = EXCLUDED.title,
      subtitle = COALESCE(EXCLUDED.subtitle, "Work".subtitle),
      description = COALESCE(EXCLUDED.description, "Work".description),
      first_publish_year = COALESCE(EXCLUDED.first_publish_year, "Work".first_publish_year),
      ol_revision = EXCLUDED.ol_revision,
      ol_last_modified = EXCLUDED.ol_last_modified,
      updated_at = NOW()
  `);
  mergeTimer.end({ rowsAffected: rowCount });

  // Step 4: Cleanup
  logger.info("Step 4: Cleanup...");
  await query(`DROP TABLE "Work_staging"`);

  // Get final count
  const { rows: [{ count: finalCount }] } = await query(`SELECT COUNT(*)::int as count FROM "Work"`);

  timer.end({ totalWorks: finalCount });
  logger.info("Fast works ingestion complete!", { totalWorks: finalCount });

  process.exit(0);
}

main().catch((error) => {
  logger.error("Fast works ingestion failed", { error: String(error) });
  process.exit(1);
});
