/**
 * Re-ranking and diversity optimization
 * Uses MMR (Maximal Marginal Relevance) for diverse recommendations
 */

import { query } from "@/lib/db/pool";
import { parseVector, cosineSimilarity } from "@/lib/db/vector";
import { getWorkQualities } from "@/lib/features/ratings";
import { getGraphFeatures } from "@/lib/features/graph";
import { logger, createTimer } from "@/lib/util/logger";
import type { Candidate } from "./candidates";

export interface RankedRecommendation {
  workId: number;
  title: string;
  authors: string[];
  year: number | null;
  avgRating: number | null;
  ratingCount: number | null;
  relevanceScore: number;
  qualityScore: number;
  engagementScore?: number;
  lastReadAt?: Date | null;
  totalMs?: number | null;
  last30dMs?: number | null;
  diversityScore: number;
  finalScore: number;
  suggestionQuality: "A+" | "A" | "A-" | "B+" | "B" | "B-";
  confidence: number;
}

interface WorkMetadata {
  id: number;
  title: string;
  authors: string[];
  year: number | null;
  embedding: number[] | null;
}

interface WorkEngagement {
  workId: number;
  totalMs: number | null;
  lastReadAt: Date | null;
  last30dMs: number | null;
}

interface RerankWeights {
  relevance: number;
  quality: number;
  novelty: number;
  graph: number;
  engagement: number;
}

const DEFAULT_WEIGHTS: RerankWeights = {
  relevance: 0.4,
  quality: 0.25,
  novelty: 0.15,
  graph: 0.2,
  engagement: 0.1,
};

/**
 * Get work metadata for candidates
 */
async function getWorkMetadata(
  workIds: number[]
): Promise<Map<number, WorkMetadata>> {
  if (workIds.length === 0) return new Map();

  const { rows } = await query<{
    id: number;
    title: string;
    first_publish_year: number | null;
    embedding: string | null;
    authors: string;
  }>(
    `
    SELECT
      w.id,
      w.title,
      w.first_publish_year,
      w.embedding::text,
      COALESCE(string_agg(a.name, ', '), '') AS authors
    FROM "Work" w
    LEFT JOIN "WorkAuthor" wa ON w.id = wa.work_id
    LEFT JOIN "Author" a ON wa.author_id = a.id
    WHERE w.id = ANY($1)
    GROUP BY w.id
    `,
    [workIds]
  );

  const result = new Map<number, WorkMetadata>();
  for (const row of rows) {
    result.set(row.id, {
      id: row.id,
      title: row.title,
      authors: row.authors ? row.authors.split(", ").filter(Boolean) : [],
      year: row.first_publish_year,
      embedding: row.embedding ? parseVector(row.embedding) : null,
    });
  }

  return result;
}

async function getUserEngagements(
  userId: string | undefined,
  workIds: number[]
): Promise<Map<number, WorkEngagement>> {
  if (!userId || workIds.length === 0) return new Map();

  const { rows } = await query<{
    work_id: number;
    total_ms: string | null;
    last_read_at: Date | null;
    last_30d_ms: string | null;
  }>(
    `
    SELECT DISTINCT ON (e.work_id)
      e.work_id,
      ua.total_ms,
      ua.last_read_at,
      ua.last_30d_ms
    FROM "Edition" e
    JOIN "UserReadingAggregate" ua
      ON ua.asin = e.asin
    WHERE ua.user_id = $1
      AND e.work_id = ANY($2)
    ORDER BY e.work_id, ua.last_read_at DESC NULLS LAST
    `,
    [userId, workIds]
  );

  const map = new Map<number, WorkEngagement>();
  for (const row of rows) {
    map.set(row.work_id, {
      workId: row.work_id,
      totalMs: row.total_ms ? parseFloat(row.total_ms) : null,
      lastReadAt: row.last_read_at,
      last30dMs: row.last_30d_ms ? parseFloat(row.last_30d_ms) : null,
    });
  }
  return map;
}

