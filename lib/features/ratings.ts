/**
 * Rating blending and quality score computation
 * Combines Open Library and Google Books ratings using Bayesian averaging
 */

import { query, transaction } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

interface RatingStats {
  source: string;
  avg: number;
  count: number;
}

interface BlendedQuality {
  workId: number;
  blendedAvg: number;
  blendedWilson: number;
  totalRatings: number;
}

// Bayesian prior parameters
const PRIOR_MEAN = 3.5; // Assume average book is 3.5/5
const PRIOR_WEIGHT = 10; // Prior counts as 10 ratings

/**
 * Compute Bayesian average rating
 * Pulls ratings toward the prior mean, especially for low-count items
 */
function bayesianAverage(avg: number, count: number): number {
  return (PRIOR_WEIGHT * PRIOR_MEAN + count * avg) / (PRIOR_WEIGHT + count);
}

/**
 * Compute Wilson score lower bound
 * Gives a conservative estimate of true rating
 * Lower bound of 95% confidence interval
 */
function wilsonLowerBound(
  positiveRatio: number,
  totalCount: number,
  confidence = 0.95
): number {
  if (totalCount === 0) return 0;

  // Z-score for confidence level (1.96 for 95%)
  const z = confidence === 0.95 ? 1.96 : 1.645;

  const phat = positiveRatio;
  const n = totalCount;

  const denominator = 1 + z * z / n;
  const centerAdjustment = phat + (z * z) / (2 * n);
  const spreadAdjustment =
    z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);

  return (centerAdjustment - spreadAdjustment) / denominator;
}

/**
 * Convert 5-star rating to a "positive" ratio for Wilson scoring
 * Treats 4+ as positive, <4 as negative
 */
function ratingToPositiveRatio(avgRating: number): number {
  // Normalize 1-5 scale to 0-1
  // Consider 4.0+ as fully positive, 1.0 as fully negative
  return Math.max(0, Math.min(1, (avgRating - 1) / 4));
}

/**
 * Blend ratings from multiple sources
 */
function blendRatings(ratings: RatingStats[]): {
  blendedAvg: number;
  blendedWilson: number;
  totalCount: number;
} {
  if (ratings.length === 0) {
    return { blendedAvg: PRIOR_MEAN, blendedWilson: 0, totalCount: 0 };
  }

  // Weight sources by reliability
  // Open Library ratings tend to be higher quality but lower volume
  // Google Books has more ratings but can be noisier
  const sourceWeights: Record<string, number> = {
    openlibrary: 1.2,
    googlebooks: 1.0,
  };

  let weightedSum = 0;
  let weightedCount = 0;
  let totalCount = 0;

  for (const rating of ratings) {
    const weight = sourceWeights[rating.source] ?? 1.0;
    weightedSum += rating.avg * rating.count * weight;
    weightedCount += rating.count * weight;
    totalCount += rating.count;
  }

  const rawAvg = weightedSum / weightedCount;
  const blendedAvg = bayesianAverage(rawAvg, totalCount);

  // Compute Wilson lower bound
  const positiveRatio = ratingToPositiveRatio(blendedAvg);
  const blendedWilson = wilsonLowerBound(positiveRatio, totalCount);

  return { blendedAvg, blendedWilson, totalCount };
}

/**
 * Compute and store blended quality scores for all works
 */
export async function computeWorkQuality(): Promise<number> {
  logger.info("Computing work quality scores");
  const timer = createTimer("Quality score computation");

  // Get all ratings grouped by work
  const { rows: ratingRows } = await query<{
    work_id: number;
    source: string;
    avg: string;
    count: number;
  }>(`
    SELECT work_id, source, avg, count
    FROM "Rating"
    WHERE avg IS NOT NULL AND count > 0
    ORDER BY work_id
  `);

  // Group by work_id
  const workRatings = new Map<number, RatingStats[]>();
  for (const row of ratingRows) {
    const workId = row.work_id;
    if (!workRatings.has(workId)) {
      workRatings.set(workId, []);
    }
    workRatings.get(workId)!.push({
      source: row.source,
      avg: parseFloat(row.avg),
      count: row.count,
    });
  }

  logger.info(`Processing ${workRatings.size} works with ratings`);

  // Compute blended scores
  const batchSize = 1000;
  let processed = 0;
  const batch: BlendedQuality[] = [];

  for (const [workId, ratings] of workRatings) {
    const { blendedAvg, blendedWilson, totalCount } = blendRatings(ratings);

    batch.push({
      workId,
      blendedAvg,
      blendedWilson,
      totalRatings: totalCount,
    });

    if (batch.length >= batchSize) {
      await storeBatch(batch);
      processed += batch.length;
      batch.length = 0;
      logger.debug(`Processed ${processed} works`);
    }
  }

  // Store remaining
  if (batch.length > 0) {
    await storeBatch(batch);
    processed += batch.length;
  }

  timer.end({ processed });
  return processed;
}

