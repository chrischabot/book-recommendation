#!/usr/bin/env tsx
/**
 * Bulk link works to authors from Open Library dump
 *
 * This is MUCH faster than the row-by-row approach in linkWorkAuthors.
 * It extracts work-author pairs and bulk inserts into a staging table,
 * then bulk inserts into WorkAuthor via JOIN.
 *
 * Usage:
 *   pnpm link:authors
 *   pnpm link:authors -- --max 1000000
 */

import "dotenv/config";

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { parseArgs } from "util";
import { join } from "path";
import { query, transaction } from "@/lib/db/pool";
import { closePool } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

interface OLWork {
  key: string;
  authors?: Array<{ author: { key: string } }>;
}

function extractOlId(key: string): string {
  return key.split("/").pop() ?? key;
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");

const { values } = parseArgs({
  args,
  options: {
    dir: { type: "string", default: "./data/openlibrary" },
    max: { type: "string", default: "" },
  },
  allowPositionals: true,
});

async function main() {
  const dir = values.dir!;
  const maxItems = values.max ? parseInt(values.max, 10) : undefined;
  const filePath = join(dir, "ol_dump_works_latest.txt");

  logger.info("Starting bulk work-author linking", { filePath, maxItems });

  const timer = createTimer("Bulk work-author linking");

  // Create staging table
  logger.info("Phase 1: Creating staging table...");
  await query(`DROP TABLE IF EXISTS work_author_staging`);
  await query(`
    CREATE UNLOGGED TABLE work_author_staging (
      ol_work_key TEXT NOT NULL,
      ol_author_key TEXT NOT NULL
    )
  `);

  // Phase 2: Extract and insert pairs in batches
  logger.info("Phase 2: Extracting and staging work-author pairs...");
  const extractTimer = createTimer("Extract and stage pairs");

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  let processed = 0;
  let pairs = 0;
  let batch: Array<{ workKey: string; authorKey: string }> = [];
  const BATCH_SIZE = 5000; // 10k params, well under 65k limit

  const flushBatch = async () => {
    if (batch.length === 0) return;

    const vals: unknown[] = [];
    const placeholders: string[] = [];

    for (let i = 0; i < batch.length; i++) {
      const offset = i * 2;
      placeholders.push(`($${offset + 1}, $${offset + 2})`);
      vals.push(batch[i].workKey, batch[i].authorKey);
    }

    await query(
      `INSERT INTO work_author_staging (ol_work_key, ol_author_key) VALUES ${placeholders.join(", ")}`,
      vals
    );

    pairs += batch.length;
    batch = [];
  };

  for await (const line of rl) {
    if (maxItems && processed >= maxItems) break;

    try {
      const parts = line.split("\t");
      if (parts.length < 5) continue;

      const rawJson = parts[4];
      const work = JSON.parse(rawJson) as OLWork;

      if (!work.authors || work.authors.length === 0) {
        processed++;
        continue;
      }

      const workKey = extractOlId(work.key);

      for (const authorRef of work.authors) {
        if (!authorRef.author?.key) continue;
        const authorKey = extractOlId(authorRef.author.key);
        batch.push({ workKey, authorKey });

        if (batch.length >= BATCH_SIZE) {
          await flushBatch();
        }
      }

      processed++;

      if (processed % 1000000 === 0) {
        logger.info(`Staged ${pairs} pairs from ${processed} works`);
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Flush remaining
  await flushBatch();

  extractTimer.end({ worksProcessed: processed, pairsStaged: pairs });

  // Phase 3: Create indexes for faster JOIN
  logger.info("Phase 3: Creating indexes on staging table...");
  const indexTimer = createTimer("Create indexes");
  await query(`CREATE INDEX staging_work_key_idx ON work_author_staging (ol_work_key)`);
  await query(`CREATE INDEX staging_author_key_idx ON work_author_staging (ol_author_key)`);
  indexTimer.end();

  // Phase 4: Bulk insert into WorkAuthor via JOIN
  logger.info("Phase 4: Bulk inserting into WorkAuthor (this may take a while)...");
  const insertTimer = createTimer("WorkAuthor bulk insert");

  const result = await query(`
    INSERT INTO "WorkAuthor" (work_id, author_id, role)
    SELECT DISTINCT w.id, a.id, 'author'
    FROM work_author_staging s
    JOIN "Work" w ON w.ol_work_key = s.ol_work_key
    JOIN "Author" a ON a.ol_author_key = s.ol_author_key
    ON CONFLICT (work_id, author_id, role) DO NOTHING
  `);

  insertTimer.end({ rowsInserted: result.rowCount });

  // Clean up
  await query(`DROP TABLE IF EXISTS work_author_staging`);

  timer.end({ worksProcessed: processed, pairsStaged: pairs, rowsInserted: result.rowCount });

  // Verify
  const { rows } = await query<{ count: string }>(`SELECT COUNT(*) as count FROM "WorkAuthor"`);
  logger.info(`WorkAuthor now has ${rows[0]?.count} entries`);

  await closePool();
}

main().catch((error) => {
  logger.error("Bulk linking failed", { error: String(error) });
  process.exit(1);
});
