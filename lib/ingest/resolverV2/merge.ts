/**
 * Work merge logic for deduplication
 * Handles merging duplicate Works when better identifiers are discovered
 */

import { transaction, query } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";
import type { MergeInfo } from "./types";

/**
 * Merge two Works, moving all related data to the canonical Work
 *
 * When a higher-priority identifier (e.g., ISBN) is discovered for a Work
 * that was previously created with a lower-priority identifier (e.g., ASIN),
 * this function merges them into a single canonical Work.
 *
 * @param fromWorkId The duplicate Work to merge away
 * @param toWorkId The canonical Work to keep
 * @param reason Description of why the merge is happening
 */
export async function mergeWorks(
  fromWorkId: number,
  toWorkId: number,
  reason: string
): Promise<MergeInfo> {
  if (fromWorkId === toWorkId) {
    throw new Error("Cannot merge a work into itself");
  }

  return await transaction(async (client) => {
    // Count editions being moved for logging
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM "Edition" WHERE work_id = $1`,
      [fromWorkId]
    );
    const editionsMoved = parseInt(countRows[0].count, 10);

    logger.info("Merging works", { fromWorkId, toWorkId, reason, editionsMoved });

    // 1. Move all Editions to canonical work
    await client.query(
      `UPDATE "Edition" SET work_id = $1 WHERE work_id = $2`,
      [toWorkId, fromWorkId]
    );

    // 2. Move WorkAuthor relationships (ignore conflicts)
    await client.query(
      `INSERT INTO "WorkAuthor" (work_id, author_id, role)
       SELECT $1, author_id, role FROM "WorkAuthor" WHERE work_id = $2
       ON CONFLICT (work_id, author_id, role) DO NOTHING`,
      [toWorkId, fromWorkId]
    );
    await client.query(
      `DELETE FROM "WorkAuthor" WHERE work_id = $1`,
      [fromWorkId]
    );

    // 3. Move WorkSubject relationships (ignore conflicts)
    await client.query(
      `INSERT INTO "WorkSubject" (work_id, subject)
       SELECT $1, subject FROM "WorkSubject" WHERE work_id = $2
       ON CONFLICT (work_id, subject) DO NOTHING`,
      [toWorkId, fromWorkId]
    );
    await client.query(
      `DELETE FROM "WorkSubject" WHERE work_id = $1`,
      [fromWorkId]
    );

    // 4. Move UserEvents (handle conflicts by keeping canonical)
    await client.query(
      `UPDATE "UserEvent" SET work_id = $1 WHERE work_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM "UserEvent" ue2
         WHERE ue2.work_id = $1
         AND ue2.user_id = "UserEvent".user_id
         AND ue2.source = "UserEvent".source
       )`,
      [toWorkId, fromWorkId]
    );
    // Delete any remaining (duplicates that couldn't be moved)
    await client.query(
      `DELETE FROM "UserEvent" WHERE work_id = $1`,
      [fromWorkId]
    );

    // 5. Move Ratings (update if source exists, insert otherwise)
    await client.query(
      `INSERT INTO "Rating" (work_id, source, avg, count, last_updated)
       SELECT $1, source, avg, count, last_updated FROM "Rating" WHERE work_id = $2
       ON CONFLICT (work_id, source) DO UPDATE SET
         avg = EXCLUDED.avg,
         count = EXCLUDED.count,
         last_updated = GREATEST("Rating".last_updated, EXCLUDED.last_updated)`,
      [toWorkId, fromWorkId]
    );
    await client.query(
      `DELETE FROM "Rating" WHERE work_id = $1`,
      [fromWorkId]
    );

    // 6. Update ResolverCache entries
    await client.query(
      `UPDATE "ResolverCache" SET work_id = $1 WHERE work_id = $2`,
      [toWorkId, fromWorkId]
    );

    // 7. Update ResolverLog entries
    await client.query(
      `UPDATE "ResolverLog" SET work_id = $1 WHERE work_id = $2`,
      [toWorkId, fromWorkId]
    );

    // 8. Merge Work metadata (keep better data)
    await client.query(
      `UPDATE "Work" w1 SET
         description = COALESCE(w1.description, w2.description),
         first_publish_year = COALESCE(w1.first_publish_year, w2.first_publish_year),
         is_stub = FALSE,
         stub_reason = NULL,
         updated_at = NOW()
       FROM "Work" w2
       WHERE w1.id = $1 AND w2.id = $2`,
      [toWorkId, fromWorkId]
    );

    // 9. Log the merge
    await client.query(
      `INSERT INTO "WorkMergeLog" (work_id_from, work_id_to, reason, editions_moved, merged_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [fromWorkId, toWorkId, reason, editionsMoved]
    );

    // 10. Delete the duplicate Work
    await client.query(
      `DELETE FROM "Work" WHERE id = $1`,
      [fromWorkId]
    );

    logger.info("Work merge complete", { fromWorkId, toWorkId });

    return {
      fromWorkId,
      toWorkId,
      reason,
      editionsMoved,
    };
  });
}

