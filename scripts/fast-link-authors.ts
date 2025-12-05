#!/usr/bin/env tsx
/**
 * Fast WorkAuthor linking using COPY protocol
 * Pre-processes works file to extract work-author pairs, then bulk loads
 */

import { createReadStream, createWriteStream } from "fs";
import { createInterface } from "readline";
import { spawn } from "child_process";
import { join } from "path";
import { query } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

interface OLWork {
  key: string;
  authors?: Array<{ author: { key: string } }>;
}

function extractOlId(key: string): string {
  return key.split("/").pop() ?? key;
}

async function main() {
  const dir = process.env.OPENLIBRARY_DUMPS_DIR || "./data/openlibrary";
  const inputPath = join(dir, "ol_dump_works_latest.txt");
  const stagingPath = join(dir, "work_authors_staging.tsv");

  const timer = createTimer("Fast WorkAuthor linking");

  // Step 1: Extract work-author pairs to TSV
  logger.info("Step 1: Extracting work-author pairs...");
  const extractTimer = createTimer("Extraction");

  const inputStream = createReadStream(inputPath);
  const outputStream = createWriteStream(stagingPath);
  const rl = createInterface({ input: inputStream, crlfDelay: Infinity });

  let processed = 0;
  let pairs = 0;

  for await (const line of rl) {
    try {
      const parts = line.split("\t");
      if (parts.length < 5) continue;

      const rawJson = parts[4];
      const work = JSON.parse(rawJson) as OLWork;

      if (!work.authors || work.authors.length === 0) continue;

      const workKey = extractOlId(work.key);

      for (const authorRef of work.authors) {
        if (!authorRef.author?.key) continue;
        const authorKey = extractOlId(authorRef.author.key);
        outputStream.write(`${workKey}\t${authorKey}\n`);
        pairs++;
      }

      processed++;
      if (processed % 500000 === 0) {
        logger.info(`Processed ${processed} works, ${pairs} pairs`);
      }
    } catch {
      // Skip malformed lines
    }
  }

  outputStream.end();
  await new Promise<void>(resolve => outputStream.on("close", () => resolve()));
  extractTimer.end({ works: processed, pairs });

  // Step 2: Create staging table and COPY
  logger.info("Step 2: Loading pairs via COPY...");
  const copyTimer = createTimer("COPY loading");

  await query(`DROP TABLE IF EXISTS "WorkAuthor_staging"`);
  await query(`
    CREATE UNLOGGED TABLE "WorkAuthor_staging" (
      ol_work_key TEXT,
      ol_author_key TEXT
    )
  `);

  const psqlCopy = spawn("psql", [
    "-h", "localhost",
    "-U", "books",
    "-d", "books",
    "-c", `\\COPY "WorkAuthor_staging" FROM '${stagingPath}' WITH (FORMAT text)`
  ], {
    env: { ...process.env, PGPASSWORD: "books" }
  });

  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    psqlCopy.stderr.on("data", (data) => { stderr += data; });
    psqlCopy.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql COPY failed: ${stderr}`));
    });
  });

  const { rows: [{ count: stagingCount }] } = await query(`SELECT COUNT(*)::int as count FROM "WorkAuthor_staging"`);
  copyTimer.end({ stagingRows: stagingCount });

  // Step 3: Bulk insert with JOIN
  logger.info("Step 3: Bulk inserting WorkAuthor relationships...");
  const insertTimer = createTimer("Bulk insert");

  // Clear existing and insert fresh (faster than ON CONFLICT for full reload)
  await query(`TRUNCATE "WorkAuthor"`);
  
  const { rowCount } = await query(`
    INSERT INTO "WorkAuthor" (work_id, author_id, role)
    SELECT DISTINCT w.id, a.id, 'author'
    FROM "WorkAuthor_staging" s
    JOIN "Work" w ON w.ol_work_key = s.ol_work_key
    JOIN "Author" a ON a.ol_author_key = s.ol_author_key
  `);
  insertTimer.end({ inserted: rowCount });

  // Cleanup
  await query(`DROP TABLE "WorkAuthor_staging"`);

  const { rows: [{ count: finalCount }] } = await query(`SELECT COUNT(*)::int as count FROM "WorkAuthor"`);
  
  timer.end({ totalLinks: finalCount });
  logger.info("WorkAuthor linking complete!", { totalLinks: finalCount });

  process.exit(0);
}

main().catch((error) => {
  logger.error("WorkAuthor linking failed", { error: String(error) });
  process.exit(1);
});