function calculateEngagementScore(engagement?: WorkEngagement | null): number {
  if (!engagement) return 0;
  const totalMs = engagement.totalMs ?? 0;
  const last30d = engagement.last30dMs ?? 0;

  let score = 0;

  if (totalMs > 0) {
    const hours = totalMs / 3_600_000;
    score += Math.min(1, Math.log10(hours + 1) / 2); // capped boost
  }

  if (last30d > 0) {
    score += 0.1;
  }

  if (engagement.lastReadAt) {
    const ageDays = (Date.now() - engagement.lastReadAt.getTime()) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 1 - ageDays / 90); // fades over ~3 months
    score += 0.2 * recencyBoost;
  }

  return Math.min(1, score);
}

/**
 * Calculate quality score from ratings
 */
function calculateQualityScore(
  blendedAvg: number | undefined,
  blendedWilson: number | undefined,
  totalRatings: number | undefined
): number {
  if (blendedAvg === undefined) return 0.5;

  // Combine average rating and Wilson lower bound
  const ratingComponent = (blendedAvg - 1) / 4; // Normalize to 0-1
  const wilsonComponent = blendedWilson ?? 0;

  // Weight by rating count (log scale)
  const countWeight = Math.min(1, Math.log10((totalRatings ?? 1) + 1) / 4);

  return (ratingComponent * 0.6 + wilsonComponent * 0.4) * (0.5 + 0.5 * countWeight);
}

/**
 * Calculate novelty score
 * Higher for more unique/different works
 */
function calculateNoveltyScore(
  embedding: number[] | null,
  selectedEmbeddings: number[][]
): number {
  if (!embedding || selectedEmbeddings.length === 0) return 1.0;

  // Average similarity to already selected items
  let totalSim = 0;
  for (const selected of selectedEmbeddings) {
    totalSim += cosineSimilarity(embedding, selected);
  }
  const avgSim = totalSim / selectedEmbeddings.length;

  // Novelty is inverse of similarity
  return 1 - avgSim;
}

/**
 * Convert final score to suggestion quality grade
 */
function scoreToGrade(score: number): "A+" | "A" | "A-" | "B+" | "B" | "B-" {
  if (score >= 0.85) return "A+";
  if (score >= 0.75) return "A";
  if (score >= 0.65) return "A-";
  if (score >= 0.55) return "B+";
  if (score >= 0.45) return "B";
  return "B-";
}

/**
 * Re-rank candidates using MMR for diversity
 */