/**
 * Store a batch of quality scores
 */
async function storeBatch(batch: BlendedQuality[]): Promise<void> {
  await transaction(async (client) => {
    for (const item of batch) {
      await client.query(
        `
        INSERT INTO "WorkQuality" (work_id, blended_avg, blended_wilson, total_ratings, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (work_id) DO UPDATE SET
          blended_avg = EXCLUDED.blended_avg,
          blended_wilson = EXCLUDED.blended_wilson,
          total_ratings = EXCLUDED.total_ratings,
          updated_at = NOW()
        `,
        [item.workId, item.blendedAvg, item.blendedWilson, item.totalRatings]
      );
    }
  });
}

/**
 * Get quality score for a single work
 */
export async function getWorkQuality(
  workId: number
): Promise<BlendedQuality | null> {
  const { rows } = await query<{
    work_id: number;
    blended_avg: string;
    blended_wilson: string;
    total_ratings: number;
  }>(
    `SELECT work_id, blended_avg, blended_wilson, total_ratings FROM "WorkQuality" WHERE work_id = $1`,
    [workId]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    workId: row.work_id,
    blendedAvg: parseFloat(row.blended_avg),
    blendedWilson: parseFloat(row.blended_wilson),
    totalRatings: row.total_ratings,
  };
}

/**
 * Get quality scores for multiple works
 */
export async function getWorkQualities(
  workIds: number[]
): Promise<Map<number, BlendedQuality>> {
  if (workIds.length === 0) return new Map();

  const { rows } = await query<{
    work_id: number;
    blended_avg: string;
    blended_wilson: string;
    total_ratings: number;
  }>(
    `SELECT work_id, blended_avg, blended_wilson, total_ratings FROM "WorkQuality" WHERE work_id = ANY($1)`,
    [workIds]
  );

  const result = new Map<number, BlendedQuality>();
  for (const row of rows) {
    result.set(row.work_id, {
      workId: row.work_id,
      blendedAvg: parseFloat(row.blended_avg),
      blendedWilson: parseFloat(row.blended_wilson),
      totalRatings: row.total_ratings,
    });
  }

  return result;
}

// ============================================================================
// Popularity data from Open Library reading logs
// ============================================================================

export interface WorkPopularity {
  workKey: string;
  readCount: number;
  readingCount: number;
  wantCount: number;
  uniqueUsers: number;
  totalLogs: number;
}

/**
 * Get popularity data for works by OL work key
 */
export async function getWorkPopularity(
  olWorkKeys: string[]
): Promise<Map<string, WorkPopularity>> {
  if (olWorkKeys.length === 0) return new Map();

  const { rows } = await query<{
    work_key: string;
    read_count: string;
    reading_count: string;
    want_count: string;
    unique_users: string;
    total_logs: string;
  }>(
    `SELECT work_key, read_count, reading_count, want_count, unique_users, total_logs
     FROM "WorkPopularity"
     WHERE work_key = ANY($1)`,
    [olWorkKeys]
  );

  const result = new Map<string, WorkPopularity>();
  for (const row of rows) {
    result.set(row.work_key, {
      workKey: row.work_key,
      readCount: parseInt(row.read_count, 10),
      readingCount: parseInt(row.reading_count, 10),
      wantCount: parseInt(row.want_count, 10),
      uniqueUsers: parseInt(row.unique_users, 10),
      totalLogs: parseInt(row.total_logs, 10),
    });
  }

  return result;
}

