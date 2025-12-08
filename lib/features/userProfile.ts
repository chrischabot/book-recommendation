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
    avgSessionMs: number | null;
    maxSessionMs: number | null;
    sessions: number | null;
  };
  completionCount: number;
  // New engagement signals
  authorBooksRead: number;
  prevFinishedAt: Date | null;
  originType: string | null;
}

/**
 * Engagement signal flags for display in the UI
 */
export interface EngagementSignals {
  fiveStar: boolean;        // Explicit 5-star rating
  reread: boolean;          // Multiple completions
  binge: boolean;           // Max session 4+ hours
  sessionQuality: boolean;  // Avg session 15+ minutes
  authorLoyalty: boolean;   // 3+ books by same author
  seriesVelocity: boolean;  // Finished within 3 days of previous
  purchased: boolean;       // Purchased (not KU)
}

export interface Anchor {
  workId: number;
  title: string;
  weight: number;
  signals?: EngagementSignals;
}

interface UserProfileData {
  userId: string;
  profileVec: number[];
  anchors: Anchor[];
}

/**
 * Calculate weight for a user event
 * Higher weights for: high ratings, recent reads, completed books, re-reads,
 * long reading sessions, binge reads, author loyalty, and purchase commitment.
 *
 * Weight calculation is done in stages to correctly handle negative signals:
 * 1. Base weight from rating (magnitude only)
 * 2. Explicit 5-star boost (strong signal)
 * 3. Recency decay (applies to magnitude) - gentler for high-engagement books
 * 4. Reading intensity boost (applies to magnitude)
 * 5. RE-READ MULTIPLIER - huge signal for favorites
 * 6. SESSION QUALITY - avg session length indicates engagement
 * 7. BINGE FACTOR - max session indicates "couldn't put down"
 * 8. AUTHOR LOYALTY - reading 3+ books by same author
 * 9. SERIES VELOCITY - finishing books in quick succession
 * 10. PURCHASE COMMITMENT - paid money vs KindleUnlimited
 * 11. Shelf modifier (determines final sign and scaling)
 * 12. DNF PARADOX - DNF after 6+ hours = liked it, moved on for variety
 */
