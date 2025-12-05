/**
 * User profile vector computation
 * Aggregates user reading history into a taste vector
 */

import { query, transaction } from "@/lib/db/pool";
import {
  normalizeVector,
  weightedAverageVectors,
  toVectorLiteral,
  parseVector,
} from "@/lib/db/vector";
import { logger, createTimer } from "@/lib/util/logger";

interface UserEventWithEmbedding {
  workId: number;
  title: string;
  shelf: string;
  rating: number | null;
  finishedAt: Date | null;
  embedding: number[];
  aggregate?: {
    totalMs: number | null;
    lastReadAt: Date | null;
    last30dMs: number | null;
  };
}

interface Anchor {
  workId: number;
  title: string;
  weight: number;
}

interface UserProfileData {
  userId: string;
  profileVec: number[];
  anchors: Anchor[];
}

/**
 * Calculate weight for a user event
 * Higher weights for: high ratings, recent reads, completed books
 */
function calculateEventWeight(event: {
  shelf: string;
  rating: number | null;
  finishedAt: Date | null;
  aggregate?: {
    totalMs: number | null;
    lastReadAt: Date | null;
    last30dMs: number | null;
  };
}): number {
  let weight = 1.0;

  // Rating-based weight (exponential scaling)
  if (event.rating !== null) {
    // 5 -> 2.0, 4 -> 1.5, 3 -> 1.0, 2 -> 0.5, 1 -> 0.25
    weight *= Math.pow(2, (event.rating - 3) / 2);
  }

  // Shelf-based adjustments
  switch (event.shelf) {
    case "read":
      weight *= 1.0;
      break;
    case "currently-reading":
      weight *= 0.8;
      break;
    case "to-read":
      weight *= 0.3; // Lower weight for wishlisted
      break;
    case "dnf":
      weight *= -0.5; // Negative signal for DNF
      break;
  }

  // Recency decay (half-life of 2 years)
  const recencyDate = event.finishedAt ?? event.aggregate?.lastReadAt ?? null;
  if (recencyDate) {
    const ageInYears =
      (Date.now() - recencyDate.getTime()) / (365 * 24 * 60 * 60 * 1000);
    weight *= Math.pow(0.5, ageInYears / 2);
  }

  // Reading intensity boost (diminishing returns)
  const durationMs = event.aggregate?.totalMs ?? 0;
  if (durationMs > 0) {
    const hours = durationMs / 3_600_000;
    const intensityBoost = 1 + Math.min(1, Math.log10(hours + 1));
    weight *= intensityBoost;
  }

  // Recent activity boost (last 30d)
  const recentMs = event.aggregate?.last30dMs ?? 0;
  if (recentMs > 0) {
    weight *= 1.1;
  }

  return weight;
}

// Maximum number of user events to consider for profile building
// This prevents unbounded queries for users with massive reading histories
const MAX_USER_EVENTS = 10000;

/**
 * Get user events with embeddings
 * Prioritizes recent and highly-rated books when limiting
 */
