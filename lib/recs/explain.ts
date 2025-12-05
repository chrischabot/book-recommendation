/**
 * Explanation generation for recommendations
 * Uses OpenAI to generate "because you liked..." style reasons
 */

import OpenAI from "openai";
import Bottleneck from "bottleneck";
import { createHash } from "crypto";
import { query } from "@/lib/db/pool";
import { getEnv } from "@/lib/config/env";
import { getUserProfile } from "@/lib/features/userProfile";
import {
  getCachedExplanation,
  setCachedExplanation,
  type ExplanationCacheEntry,
} from "@/lib/features/cache";
import { logger, createTimer } from "@/lib/util/logger";
import type { RankedRecommendation } from "./rerank";

// Rate limiter for OpenAI API - increased concurrency for speed
const limiter = new Bottleneck({
  minTime: 100,
  maxConcurrent: 10,
});

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    const env = getEnv();
    openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return openai;
}

export interface ExplainedRecommendation extends RankedRecommendation {
  reasons: string[];
  description?: string;
  coverUrl?: string;
  // Enhanced metadata from Open Library
  popularity?: {
    readCount: number;
    wantCount: number;
    currentlyReading: number;
  };
  wikidataId?: string;
  subjects?: string[];
}

/**
 * Generate hash for anchor books (for caching)
 */
function hashAnchors(anchors: { workId: number; weight: number }[]): string {
  const sorted = [...anchors].sort((a, b) => a.workId - b.workId);
  const str = sorted.map((a) => `${a.workId}:${a.weight.toFixed(2)}`).join(",");
  return createHash("md5").update(str).digest("hex").slice(0, 12);
}

interface WorkDetails {
  title: string;
  authors: string[];
  subjects: string[];
  description: string | null;
}

interface EngagementHighlight {
  title: string;
  authors: string[];
  hours: number;
  lastReadAt: Date | null;
}

/**
 * Get work details for a single work (for backward compatibility)
 */
async function getWorkDetails(workId: number): Promise<WorkDetails | null> {
  const details = await getWorkDetailsBatch([workId]);
  return details.get(workId) ?? null;
}

/**
 * Batch fetch work details for multiple works
 * Uses materialized views when available for better performance
 */
async function getWorkDetailsBatch(
  workIds: number[]
): Promise<Map<number, WorkDetails>> {
  if (workIds.length === 0) return new Map();

  // Try to use materialized views first (faster)
  try {
    const { rows } = await query<{
      id: number;
      title: string;
      description: string | null;
      author_names: string | null;
      subjects: string[] | null;
    }>(
      `SELECT w.id, w.title, w.description,
              waa.author_names,
              wsa.subjects
       FROM "Work" w
       LEFT JOIN work_authors_agg waa ON w.id = waa.work_id
       LEFT JOIN work_subjects_agg wsa ON w.id = wsa.work_id
       WHERE w.id = ANY($1)`,
      [workIds]
    );

    const result = new Map<number, WorkDetails>();
    for (const row of rows) {
      result.set(row.id, {
        title: row.title,
        authors: row.author_names?.split(", ").filter(Boolean) ?? [],
        subjects: row.subjects ?? [],
        description: row.description,
      });
    }
    return result;
  } catch {
    // Fall back to JOIN-based query if materialized views don't exist
  }

  // Fallback: use JOINs with aggregation
  const { rows } = await query<{
    id: number;
    title: string;
    description: string | null;
    authors: string;
    subjects: string;
  }>(
    `SELECT w.id, w.title, w.description,
            COALESCE(string_agg(DISTINCT a.name, ', '), '') AS authors,
            COALESCE(string_agg(DISTINCT ws.subject, ', '), '') AS subjects
     FROM "Work" w
     LEFT JOIN "WorkAuthor" wa ON w.id = wa.work_id
     LEFT JOIN "Author" a ON wa.author_id = a.id
     LEFT JOIN "WorkSubject" ws ON w.id = ws.work_id
     WHERE w.id = ANY($1)
     GROUP BY w.id`,
    [workIds]
  );

  const result = new Map<number, WorkDetails>();
  for (const row of rows) {
    result.set(row.id, {
      title: row.title,
      authors: row.authors?.split(", ").filter(Boolean) ?? [],
      subjects: row.subjects?.split(", ").filter(Boolean) ?? [],
      description: row.description,
    });
  }
  return result;
}

