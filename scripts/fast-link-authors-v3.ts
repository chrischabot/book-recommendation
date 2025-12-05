#!/usr/bin/env tsx
/**
 * Fast WorkAuthor linking v3 - using LIMIT/OFFSET batching
 */

import { join } from "path";
import { query } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

async function main() {
  const timer = createTimer("Fast WorkAuthor linking v3");

  // Check staging table exists from previous run
  const { rows: [{ exists }] } = await query(`
    SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'WorkAuthor_staging')
  `);
  
  if (!exists) {
    logger.error("WorkAuthor_staging table not found. Run the batched script first to create it.");
    process.exit(1);
  }

  const { rows: [{ count: stagingCount }] } = await query(`SELECT COUNT(*)::int as count FROM "WorkAuthor_staging"`);
  logger.info(`Staging table has ${stagingCount} rows`);

  // Step 1: Truncate target
  logger.info("Step 1: Truncating WorkAuthor...");
  await query(`TRUNCATE "WorkAuthor"`);

  // Step 2: Batch insert using LIMIT/OFFSET
  logger.info("Step 2: Batched inserts...");
  const insertTimer = createTimer("Batched inserts");

  const batchSize = 500000;
  const numBatches = Math.ceil(stagingCount / batchSize);
  let totalInserted = 0;

  for (let batch = 0; batch < numBatches; batch++) {
    const offset = batch * batchSize;
    const { rowCount } = await query(`
      INSERT INTO "WorkAuthor" (work_id, author_id, role)
      SELECT DISTINCT w.id, a.id, 'author'
      FROM (
        SELECT ol_work_key, ol_author_key
        FROM "WorkAuthor_staging"
        ORDER BY ol_work_key
        LIMIT $1 OFFSET $2
      ) s
      JOIN "Work" w ON w.ol_work_key = s.ol_work_key
      JOIN "Author" a ON a.ol_author_key = s.ol_author_key
    `, [batchSize, offset]);
    
    totalInserted += rowCount ?? 0;
    logger.info(`Batch ${batch + 1}/${numBatches}: inserted ${rowCount}, total ${totalInserted}`);
  }
  insertTimer.end({ totalInserted });

  // Cleanup
  logger.info("Step 3: Cleanup...");
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
