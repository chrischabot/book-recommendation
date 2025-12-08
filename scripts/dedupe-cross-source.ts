#!/usr/bin/env tsx
/**
 * Cross-source deduplication: merge Amazon stub Works into canonical OL Works.
 *
 * Finds Amazon works (from Kindle import) that match Open Library works by title,
 * and merges them to consolidate metadata (authors, subjects, ratings).
 *
 * Usage:
 *   pnpm dedupe:cross-source
 *   pnpm dedupe:cross-source --dry-run    # Preview without merging
 *   pnpm dedupe:cross-source --limit 100  # Process max 100 matches
 */

import "dotenv/config";
import { parseArgs } from "util";
import pLimit from "p-limit";
import { query, closePool } from "@/lib/db/pool";
import { mergeWorks } from "@/lib/ingest/resolverV2/merge";
import { logger, createTimer } from "@/lib/util/logger";

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    limit: { type: "string", default: "1000" },
    concurrency: { type: "string", default: "2" },
    "min-similarity": { type: "string", default: "0.85" },
  },
});

const CONCURRENCY = parseInt(values.concurrency!, 10);
const LIMIT = parseInt(values.limit!, 10);
const MIN_SIMILARITY = parseFloat(values["min-similarity"]!);
const DRY_RUN = values["dry-run"];

interface DuplicateCandidate {
  amazon_id: number;
  amazon_title: string;
  ol_id: number;
  ol_title: string;
  ol_work_key: string;
  title_similarity: number;
  ol_has_authors: boolean;
  ol_has_subjects: boolean;
}

/**
 * Find Amazon works that match OL works by normalized title.
 * Uses PostgreSQL's pg_trgm for fuzzy matching.
 */
async function findCrossSourceDuplicates(): Promise<DuplicateCandidate[]> {
  // First, ensure pg_trgm extension is enabled
  await query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  // Find matches using title similarity
  // Normalize titles by:
  // 1. Lowercasing
  // 2. Removing common series suffixes: (Book N), Book N, #N, etc.
  // 3. Removing parenthetical content at end
  const { rows } = await query<DuplicateCandidate>(`
    WITH normalized AS (
      SELECT
        id,
        title,
        source,
        ol_work_key,
        -- Normalize title: remove series markers, parentheticals, lowercase
        LOWER(
          REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(title,
                '\\s*\\([^)]*\\)\\s*$', '', 'g'),  -- Remove trailing (...)
              '\\s*:.*$', ''),                     -- Remove : subtitle
            '\\s*(Book\\s*\\d+|#\\d+|Volume\\s*\\d+)\\s*$', '', 'i')  -- Remove Book N, #N
        ) AS norm_title
      FROM "Work"
      WHERE source IN ('amazon', 'openlibrary') OR ol_work_key IS NOT NULL
    ),
    amazon_works AS (
      SELECT id, title, norm_title
      FROM normalized
      WHERE source = 'amazon' AND ol_work_key IS NULL
    ),
    ol_works AS (
      SELECT id, title, norm_title, ol_work_key
      FROM normalized
      WHERE ol_work_key IS NOT NULL
    )
    SELECT
      a.id AS amazon_id,
      a.title AS amazon_title,
      o.id AS ol_id,
      o.title AS ol_title,
      o.ol_work_key,
      similarity(a.norm_title, o.norm_title) AS title_similarity,
      EXISTS (SELECT 1 FROM "WorkAuthor" WHERE work_id = o.id) AS ol_has_authors,
      EXISTS (SELECT 1 FROM "WorkSubject" WHERE work_id = o.id) AS ol_has_subjects
    FROM amazon_works a
    JOIN ol_works o ON similarity(a.norm_title, o.norm_title) > $1
    WHERE a.id != o.id
      -- Prefer matches where OL has metadata we can use
      AND (
        EXISTS (SELECT 1 FROM "WorkAuthor" WHERE work_id = o.id)
        OR EXISTS (SELECT 1 FROM "WorkSubject" WHERE work_id = o.id)
      )
    ORDER BY title_similarity DESC
    LIMIT $2
  `, [MIN_SIMILARITY, LIMIT]);

  return rows;
}

/**
 * Additional validation: check if Amazon and OL works are likely the same book.
 * Looks for shared identifiers or high confidence indicators.
 */