/**
 * Batch fetch cover URLs for multiple works
 * Priority: cover_url (external) > cover_id (OL) > isbn13 (OL) > work key (OL)
 * Work-level OL covers are less reliable but better than no cover.
 */
async function getCoversBatch(
  workIds: number[]
): Promise<Map<number, string>> {
  if (workIds.length === 0) return new Map();

  // Query editions for cover sources, include work key as fallback
  const { rows } = await query<{
    work_id: number;
    cover_id: string | null;
    isbn13: string | null;
    cover_url: string | null;
    ol_work_key: string | null;
  }>(
    `SELECT DISTINCT ON (w.id)
       w.id as work_id,
       e.cover_id,
       e.isbn13,
       e.cover_url,
       w.ol_work_key
     FROM "Work" w
     LEFT JOIN "Edition" e ON w.id = e.work_id
     WHERE w.id = ANY($1)
     ORDER BY w.id, e.cover_url NULLS LAST, e.cover_id NULLS LAST`,
    [workIds]
  );

  const result = new Map<number, string>();
  for (const row of rows) {
    // Prefer external cover URL (from Google Books, etc.)
    if (row.cover_url) {
      result.set(row.work_id, row.cover_url);
    }
    // Fall back to Open Library cover ID
    else if (row.cover_id) {
      result.set(row.work_id, `https://covers.openlibrary.org/b/id/${row.cover_id}-M.jpg`);
    }
    // Fall back to ISBN-based OL URL
    else if (row.isbn13) {
      result.set(row.work_id, `https://covers.openlibrary.org/b/isbn/${row.isbn13}-M.jpg`);
    }
    // Fall back to work-level OL cover (less reliable but better than placeholder)
    else if (row.ol_work_key) {
      const key = row.ol_work_key.replace("/works/", "");
      result.set(row.work_id, `https://covers.openlibrary.org/w/olid/${key}-M.jpg`);
    }
    // No cover - will show styled placeholder in UI
  }
  return result;
}

/**
 * Generate explanation for a single recommendation
 */
async function generateExplanation(
  recommendation: RankedRecommendation,
  anchorBooks: { title: string; authors: string[] }[],
  recDetails: { title: string; authors: string[]; subjects: string[] },
  engagementHighlights: EngagementHighlight[]
): Promise<{ reasons: string[]; quality: string; confidence: number }> {
  const env = getEnv();
  const client = getOpenAI();

  // Choose model based on batch size (already handled in batch function)
  const model = env.OPENAI_REASONING_MODEL;

  const anchorList = anchorBooks
    .map((b) => `"${b.title}" by ${b.authors.join(", ")}`)
    .join("; ");

  const engagementList =
    engagementHighlights.length > 0
      ? engagementHighlights
          .map((e) => `"${e.title}" (${e.hours.toFixed(1)}h${e.authors.length ? `, ${e.authors.join(", ")}` : ""})`)
          .join("; ")
      : "None";

  const prompt = `Generate 2-3 short, compelling reasons why someone who enjoyed these books would like "${recDetails.title}" by ${recDetails.authors.join(", ")}.

Books they loved: ${anchorList}
Recent high-engagement reading: ${engagementList}

Recommendation subjects: ${recDetails.subjects.slice(0, 5).join(", ")}

Rules:
- Each reason should be one sentence
- Start with "Because you liked..." or similar personalized phrasing
- Focus on thematic connections, writing style, or genre similarities
- Be specific, not generic
- Don't just list genres

Format: Return only the reasons, one per line.`;

  try {
    const response = await limiter.schedule(() =>
      client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 200,
      })
    );

    const content = response.choices[0]?.message?.content ?? "";
    const reasons = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 10)
      .slice(0, 3);

    if (reasons.length === 0) {
      // Fallback reasons
      reasons.push(
        `Shares similar themes with books you've enjoyed`,
        `Recommended based on your reading preferences`
      );
    }

    return {
      reasons,
      quality: recommendation.suggestionQuality,
      confidence: recommendation.confidence,
    };
  } catch (error) {
    logger.warn("Failed to generate explanation", { error: String(error) });

    // Fallback
    return {
      reasons: [
        `Matches your reading preferences`,
        `Similar to books you've rated highly`,
      ],
      quality: recommendation.suggestionQuality,
      confidence: recommendation.confidence * 0.8,
    };
  }
}