async function getUserEventsWithEmbeddings(
  userId: string
): Promise<UserEventWithEmbedding[]> {
  const { rows } = await query<{
    work_id: number;
    title: string;
    shelf: string;
    rating: string | null;
    finished_at: Date | null;
    embedding: string;
    aggregate_total_ms: string | null;
    aggregate_last_read_at: Date | null;
    aggregate_last_30d_ms: string | null;
  }>(
    `SELECT
      ue.work_id,
      w.title,
      ue.shelf,
      ue.rating,
      ue.finished_at,
      w.embedding::text AS embedding,
      agg.total_ms AS aggregate_total_ms,
      agg.last_read_at AS aggregate_last_read_at,
      agg.last_30d_ms AS aggregate_last_30d_ms
    FROM "UserEvent" ue
    JOIN "Work" w ON ue.work_id = w.id
    LEFT JOIN LATERAL (
      SELECT ag.total_ms, ag.last_read_at, ag.last_30d_ms
      FROM "Edition" e
      JOIN "UserReadingAggregate" ag
        ON ag.asin = e.asin AND ag.user_id = ue.user_id
      WHERE e.work_id = w.id
      ORDER BY ag.last_read_at DESC NULLS LAST
      LIMIT 1
    ) agg ON TRUE
    WHERE ue.user_id = $1
      AND w.embedding IS NOT NULL
    ORDER BY
      COALESCE(ue.rating, 3) DESC,
      ue.finished_at DESC NULLS LAST,
      ue.created_at DESC
    LIMIT $2`,
    [userId, MAX_USER_EVENTS]
  );

  return rows.map((r) => ({
    workId: r.work_id,
    title: r.title,
    shelf: r.shelf,
    rating: r.rating ? parseFloat(r.rating) : null,
    finishedAt: r.finished_at,
    embedding: parseVector(r.embedding),
    aggregate: {
      totalMs: r.aggregate_total_ms ? parseFloat(r.aggregate_total_ms) : null,
      lastReadAt: r.aggregate_last_read_at,
      last30dMs: r.aggregate_last_30d_ms ? parseFloat(r.aggregate_last_30d_ms) : null,
    },
  }));
}

/**
 * Build user profile vector from reading history
 */
export async function buildUserProfile(userId: string): Promise<UserProfileData> {
  logger.info("Building user profile", { userId });
  const timer = createTimer("User profile build");

  const events = await getUserEventsWithEmbeddings(userId);

  if (events.length === 0) {
    logger.warn("No events with embeddings found for user", { userId });
    return { userId, profileVec: [], anchors: [] };
  }

  // Calculate weights and prepare for aggregation
  const weightedEvents = events.map((event) => ({
    ...event,
    weight: calculateEventWeight(event),
  }));

  // Separate positive and negative signals
  const positiveEvents = weightedEvents.filter((e) => e.weight > 0);
  const negativeEvents = weightedEvents.filter((e) => e.weight < 0);

  if (positiveEvents.length === 0) {
    logger.warn("No positive events found for user", { userId });
    return { userId, profileVec: [], anchors: [] };
  }

  // Compute positive profile vector
  const positiveVec = weightedAverageVectors(
    positiveEvents.map((e) => e.embedding),
    positiveEvents.map((e) => e.weight)
  );

  // Compute negative profile vector if any
  let profileVec = positiveVec;
  if (negativeEvents.length > 0) {
    const negativeVec = weightedAverageVectors(
      negativeEvents.map((e) => e.embedding),
      negativeEvents.map((e) => Math.abs(e.weight))
    );

    // Subtract negative from positive (with lower weight)
    const negativeWeight = 0.3;
    profileVec = positiveVec.map(
      (v, i) => v - negativeWeight * negativeVec[i]
    );
  }

  // Normalize final vector
  profileVec = normalizeVector(profileVec);

  // Find anchor books (top contributors to profile)
  const sortedEvents = [...positiveEvents].sort((a, b) => b.weight - a.weight);
  const anchors: Anchor[] = sortedEvents.slice(0, 10).map((e) => ({
    workId: e.workId,
    title: e.title,
    weight: e.weight,
  }));

  // Store profile
  const vectorLit = toVectorLiteral(profileVec);

  await transaction(async (client) => {
    await client.query(
      `
      INSERT INTO "UserProfile" (user_id, profile_vec, anchors, updated_at)
      VALUES ($1, $2::vector, $3, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        profile_vec = EXCLUDED.profile_vec,
        anchors = EXCLUDED.anchors,
        updated_at = NOW()
      `,
      [userId, vectorLit, JSON.stringify(anchors)]
    );
  });

  timer.end({ eventCount: events.length, anchorCount: anchors.length });

  return { userId, profileVec, anchors };
}

