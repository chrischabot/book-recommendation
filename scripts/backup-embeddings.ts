#!/usr/bin/env tsx
/**
 * Backup and restore embeddings
 *
 * Saves embeddings to a file before destructive imports, restores them after.
 * This prevents losing expensive OpenAI embeddings during bulk data refreshes.
 *
 * Usage:
 *   pnpm embeddings:backup                    # Backup to data/embeddings-backup.json
 *   pnpm embeddings:backup -- --out custom.json
 *   pnpm embeddings:restore                   # Restore from data/embeddings-backup.json
 *   pnpm embeddings:restore -- --in custom.json
 */

import "dotenv/config";
import { parseArgs } from "util";
import { createWriteStream, createReadStream, existsSync } from "fs";
import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import { createInterface } from "readline";
import { query, closePool } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

const DEFAULT_PATH = "./data/embeddings-backup.jsonl";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: DEFAULT_PATH },
    in: { type: "string", default: DEFAULT_PATH },
  },
});

const command = positionals[0] || "backup";

async function backup(outPath: string) {
  logger.info("Backing up embeddings", { outPath });
  const timer = createTimer("Embedding backup");

  // Ensure directory exists
  await mkdir(dirname(outPath), { recursive: true });

  const stream = createWriteStream(outPath);

  // Stream embeddings from database - only for OL works (they have ol_work_key)
  const { rows } = await query<{ ol_work_key: string; embedding: string }>(
    `SELECT ol_work_key, embedding::text
     FROM "Work"
     WHERE embedding IS NOT NULL AND ol_work_key IS NOT NULL`
  );

  let count = 0;
  for (const row of rows) {
    stream.write(JSON.stringify({
      k: row.ol_work_key,
      e: row.embedding,
    }) + "\n");
    count++;
    if (count % 10000 === 0) {
      logger.info(`Backed up ${count} embeddings`);
    }
  }

  stream.end();
  timer.end({ count });
  logger.info(`Backup complete: ${count} embeddings saved to ${outPath}`);
}

async function restore(inPath: string) {
  if (!existsSync(inPath)) {
    logger.error(`Backup file not found: ${inPath}`);
    process.exit(1);
  }

  logger.info("Restoring embeddings", { inPath });
  const timer = createTimer("Embedding restore");

  const rl = createInterface({
    input: createReadStream(inPath),
    crlfDelay: Infinity,
  });

  let restored = 0;
  let notFound = 0;
  const batch: { key: string; embedding: string }[] = [];
  const BATCH_SIZE = 500;

  async function flushBatch() {
    if (batch.length === 0) return;

    // Build bulk update
    const keys = batch.map((b) => b.key);
    const cases: string[] = [];
    const params: unknown[] = [];

    for (let i = 0; i < batch.length; i++) {
      params.push(batch[i].key, batch[i].embedding);
      cases.push(`WHEN ol_work_key = $${i * 2 + 1} THEN $${i * 2 + 2}::vector`);
    }

    const result = await query(
      `UPDATE "Work"
       SET embedding = CASE ${cases.join(" ")} END,
           updated_at = NOW()
       WHERE ol_work_key = ANY($${params.length + 1})
         AND embedding IS NULL`,
      [...params, keys]
    );

    restored += result.rowCount ?? 0;
    notFound += batch.length - (result.rowCount ?? 0);
    batch.length = 0;
  }

  for await (const line of rl) {
    if (!line.trim()) continue;
    const { k, e } = JSON.parse(line);
    batch.push({ key: k, embedding: e });

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
      if ((restored + notFound) % 10000 === 0) {
        logger.info(`Processed ${restored + notFound} embeddings (${restored} restored)`);
      }
    }
  }

  await flushBatch();
  timer.end({ restored, notFound });
  logger.info(`Restore complete: ${restored} embeddings restored, ${notFound} works not found/already have embeddings`);
}

async function main() {
  if (command === "backup") {
    await backup(values.out!);
  } else if (command === "restore") {
    await restore(values.in!);
  } else {
    logger.error(`Unknown command: ${command}. Use 'backup' or 'restore'.`);
    process.exit(1);
  }
}

main()
  .catch((error) => {
    logger.error("Operation failed", { error: String(error) });
    process.exit(1);
  })
  .finally(closePool);