function calculateEventWeight(event: {
  shelf: string;
  rating: number | null;
  finishedAt: Date | null;
  aggregate?: {
    totalMs: number | null;
    lastReadAt: Date | null;
    last30dMs: number | null;
    avgSessionMs: number | null;
    maxSessionMs: number | null;
    sessions: number | null;
  };
  completionCount?: number;
  authorBooksRead?: number;
  prevFinishedAt?: Date | null;
  originType?: string | null;
}): number {
  // Start with base magnitude of 1.0
  let magnitude = 1.0;

  // Stage 1: Rating-based weight (exponential scaling for magnitude)
  if (event.rating !== null) {
    // 5 -> 2.0, 4 -> 1.5, 3 -> 1.0, 2 -> 0.5, 1 -> 0.25
    magnitude *= Math.pow(2, (event.rating - 3) / 2);
  }

  // Stage 2: EXPLICIT 5-STAR BOOST - strongest signal we have
  if (event.rating === 5) {
    magnitude *= 2.0; // Additional 2x for explicit 5-star (total 4x base)
  }

  // Calculate engagement score to determine recency decay rate
  // High-engagement books decay slower (favorites stay relevant longer)
  const completionCount = event.completionCount ?? 1;
  const avgSessionMin = (event.aggregate?.avgSessionMs ?? 0) / 60_000;
  const maxSessionMin = (event.aggregate?.maxSessionMs ?? 0) / 60_000;
  const totalHours = (event.aggregate?.totalMs ?? 0) / 3_600_000;
  const hasHighEngagement = completionCount >= 3 || avgSessionMin >= 15 || maxSessionMin >= 120;

  // Stage 3: Recency decay - half-life of 2 years for normal, 4 years for high-engagement
  const recencyDate = event.finishedAt ?? event.aggregate?.lastReadAt ?? null;
  if (recencyDate) {
    const ageInYears =
      (Date.now() - recencyDate.getTime()) / (365 * 24 * 60 * 60 * 1000);
    const halfLife = hasHighEngagement ? 4 : 2;
    magnitude *= Math.pow(0.5, ageInYears / halfLife);
  }

  // Stage 4: Reading intensity boost (diminishing returns)
  const durationMs = event.aggregate?.totalMs ?? 0;
  if (durationMs > 0) {
    const hours = durationMs / 3_600_000;
    const intensityBoost = 1 + Math.min(1, Math.log10(hours + 1));
    magnitude *= intensityBoost;
  }

  // Stage 5: Recent activity boost (last 30d)
  const recentMs = event.aggregate?.last30dMs ?? 0;
  if (recentMs > 0) {
    magnitude *= 1.1;
  }

  // Stage 6: RE-READ MULTIPLIER - each re-read is a strong signal of a favorite
  // 1 read = 1x, 2 reads = 1.5x, 3 reads = 2.25x, 4 reads = 3x (capped)
  if (completionCount > 1) {
    const rereadMultiplier = Math.min(3.0, Math.pow(1.5, completionCount - 1));
    magnitude *= rereadMultiplier;
  }

  // Stage 7: SESSION QUALITY - longer avg sessions = more engaging book
  // 15+ min avg = good, 30+ min avg = great (up to 1.5x boost)
  if (avgSessionMin > 0) {
    const sessionQuality = 1 + Math.min(0.5, avgSessionMin / 30);
    magnitude *= sessionQuality;
  }

  // Stage 8: BINGE FACTOR - long max session = "couldn't put it down"
  // 2+ hour max session = good, 4+ hour = great (up to 1.5x boost)
  if (maxSessionMin > 0) {
    const bingeFactor = 1 + Math.min(0.5, maxSessionMin / 240);
    magnitude *= bingeFactor;
  }

  // Stage 9: AUTHOR LOYALTY - reading 3+ books by same author
  // 3 books = 1.25x, 4 books = 1.5x, 6+ books = 2x (capped)
  const authorBooksRead = event.authorBooksRead ?? 0;
  if (authorBooksRead >= 3) {
    const loyaltyMultiplier = Math.min(2.0, 1 + (authorBooksRead - 2) * 0.25);
    magnitude *= loyaltyMultiplier;
  }

  // Stage 10: SERIES VELOCITY - finishing books in quick succession
  // If finished within 3 days of previous book, indicates binge-reading series
  if (event.finishedAt && event.prevFinishedAt) {
    const daysBetween = (event.finishedAt.getTime() - event.prevFinishedAt.getTime()) / (24 * 60 * 60 * 1000);
    if (daysBetween >= 0 && daysBetween <= 3) {
      magnitude *= 1.3; // Series velocity boost
    }
  }

  // Stage 11: PURCHASE COMMITMENT - paid money vs KindleUnlimited
  if (event.originType === "Purchase") {
    magnitude *= 1.15; // Financial commitment = higher confidence
  }

  // Stage 12: Shelf-based adjustments (applied last to determine sign and scale)
  // DNF PARADOX: DNF after 6+ hours = liked it, moved on for variety (neutral)
  //              DNF under 6 hours = genuine dislike (negative signal)
  switch (event.shelf) {
    case "read":
      return magnitude * 1.0;
    case "currently-reading":
      return magnitude * 0.8;
    case "to-read":
      return magnitude * 0.3; // Lower weight for wishlisted
    case "dnf":
      // DNF after 6+ hours = liked it, just wanted variety (neutral)
      // DNF under 6 hours = genuine dislike (negative signal)
      if (totalHours >= 6) {
        return 0; // Neutral - don't penalize series you spent time with
      } else {
        return magnitude * -0.5; // Negative signal for quick DNF
      }
    default:
      return magnitude;
  }
}

/**
 * Compute engagement signals for display in the UI
 * These indicate which signals contributed to a book's high weight
 */
function computeSignals(event: UserEventWithEmbedding): EngagementSignals {
  const avgSessionMin = (event.aggregate?.avgSessionMs ?? 0) / 60_000;
  const maxSessionMin = (event.aggregate?.maxSessionMs ?? 0) / 60_000;

  // Check for series velocity (finished within 3 days of previous)
  let hasSeriesVelocity = false;
  if (event.finishedAt && event.prevFinishedAt) {
    const daysBetween = (event.finishedAt.getTime() - event.prevFinishedAt.getTime()) / (24 * 60 * 60 * 1000);
    hasSeriesVelocity = daysBetween >= 0 && daysBetween <= 3;
  }

  return {
    fiveStar: event.rating === 5,
    reread: event.completionCount >= 2,
    binge: maxSessionMin >= 240, // 4+ hours max session
    sessionQuality: avgSessionMin >= 15, // 15+ min avg session
    authorLoyalty: event.authorBooksRead >= 3,
    seriesVelocity: hasSeriesVelocity,
    purchased: event.originType === "Purchase",
  };
}

// Maximum number of user events to consider for profile building
// This prevents unbounded queries for users with massive reading histories
const MAX_USER_EVENTS = 10000;