/**
 * Get user profile from database
 */
export async function getUserProfile(
  userId: string
): Promise<UserProfileData | null> {
  const { rows } = await query<{
    user_id: string;
    profile_vec: string;
    anchors: Anchor[] | string;
  }>(
    `SELECT user_id, profile_vec::text, anchors FROM "UserProfile" WHERE user_id = $1`,
    [userId]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  // JSONB columns may be auto-parsed by pg driver
  const anchors = typeof row.anchors === "string"
    ? JSON.parse(row.anchors)
    : row.anchors;

  return {
    userId: row.user_id,
    profileVec: parseVector(row.profile_vec),
    anchors,
  };
}

/**
 * Get or build user profile (lazy computation)
 */
export async function getOrBuildUserProfile(
  userId: string
): Promise<UserProfileData | null> {
  const existing = await getUserProfile(userId);

  if (existing && existing.profileVec.length > 0) {
    return existing;
  }

  // Build profile if missing or empty
  const profile = await buildUserProfile(userId);
  return profile.profileVec.length > 0 ? profile : null;
}

/**
 * Check if user profile needs refresh
 * (e.g., new events since last update)
 */
export async function profileNeedsRefresh(userId: string): Promise<boolean> {
  const { rows } = await query<{ needs_refresh: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1 FROM "UserEvent" ue
      WHERE ue.user_id = $1
      AND ue.created_at > COALESCE(
        (SELECT updated_at FROM "UserProfile" WHERE user_id = $1),
        '1970-01-01'::timestamp
      )
      UNION ALL
      SELECT 1 FROM "UserReadingAggregate" ra
      WHERE ra.user_id = $1
      AND ra.updated_at > COALESCE(
        (SELECT updated_at FROM "UserProfile" WHERE user_id = $1),
        '1970-01-01'::timestamp
      )
    ) AS needs_refresh
    `,
    [userId]
  );

  return rows[0]?.needs_refresh ?? true;
}

/**
 * Get user's taste summary (for UI display)
 */
export async function getUserTasteSummary(userId: string): Promise<{
  topAuthors: string[];
  topSubjects: string[];
  readCount: number;
  avgRating: number | null;
}> {
  const { rows } = await query<{
    top_authors: string;
    top_subjects: string;
    read_count: string;
    avg_rating: string | null;
  }>(
    `
    WITH user_works AS (
      SELECT ue.work_id, ue.rating
      FROM "UserEvent" ue
      WHERE ue.user_id = $1 AND ue.shelf = 'read'
    ),
    top_authors AS (
      SELECT a.name, COUNT(*) AS cnt
      FROM user_works uw
      JOIN "WorkAuthor" wa ON uw.work_id = wa.work_id
      JOIN "Author" a ON wa.author_id = a.id
      GROUP BY a.id, a.name
      ORDER BY cnt DESC
      LIMIT 5
    ),
    top_subjects AS (
      SELECT ws.subject, COUNT(*) AS cnt
      FROM user_works uw
      JOIN "WorkSubject" ws ON uw.work_id = ws.work_id
      GROUP BY ws.subject
      ORDER BY cnt DESC
      LIMIT 5
    )
    SELECT
      (SELECT string_agg(name, ', ' ORDER BY cnt DESC) FROM top_authors) AS top_authors,
      (SELECT string_agg(subject, ', ' ORDER BY cnt DESC) FROM top_subjects) AS top_subjects,
      COUNT(*)::text AS read_count,
      AVG(uw.rating)::text AS avg_rating
    FROM user_works uw
    `,
    [userId]
  );

  const row = rows[0];
  return {
    topAuthors: row?.top_authors?.split(", ") ?? [],
    topSubjects: row?.top_subjects?.split(", ") ?? [],
    readCount: parseInt(row?.read_count ?? "0", 10),
    avgRating: row?.avg_rating ? parseFloat(row.avg_rating) : null,
  };
}