/**
 * Compute a popularity score for ranking
 * Weights: already-read > currently-reading > want-to-read
 * Returns a score roughly on a 0-100 scale (log-scaled for large counts)
 */
export function computePopularityScore(pop: WorkPopularity): number {
  if (pop.totalLogs === 0) return 0;

  // Weight the different statuses
  const weightedScore =
    pop.readCount * 1.0 + // Already read is most valuable
    pop.readingCount * 0.8 + // Currently reading shows engagement
    pop.wantCount * 0.3; // Want to read is potential interest

  // Log scale to handle viral books vs long-tail
  // +1 to avoid log(0), multiply by 10 for reasonable scale
  return Math.log10(weightedScore + 1) * 10;
}

/**
 * Get trending works (recently popular in reading logs)
 */
export async function getTrendingWorks(
  limit = 100
): Promise<Array<{ olWorkKey: string; popularity: WorkPopularity }>> {
  const { rows } = await query<{
    work_key: string;
    read_count: string;
    reading_count: string;
    want_count: string;
    unique_users: string;
    total_logs: string;
  }>(
    `SELECT work_key, read_count, reading_count, want_count, unique_users, total_logs
     FROM "WorkPopularity"
     ORDER BY (read_count + reading_count * 0.5 + want_count * 0.2) DESC
     LIMIT $1`,
    [limit]
  );

  return rows.map((row) => ({
    olWorkKey: row.work_key,
    popularity: {
      workKey: row.work_key,
      readCount: parseInt(row.read_count, 10),
      readingCount: parseInt(row.reading_count, 10),
      wantCount: parseInt(row.want_count, 10),
      uniqueUsers: parseInt(row.unique_users, 10),
      totalLogs: parseInt(row.total_logs, 10),
    },
  }));
}

/**
 * Get books that users who read X also read
 * Collaborative filtering based on reading logs
 */
export async function getAlsoReadWorks(
  olWorkKey: string,
  limit = 20
): Promise<Array<{ olWorkKey: string; overlap: number }>> {
  const { rows } = await query<{
    work_key: string;
    overlap: string;
  }>(
    `
    WITH readers AS (
      SELECT DISTINCT ol_user_key
      FROM "OLReadingLog"
      WHERE work_key = $1
      AND status = 'already-read'
    )
    SELECT
      r2.work_key,
      COUNT(DISTINCT r2.ol_user_key) as overlap
    FROM readers
    JOIN "OLReadingLog" r2 ON r2.ol_user_key = readers.ol_user_key
    WHERE r2.work_key != $1
    AND r2.status = 'already-read'
    GROUP BY r2.work_key
    HAVING COUNT(DISTINCT r2.ol_user_key) >= 2
    ORDER BY overlap DESC
    LIMIT $2
    `,
    [olWorkKey, limit]
  );

  return rows.map((row) => ({
    olWorkKey: row.work_key,
    overlap: parseInt(row.overlap, 10),
  }));
}

/**
 * Get books from popular lists that contain a given work
 */
export async function getListMates(
  olWorkKey: string,
  limit = 20
): Promise<Array<{ olWorkKey: string; sharedLists: number }>> {
  const { rows } = await query<{
    seed_key: string;
    shared_lists: string;
  }>(
    `
    WITH containing_lists AS (
      SELECT list_id
      FROM "OLListSeed"
      WHERE seed_key LIKE '%' || $1
      OR seed_key = $1
    )
    SELECT
      s2.seed_key,
      COUNT(DISTINCT s2.list_id) as shared_lists
    FROM containing_lists cl
    JOIN "OLListSeed" s2 ON s2.list_id = cl.list_id
    WHERE s2.seed_key NOT LIKE '%' || $1
    AND s2.seed_key != $1
    AND s2.seed_type = 'work'
    GROUP BY s2.seed_key
    ORDER BY shared_lists DESC
    LIMIT $2
    `,
    [olWorkKey, limit]
  );

  return rows.map((row) => ({
    olWorkKey: row.seed_key,
    sharedLists: parseInt(row.shared_lists, 10),
  }));
}