/**
 * Get user events with embeddings
 * Prioritizes recent and highly-rated books when limiting
 * Includes author loyalty, series velocity, and purchase signals
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
    aggregate_avg_session_ms: string | null;
    aggregate_max_session_ms: string | null;
    aggregate_sessions: string | null;
    completion_count: string;
    author_books_read: string;
    prev_finished_at: Date | null;
    origin_type: string | null;
  }>(
    `WITH author_counts AS (
      -- Count how many books user has read by each author
      SELECT wa.author_id, COUNT(DISTINCT ue2.work_id)::int AS books_read
      FROM "UserEvent" ue2
      JOIN "WorkAuthor" wa ON ue2.work_id = wa.work_id
      WHERE ue2.user_id = $1 AND ue2.shelf IN ('read', 'currently-reading')
      GROUP BY wa.author_id
    ),
    events_with_prev AS (
      -- Get previous finished_at for series velocity
      SELECT
        ue.work_id,
        ue.shelf,
        ue.rating,
        ue.finished_at,
        LAG(ue.finished_at) OVER (ORDER BY ue.finished_at) AS prev_finished_at
      FROM "UserEvent" ue
      WHERE ue.user_id = $1
    )
    SELECT
      ue.work_id,
      w.title,
      ep.shelf,
      ep.rating,
      ep.finished_at,
      w.embedding::text AS embedding,
      agg.total_ms AS aggregate_total_ms,
      agg.last_read_at AS aggregate_last_read_at,
      agg.last_30d_ms AS aggregate_last_30d_ms,
      agg.avg_session_ms AS aggregate_avg_session_ms,
      agg.max_session_ms AS aggregate_max_session_ms,
      agg.sessions AS aggregate_sessions,
      COALESCE(comp.completion_count, 1)::text AS completion_count,
      COALESCE(author_loyalty.max_books_read, 0)::text AS author_books_read,
      ep.prev_finished_at,
      ko.origin_type
    FROM "UserEvent" ue
    JOIN "Work" w ON ue.work_id = w.id
    JOIN events_with_prev ep ON ep.work_id = ue.work_id AND ep.shelf = ue.shelf
    LEFT JOIN LATERAL (
      SELECT ag.total_ms, ag.last_read_at, ag.last_30d_ms,
             ag.avg_session_ms, ag.max_session_ms, ag.sessions
      FROM "Edition" e
      JOIN "UserReadingAggregate" ag
        ON ag.asin = e.asin AND ag.user_id = ue.user_id
      WHERE e.work_id = w.id
      ORDER BY ag.last_read_at DESC NULLS LAST
      LIMIT 1
    ) agg ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS completion_count
      FROM "Edition" e2
      JOIN "UserCompletionEvent" uce ON uce.asin = e2.asin AND uce.user_id = ue.user_id
      WHERE e2.work_id = w.id
    ) comp ON TRUE
    LEFT JOIN LATERAL (
      -- Get max author books read for this work's authors (author loyalty)
      SELECT MAX(ac.books_read) AS max_books_read
      FROM "WorkAuthor" wa
      JOIN author_counts ac ON ac.author_id = wa.author_id
      WHERE wa.work_id = w.id
    ) author_loyalty ON TRUE
    LEFT JOIN LATERAL (
      -- Get purchase origin type
      SELECT ko2.origin_type
      FROM "Edition" e3
      JOIN "KindleOwnership" ko2 ON ko2.asin = e3.asin AND ko2.user_id = ue.user_id
      WHERE e3.work_id = w.id
      ORDER BY CASE ko2.origin_type WHEN 'Purchase' THEN 0 ELSE 1 END
      LIMIT 1
    ) ko ON TRUE
    WHERE ue.user_id = $1
      AND w.embedding IS NOT NULL
    ORDER BY
      COALESCE(ep.rating, 3) DESC,
      ep.finished_at DESC NULLS LAST,
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
      avgSessionMs: r.aggregate_avg_session_ms ? parseFloat(r.aggregate_avg_session_ms) : null,
      maxSessionMs: r.aggregate_max_session_ms ? parseFloat(r.aggregate_max_session_ms) : null,
      sessions: r.aggregate_sessions ? parseInt(r.aggregate_sessions, 10) : null,
    },
    completionCount: parseInt(r.completion_count, 10),
    authorBooksRead: parseInt(r.author_books_read, 10),
    prevFinishedAt: r.prev_finished_at,
    originType: r.origin_type,
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
    signals: computeSignals(e),
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