async function getEngagementHighlights(
  userId: string,
  limit = 3
): Promise<EngagementHighlight[]> {
  const { rows } = await query<{
    title: string;
    authors: string;
    total_ms: string;
    last_read_at: Date | null;
  }>(
    `
    SELECT w.title,
           COALESCE(string_agg(DISTINCT a.name, ', '), '') AS authors,
           ua.total_ms,
           ua.last_read_at
    FROM "UserReadingAggregate" ua
    JOIN "Edition" e ON ua.asin = e.asin
    JOIN "Work" w ON e.work_id = w.id
    LEFT JOIN "WorkAuthor" wa ON w.id = wa.work_id
    LEFT JOIN "Author" a ON wa.author_id = a.id
    WHERE ua.user_id = $1
    GROUP BY w.id, ua.total_ms, ua.last_read_at
    ORDER BY ua.total_ms DESC NULLS LAST, ua.last_read_at DESC NULLS LAST
    LIMIT $2
    `,
    [userId, limit]
  );

  return rows.map((row) => ({
    title: row.title,
    authors: row.authors ? row.authors.split(", ").filter(Boolean) : [],
    hours: parseFloat(row.total_ms) / 3_600_000,
    lastReadAt: row.last_read_at,
  }));
}

/**
 * Add explanations to a batch of recommendations
 * Uses batch fetching to minimize database queries (10-100x fewer queries)
 */