/**
 * Find potential duplicate Works that should be merged
 * Called after creating a new Work with a higher-priority identifier
 *
 * @param workId The newly created/updated Work
 * @param title Title to match
 * @param author Author to match
 * @returns Work IDs that are potential duplicates (lower work_id = canonical)
 */
export async function findPotentialDuplicates(
  workId: number,
  title?: string,
  author?: string
): Promise<number[]> {
  if (!title) return [];

  // Find works with similar titles that might be duplicates
  // Uses trigram similarity for fuzzy matching
  const { rows } = await query<{ id: number; similarity: number }>(
    `SELECT w.id, similarity(LOWER(w.title), LOWER($1)) as similarity
     FROM "Work" w
     WHERE w.id != $2
     AND similarity(LOWER(w.title), LOWER($1)) > 0.6
     ORDER BY similarity DESC
     LIMIT 10`,
    [title, workId]
  );

  // If we have an author, filter by author similarity too
  if (author && rows.length > 0) {
    const workIds = rows.map((r) => r.id);
    const { rows: authorMatches } = await query<{ work_id: number }>(
      `SELECT DISTINCT wa.work_id
       FROM "WorkAuthor" wa
       JOIN "Author" a ON a.id = wa.author_id
       WHERE wa.work_id = ANY($1)
       AND similarity(LOWER(a.name), LOWER($2)) > 0.5`,
      [workIds, author]
    );

    return authorMatches.map((r) => r.work_id);
  }

  return rows.map((r) => r.id);
}

/**
 * Check if two Works should be merged based on their identifiers
 *
 * @param workId1 First work ID
 * @param workId2 Second work ID
 * @returns True if they represent the same book
 */
export async function shouldMerge(
  workId1: number,
  workId2: number
): Promise<{ shouldMerge: boolean; reason: string | null }> {
  // Check if they share any hard identifier
  const { rows } = await query<{ match_type: string }>(
    `SELECT
       CASE
         WHEN e1.isbn13 IS NOT NULL AND e1.isbn13 = e2.isbn13 THEN 'isbn13'
         WHEN e1.isbn10 IS NOT NULL AND e1.isbn10 = e2.isbn10 THEN 'isbn10'
         WHEN e1.google_volume_id IS NOT NULL AND e1.google_volume_id = e2.google_volume_id THEN 'google_volume_id'
         WHEN e1.asin IS NOT NULL AND e1.asin = e2.asin THEN 'asin'
         ELSE NULL
       END as match_type
     FROM "Edition" e1
     CROSS JOIN "Edition" e2
     WHERE e1.work_id = $1 AND e2.work_id = $2
     AND (
       (e1.isbn13 IS NOT NULL AND e1.isbn13 = e2.isbn13)
       OR (e1.isbn10 IS NOT NULL AND e1.isbn10 = e2.isbn10)
       OR (e1.google_volume_id IS NOT NULL AND e1.google_volume_id = e2.google_volume_id)
       OR (e1.asin IS NOT NULL AND e1.asin = e2.asin)
     )
     LIMIT 1`,
    [workId1, workId2]
  );

  if (rows[0]?.match_type) {
    return {
      shouldMerge: true,
      reason: `Shared identifier: ${rows[0].match_type}`,
    };
  }

  return { shouldMerge: false, reason: null };
}

/**
 * Get merge history for a Work
 */
export async function getMergeHistory(
  workId: number
): Promise<Array<{ fromWorkId: number; reason: string; mergedAt: Date }>> {
  const { rows } = await query<{
    work_id_from: number;
    reason: string;
    merged_at: Date;
  }>(
    `SELECT work_id_from, reason, merged_at
     FROM "WorkMergeLog"
     WHERE work_id_to = $1
     ORDER BY merged_at DESC`,
    [workId]
  );

  return rows.map((r) => ({
    fromWorkId: r.work_id_from,
    reason: r.reason,
    mergedAt: r.merged_at,
  }));
}