async function validateMatch(
  amazonWorkId: number,
  olWorkId: number
): Promise<{ valid: boolean; reason: string }> {
  // Check for shared ISBNs between editions
  const { rows: isbnMatch } = await query<{ isbn: string }>(`
    SELECT e1.isbn13 AS isbn
    FROM "Edition" e1
    JOIN "Edition" e2 ON e1.isbn13 = e2.isbn13
    WHERE e1.work_id = $1 AND e2.work_id = $2 AND e1.isbn13 IS NOT NULL
    LIMIT 1
  `, [amazonWorkId, olWorkId]);

  if (isbnMatch.length > 0) {
    return { valid: true, reason: `Shared ISBN: ${isbnMatch[0].isbn}` };
  }

  // Check for shared Google Volume ID
  const { rows: gvMatch } = await query<{ gvid: string }>(`
    SELECT e1.google_volume_id AS gvid
    FROM "Edition" e1
    JOIN "Edition" e2 ON e1.google_volume_id = e2.google_volume_id
    WHERE e1.work_id = $1 AND e2.work_id = $2 AND e1.google_volume_id IS NOT NULL
    LIMIT 1
  `, [amazonWorkId, olWorkId]);

  if (gvMatch.length > 0) {
    return { valid: true, reason: `Shared Google Volume ID: ${gvMatch[0].gvid}` };
  }

  // If titles are very similar, trust the match
  return { valid: true, reason: "Title similarity match" };
}

async function main() {
  logger.info("Starting cross-source deduplication", {
    dryRun: DRY_RUN,
    limit: LIMIT,
    minSimilarity: MIN_SIMILARITY,
  });

  const timer = createTimer("Cross-source dedupe");

  // Find potential duplicates
  logger.info("Finding cross-source duplicates...");
  const candidates = await findCrossSourceDuplicates();

  if (candidates.length === 0) {
    logger.info("No cross-source duplicates found");
    await closePool();
    return;
  }

  logger.info(`Found ${candidates.length} potential duplicates`);

  // Preview mode
  if (DRY_RUN) {
    console.log("\n=== DRY RUN: Matches to be merged ===\n");
    for (const c of candidates.slice(0, 50)) {
      console.log(`[${(c.title_similarity * 100).toFixed(1)}%] Amazon: "${c.amazon_title}"`);
      console.log(`       → OL: "${c.ol_title}" (${c.ol_work_key})`);
      console.log(`         Authors: ${c.ol_has_authors ? "yes" : "no"}, Subjects: ${c.ol_has_subjects ? "yes" : "no"}`);
      console.log();
    }
    if (candidates.length > 50) {
      console.log(`... and ${candidates.length - 50} more matches`);
    }
    console.log(`\nTotal: ${candidates.length} works to merge`);
    console.log("Run without --dry-run to execute merges");
    await closePool();
    return;
  }

  // Execute merges
  const limiter = pLimit(CONCURRENCY);
  let merged = 0;
  let skipped = 0;
  let errors = 0;

  await Promise.all(
    candidates.map((candidate) =>
      limiter(async () => {
        try {
          // Validate the match
          const validation = await validateMatch(candidate.amazon_id, candidate.ol_id);

          if (!validation.valid) {
            skipped++;
            logger.debug("Skipping invalid match", {
              amazonId: candidate.amazon_id,
              olId: candidate.ol_id,
              reason: validation.reason,
            });
            return;
          }

          // Merge Amazon work into OL canonical (OL is always the target)
          await mergeWorks(
            candidate.amazon_id,
            candidate.ol_id,
            `Cross-source: ${validation.reason} (sim=${(candidate.title_similarity * 100).toFixed(0)}%)`
          );
          merged++;

          if (merged % 100 === 0) {
            logger.info("Merge progress", { merged, skipped, errors });
          }
        } catch (error) {
          errors++;
          logger.error("Failed to merge cross-source duplicate", {
            amazonId: candidate.amazon_id,
            olId: candidate.ol_id,
            error: String(error),
          });
        }
      })
    )
  );

  await closePool();
  timer.end({ candidates: candidates.length, merged, skipped, errors });
  logger.info("Cross-source dedupe complete", {
    candidates: candidates.length,
    merged,
    skipped,
    errors,
  });
}

main().catch((error) => {
  logger.error("Cross-source dedupe failed", { error: String(error) });
  process.exit(1);
});