export async function explainRecommendations(
  userId: string,
  recommendations: RankedRecommendation[],
  options: { includeDescription?: boolean; includeCover?: boolean; fast?: boolean } = {}
): Promise<ExplainedRecommendation[]> {
  const { includeDescription = true, includeCover = true, fast = false } = options;

  if (recommendations.length === 0) return [];

  logger.info("Generating explanations", { count: recommendations.length, fast });
  const timer = createTimer("Explanation generation");

  // Get user anchors
  const profile = await getUserProfile(userId);
  const anchors = profile?.anchors ?? [];

  // Fast mode: skip OpenAI, use quick reasons
  if (fast) {
    const recWorkIds = recommendations.map((r) => r.workId);
    const allDetails = await getWorkDetailsBatch(recWorkIds);
    const coverMap = includeCover ? await getCoversBatch(recWorkIds) : new Map();

    const results = recommendations.map((rec) => {
      const details = allDetails.get(rec.workId);
      const result: ExplainedRecommendation = {
        ...rec,
        reasons: quickReason(rec, profile ? { anchors: anchors.map(a => ({ title: a.title || "a book you enjoyed" })) } : null),
      };
      if (includeDescription && details?.description) {
        result.description = details.description;
      }
      if (includeCover) {
        result.coverUrl = coverMap.get(rec.workId);
      }
      return result;
    });

    timer.end({ explainedCount: results.length, fast: true });
    return results;
  }

  const anchorsHash = hashAnchors(anchors);
  const engagementHighlights = await getEngagementHighlights(userId, 3);

  // Collect all work IDs we need to fetch details for
  const anchorWorkIds = anchors.slice(0, 5).map((a) => a.workId);
  const recWorkIds = recommendations.map((r) => r.workId);
  const allWorkIds = [...new Set([...anchorWorkIds, ...recWorkIds])];

  // BATCH FETCH: Get all work details in one query
  const allDetails = await getWorkDetailsBatch(allWorkIds);

  // Build anchor details from batch results
  const anchorDetails: { title: string; authors: string[] }[] = [];
  for (const anchor of anchors.slice(0, 5)) {
    const details = allDetails.get(anchor.workId);
    if (details) {
      anchorDetails.push({ title: details.title, authors: details.authors });
    }
  }

  // BATCH FETCH: Get all covers in one query if needed
  const coverMap = includeCover ? await getCoversBatch(recWorkIds) : new Map();

  // BATCH FETCH: Check cache for all recommendations at once
  const cachePromises = recommendations.map((rec) =>
    getCachedExplanation(userId, rec.workId, anchorsHash).then((cached) => ({
      workId: rec.workId,
      cached,
    }))
  );
  const cacheResults = await Promise.all(cachePromises);
  const cacheMap = new Map(cacheResults.map((r) => [r.workId, r.cached]));

  const explained: ExplainedRecommendation[] = [];
  const uncachedRecs: RankedRecommendation[] = [];

  // Process cached recommendations first (no LLM calls needed)
  for (const rec of recommendations) {
    const cached = cacheMap.get(rec.workId);
    if (cached) {
      const result: ExplainedRecommendation = {
        ...rec,
        reasons: cached.reasons,
      };

      const details = allDetails.get(rec.workId);
      if (includeDescription && details?.description) {
        result.description = details.description;
      }
      if (includeCover) {
        result.coverUrl = coverMap.get(rec.workId);
      }

      explained.push(result);
    } else {
      uncachedRecs.push(rec);
    }
  }

  // Generate explanations for uncached recommendations
  for (const rec of uncachedRecs) {
    const recDetails = allDetails.get(rec.workId);
    if (!recDetails) {
      explained.push({
        ...rec,
        reasons: ["Recommended based on your reading history"],
      });
      continue;
    }

    const explanation = await generateExplanation(
      rec,
      anchorDetails,
      recDetails,
      engagementHighlights
    );

    // Cache the result (don't await to avoid blocking)
    setCachedExplanation(userId, rec.workId, anchorsHash, {
      reasons: explanation.reasons,
      quality: explanation.quality,
      confidence: explanation.confidence,
    }).catch((err) => logger.warn("Failed to cache explanation", { error: String(err) }));

    const result: ExplainedRecommendation = {
      ...rec,
      reasons: explanation.reasons,
    };

    if (includeDescription && recDetails.description) {
      result.description = recDetails.description;
    }
    if (includeCover) {
      result.coverUrl = coverMap.get(rec.workId);
    }

    explained.push(result);
  }

  timer.end({ explainedCount: explained.length, cached: recommendations.length - uncachedRecs.length });
  return explained;
}

/**
 * Generate a single quick reason without LLM
 * For when speed is more important than quality
 */
export function quickReason(
  rec: RankedRecommendation,
  profile: { anchors: { title: string }[] } | null
): string[] {
  const reasons: string[] = [];

  if (profile && profile.anchors.length > 0) {
    const anchor = profile.anchors[0];
    reasons.push(`Similar to "${anchor.title}" which you enjoyed`);
  }

  if (rec.relevanceScore > 0.8) {
    reasons.push("Strongly matches your reading preferences");
  } else if (rec.qualityScore > 0.7) {
    reasons.push("Highly rated by readers with similar taste");
  }

  if (reasons.length === 0) {
    reasons.push("Recommended based on your reading history");
  }

  return reasons;
}
