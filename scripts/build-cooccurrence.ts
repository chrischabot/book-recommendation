#!/usr/bin/env tsx
/**
 * Build work co-occurrence table for collaborative filtering
 *
 * Computes item-item similarity (Jaccard) based on:
 * 1. OL Lists - books in same list co-occur (primary source)
 * 2. Shared authors - books by same author are related
 *
 * Usage:
 *   pnpm cooccur:build
 *   pnpm cooccur:build -- --min-overlap 2 --top-k 100
 */

import "dotenv/config";

import { parseArgs } from "util";
import { query } from "@/lib/db/pool";
import { closePool } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

const args = process.argv.slice(2).filter((arg) => arg !== "--");

const { values } = parseArgs({
  args,
  options: {
    "min-overlap": { type: "string", default: "2" },
    "min-lists": { type: "string", default: "2" },
    "top-k": { type: "string", default: "100" },
  },
  allowPositionals: true,
});

const MIN_OVERLAP = parseInt(values["min-overlap"]!, 10);
const MIN_LISTS = parseInt(values["min-lists"]!, 10);
const TOP_K = parseInt(values["top-k"]!, 10);

async function main() {
  logger.info("Building work co-occurrence table from OL Lists", {
    minOverlap: MIN_OVERLAP,
    minLists: MIN_LISTS,
    topK: TOP_K,
  });

  const timer = createTimer("Build co-occurrence");

  // Step 1: Clear existing data
  logger.info("Phase 1: Clearing existing co-occurrence data...");
  await query(`TRUNCATE "WorkCooccurrence"`);

  // Step 2: Build co-occurrence from lists
  // Books appearing in the same list co-occur
  logger.info("Phase 2: Computing co-occurrence from OL Lists...");

  // First, get work keys from list seeds (normalize editions to works if possible)
  // For now, use work-type seeds directly and extract work key from seed_key
  const listCooccurResult = await query(`
    WITH list_works AS (
      -- Get work keys from list seeds (works only for simplicity)
      SELECT DISTINCT
        ls.list_id,
        l.ol_user_key,
        REPLACE(ls.seed_key, '/works/', '') as work_key
      FROM "OLListSeed" ls
      JOIN "OLList" l ON l.id = ls.list_id
      WHERE ls.seed_type = 'work'
    ),
    work_list_counts AS (
      -- Count how many lists each work appears in
      SELECT work_key, COUNT(DISTINCT list_id) as list_count
      FROM list_works
      GROUP BY work_key
      HAVING COUNT(DISTINCT list_id) >= $1
    ),
    cooccur_pairs AS (
      -- Find pairs of works in same lists
      SELECT
        lw1.work_key as work_key_a,
        lw2.work_key as work_key_b,
        COUNT(DISTINCT lw1.list_id) as overlap
      FROM list_works lw1
      JOIN list_works lw2 ON lw1.list_id = lw2.list_id AND lw1.work_key < lw2.work_key
      JOIN work_list_counts wlc1 ON wlc1.work_key = lw1.work_key
      JOIN work_list_counts wlc2 ON wlc2.work_key = lw2.work_key
      GROUP BY lw1.work_key, lw2.work_key
      HAVING COUNT(DISTINCT lw1.list_id) >= $2
    )
    INSERT INTO "WorkCooccurrence" (work_key_a, work_key_b, overlap, jaccard, readers_a, readers_b)
    SELECT
      cp.work_key_a,
      cp.work_key_b,
      cp.overlap,
      cp.overlap::numeric / (wlc1.list_count + wlc2.list_count - cp.overlap) as jaccard,
      wlc1.list_count as readers_a,
      wlc2.list_count as readers_b
    FROM cooccur_pairs cp
    JOIN work_list_counts wlc1 ON wlc1.work_key = cp.work_key_a
    JOIN work_list_counts wlc2 ON wlc2.work_key = cp.work_key_b
    ON CONFLICT (work_key_a, work_key_b) DO UPDATE SET
      overlap = EXCLUDED.overlap,
      jaccard = EXCLUDED.jaccard,
      readers_a = EXCLUDED.readers_a,
      readers_b = EXCLUDED.readers_b,
      updated_at = NOW()
  `, [MIN_LISTS, MIN_OVERLAP]);

  logger.info(`Inserted ${listCooccurResult.rowCount} list-based co-occurrence pairs`);

  // Also insert the reverse direction for easier lookups
  logger.info("Phase 3: Adding reverse pairs for symmetric lookups...");
  const reverseResult = await query(`
    INSERT INTO "WorkCooccurrence" (work_key_a, work_key_b, overlap, jaccard, readers_a, readers_b)
    SELECT work_key_b, work_key_a, overlap, jaccard, readers_b, readers_a
    FROM "WorkCooccurrence"
    ON CONFLICT (work_key_a, work_key_b) DO NOTHING
  `);

  logger.info(`Added ${reverseResult.rowCount} reverse pairs`);

  // Step 3: Add author-based co-occurrence for books with shared authors
  logger.info("Phase 4: Adding author-based co-occurrence...");

  const authorCooccurResult = await query(`
    WITH eligible_authors AS (
      -- Only authors with 2-100 works (avoid prolific authors causing huge joins)
      SELECT author_id
      FROM "WorkAuthor"
      GROUP BY author_id
      HAVING COUNT(*) BETWEEN 2 AND 100
    ),
    author_works AS (
      -- Get works with their OL work keys
      SELECT DISTINCT
        wa.author_id,
        w.ol_work_key as work_key
      FROM "WorkAuthor" wa
      JOIN "Work" w ON w.id = wa.work_id
      JOIN eligible_authors ea ON ea.author_id = wa.author_id
      WHERE w.ol_work_key IS NOT NULL
    ),
    work_author_counts AS (
      -- Count works per author (for Jaccard denominator)
      SELECT work_key, COUNT(DISTINCT author_id) as author_count
      FROM author_works
      GROUP BY work_key
    ),
    author_cooccur AS (
      -- Works sharing authors (limited to manageable size)
      SELECT
        aw1.work_key as work_key_a,
        aw2.work_key as work_key_b,
        COUNT(DISTINCT aw1.author_id) as shared_authors
      FROM author_works aw1
      JOIN author_works aw2 ON aw1.author_id = aw2.author_id AND aw1.work_key < aw2.work_key
      GROUP BY aw1.work_key, aw2.work_key
    )
    INSERT INTO "WorkCooccurrence" (work_key_a, work_key_b, overlap, jaccard, readers_a, readers_b)
    SELECT
      ac.work_key_a,
      ac.work_key_b,
      ac.shared_authors,
      -- Higher weight for author matches
      LEAST(1.0, (ac.shared_authors::numeric / GREATEST(wac1.author_count, wac2.author_count)) * 5) as jaccard,
      wac1.author_count,
      wac2.author_count
    FROM author_cooccur ac
    JOIN work_author_counts wac1 ON wac1.work_key = ac.work_key_a
    JOIN work_author_counts wac2 ON wac2.work_key = ac.work_key_b
    ON CONFLICT (work_key_a, work_key_b) DO UPDATE SET
      jaccard = GREATEST("WorkCooccurrence".jaccard, EXCLUDED.jaccard),
      overlap = GREATEST("WorkCooccurrence".overlap, EXCLUDED.overlap),
      updated_at = NOW()
  `);

  logger.info(`Processed ${authorCooccurResult.rowCount} author-based pairs`);

  // Add reverse author pairs
  await query(`
    INSERT INTO "WorkCooccurrence" (work_key_a, work_key_b, overlap, jaccard, readers_a, readers_b)
    SELECT work_key_b, work_key_a, overlap, jaccard, readers_b, readers_a
    FROM "WorkCooccurrence" wc
    WHERE NOT EXISTS (
      SELECT 1 FROM "WorkCooccurrence" wc2
      WHERE wc2.work_key_a = wc.work_key_b AND wc2.work_key_b = wc.work_key_a
    )
    ON CONFLICT (work_key_a, work_key_b) DO NOTHING
  `);

  // Step 4: Prune to top-K per work
  logger.info("Phase 5: Pruning to top-K per work...");
  const pruneResult = await query(`
    WITH ranked AS (
      SELECT work_key_a, work_key_b,
        ROW_NUMBER() OVER (PARTITION BY work_key_a ORDER BY jaccard DESC) as rn
      FROM "WorkCooccurrence"
    )
    DELETE FROM "WorkCooccurrence" wc
    WHERE EXISTS (
      SELECT 1 FROM ranked r
      WHERE r.work_key_a = wc.work_key_a
      AND r.work_key_b = wc.work_key_b
      AND r.rn > $1
    )
  `, [TOP_K]);

  logger.info(`Pruned ${pruneResult.rowCount} rows (keeping top ${TOP_K} per work)`);

  // Step 5: Get final stats
  const { rows: stats } = await query<{
    pair_count: string;
    work_count: string;
    avg_jaccard: string;
  }>(`
    SELECT
      COUNT(*) as pair_count,
      COUNT(DISTINCT work_key_a) as work_count,
      ROUND(AVG(jaccard)::numeric, 4) as avg_jaccard
    FROM "WorkCooccurrence"
  `);

  const finalStats = stats[0];
  timer.end({
    pairs: parseInt(finalStats?.pair_count ?? "0", 10),
    works: parseInt(finalStats?.work_count ?? "0", 10),
    avgJaccard: parseFloat(finalStats?.avg_jaccard ?? "0"),
  });

  logger.info(`Co-occurrence build complete`, {
    pairs: finalStats?.pair_count,
    works: finalStats?.work_count,
    avgJaccard: finalStats?.avg_jaccard,
  });

  await closePool();
}

main().catch((error) => {
  logger.error("Co-occurrence build failed", { error: String(error) });
  process.exit(1);
});