export async function rerankCandidates(
  candidates: Candidate[],
  options: {
    limit?: number;
    weights?: Partial<RerankWeights>;
    diversityLambda?: number;
    userId?: string;
  } = {}
): Promise<RankedRecommendation[]> {
  const {
    limit = 100,
    weights: customWeights = {},
    diversityLambda = 0.3,
    userId,
  } = options;

  if (candidates.length === 0) return [];

  logger.info("Re-ranking candidates", { candidateCount: candidates.length, limit });
  const timer = createTimer("Candidate re-ranking");

  const weights = { ...DEFAULT_WEIGHTS, ...customWeights };
  const workIds = candidates.map((c) => c.workId);

  // Fetch all required data
  const [metadata, qualities, graphFeatures, engagements] = await Promise.all([
    getWorkMetadata(workIds),
    getWorkQualities(workIds),
    getGraphFeatures(workIds),
    getUserEngagements(userId, workIds),
  ]);

  // Build initial scores
  const scoredCandidates = candidates.map((c) => {
    const meta = metadata.get(c.workId);
    const quality = qualities.get(c.workId);
    const graph = graphFeatures.get(c.workId);
    const engagement = engagements.get(c.workId);

    const relevanceScore = c.score;
    const qualityScore = calculateQualityScore(
      quality?.blendedAvg,
      quality?.blendedWilson,
      quality?.totalRatings
    );
    const graphScore = graph?.proxScore ?? 0;
    const engagementScore = calculateEngagementScore(engagement);

    // Initial score (without diversity)
    const baseScore =
      weights.relevance * relevanceScore +
      weights.quality * qualityScore +
      weights.graph * graphScore +
      weights.engagement * engagementScore;

    return {
      workId: c.workId,
      meta,
      quality,
      relevanceScore,
      qualityScore,
      graphScore,
      engagementScore,
      engagement,
      baseScore,
      embedding: meta?.embedding ?? null,
    };
  });

  // Sort by base score initially
  scoredCandidates.sort((a, b) => b.baseScore - a.baseScore);

  // MMR selection for diversity
  const selected: RankedRecommendation[] = [];
  const selectedEmbeddings: number[][] = [];
  const selectedAuthors = new Set<string>();
  const remaining = new Set(scoredCandidates.map((c) => c.workId));

  while (selected.length < limit && remaining.size > 0) {
    let bestCandidate: (typeof scoredCandidates)[0] | null = null;
    let bestMmrScore = -Infinity;

    for (const candidate of scoredCandidates) {
      if (!remaining.has(candidate.workId)) continue;

      // Calculate novelty/diversity component
      const noveltyScore = calculateNoveltyScore(
        candidate.embedding,
        selectedEmbeddings
      );

      // Author diversity penalty
      let authorPenalty = 0;
      if (candidate.meta) {
        for (const author of candidate.meta.authors) {
          if (selectedAuthors.has(author)) {
            authorPenalty += 0.1;
          }
        }
      }

      // MMR score
      const mmrScore =
        (1 - diversityLambda) * candidate.baseScore +
        diversityLambda * noveltyScore * weights.novelty -
        authorPenalty;

      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestCandidate = candidate;
      }
    }

    if (!bestCandidate) break;

    remaining.delete(bestCandidate.workId);

    // Add to selected
    if (bestCandidate.embedding) {
      selectedEmbeddings.push(bestCandidate.embedding);
    }
    if (bestCandidate.meta) {
      for (const author of bestCandidate.meta.authors) {
        selectedAuthors.add(author);
      }
    }

    const noveltyScore = calculateNoveltyScore(
      bestCandidate.embedding,
      selectedEmbeddings.slice(0, -1)
    );

    const finalScore =
      bestCandidate.baseScore * 0.7 + noveltyScore * weights.novelty;

    selected.push({
      workId: bestCandidate.workId,
      title: bestCandidate.meta?.title ?? "Unknown",
      authors: bestCandidate.meta?.authors ?? [],
      year: bestCandidate.meta?.year ?? null,
      avgRating: bestCandidate.quality?.blendedAvg ?? null,
      ratingCount: bestCandidate.quality?.totalRatings ?? null,
      relevanceScore: bestCandidate.relevanceScore,
      qualityScore: bestCandidate.qualityScore,
      diversityScore: noveltyScore,
      engagementScore: bestCandidate.engagementScore,
      lastReadAt: bestCandidate.engagement?.lastReadAt ?? null,
      totalMs: bestCandidate.engagement?.totalMs ?? null,
      last30dMs: bestCandidate.engagement?.last30dMs ?? null,
      finalScore,
      suggestionQuality: scoreToGrade(finalScore),
      confidence: finalScore,
    });
  }

  timer.end({ selectedCount: selected.length });
  return selected;
}

/**
 * Calculate ILD (Intra-List Diversity) metric
 */
export function calculateILD(recommendations: RankedRecommendation[]): number {
  // This would require embeddings; simplified version uses diversity scores
  if (recommendations.length <= 1) return 1;

  let totalDiversity = 0;
  let pairs = 0;

  for (let i = 0; i < recommendations.length; i++) {
    for (let j = i + 1; j < recommendations.length; j++) {
      // Use diversity scores as proxy
      totalDiversity +=
        (recommendations[i].diversityScore + recommendations[j].diversityScore) / 2;
      pairs++;
    }
  }

  return pairs > 0 ? totalDiversity / pairs : 0;
}

/**
 * Get diversity metrics for a recommendation list
 */
export function getDiversityMetrics(
  recommendations: RankedRecommendation[]
): {
  ild: number;
  uniqueAuthors: number;
  authorRepeatRate: number;
} {
  const ild = calculateILD(recommendations);

  const allAuthors = recommendations.flatMap((r) => r.authors);
  const uniqueAuthors = new Set(allAuthors).size;
  const authorRepeatRate =
    allAuthors.length > 0
      ? 1 - uniqueAuthors / allAuthors.length
      : 0;

  return { ild, uniqueAuthors, authorRepeatRate };
}
