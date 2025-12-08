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
 * Get work metadata for candidates (without embeddings for speed)
 */
async function getWorkMetadata(
  workIds: number[]
): Promise<Map<number, WorkMetadata>> {
  if (workIds.length === 0) return new Map();

  // Use pre-aggregated view if available, otherwise fall back to join
  // Note: NOT fetching embeddings here - they're huge and only needed for MMR
  const { rows } = await query<{
    id: number;
    title: string;
    first_publish_year: number | null;
    author_names: string | null;
  }>(
    `
    SELECT w.id, w.title, w.first_publish_year, waa.author_names
    FROM "Work" w
    LEFT JOIN work_authors_agg waa ON w.id = waa.work_id
    WHERE w.id = ANY($1)
    `,
    [workIds]
  );

  const result = new Map<number, WorkMetadata>();
  for (const row of rows) {
    result.set(row.id, {
      id: row.id,
      title: row.title,
      authors: row.author_names ? row.author_names.split(", ").filter(Boolean) : [],
      year: row.first_publish_year,
      embedding: null, // Fetched on-demand during MMR
    });
  }

  return result;
}

/**
 * Fetch embeddings for a batch of work IDs (only when needed for MMR)
 */
async function getEmbeddingsBatch(
  workIds: number[]
): Promise<Map<number, number[]>> {
  if (workIds.length === 0) return new Map();

  const { rows } = await query<{ id: number; embedding: string }>(
    `SELECT id, embedding::text FROM "Work" WHERE id = ANY($1) AND embedding IS NOT NULL`,
    [workIds]
  );

  const result = new Map<number, number[]>();
  for (const row of rows) {
    result.set(row.id, parseVector(row.embedding));
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

  // Fetch metadata without embeddings (fast)
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
      embedding: null as number[] | null, // Loaded lazily for MMR subset
    };
  });

  // Sort by base score and take top candidates for MMR (limit expensive embedding fetches)
  scoredCandidates.sort((a, b) => b.baseScore - a.baseScore);
  const mmrCandidateCount = Math.min(scoredCandidates.length, limit * 2); // 2x limit for diversity selection
  const mmrCandidates = scoredCandidates.slice(0, mmrCandidateCount);

  // Fetch embeddings only for MMR candidates (much smaller set)
  const mmrWorkIds = mmrCandidates.map((c) => c.workId);
  const embeddings = await getEmbeddingsBatch(mmrWorkIds);
  for (const c of mmrCandidates) {
    c.embedding = embeddings.get(c.workId) ?? null;
  }

  // MMR selection for diversity (using reduced candidate set)
  const selected: RankedRecommendation[] = [];
  const selectedEmbeddings: number[][] = [];
  const selectedAuthors = new Set<string>();
  const remaining = new Set(mmrCandidates.map((c) => c.workId));

  while (selected.length < limit && remaining.size > 0) {
    let bestCandidate: (typeof mmrCandidates)[0] | null = null;
    let bestMmrScore = -Infinity;

    for (const candidate of mmrCandidates) {
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

    // Calculate novelty score BEFORE adding to selectedEmbeddings
    // This correctly measures diversity against already-selected items
    const noveltyScore = calculateNoveltyScore(
      bestCandidate.embedding,
      selectedEmbeddings
    );

    // Now add to selected collections for future iterations
    if (bestCandidate.embedding) {
      selectedEmbeddings.push(bestCandidate.embedding);
    }
    if (bestCandidate.meta) {
      for (const author of bestCandidate.meta.authors) {
        selectedAuthors.add(author);
      }
    }

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
 * Calculate ILD (Intra-List Diversity) metric.
 *
 * ILD is the average pairwise distance between all items in the list.
 * Higher values indicate more diverse recommendations.
 *
 * @param recommendations The list of recommendations
 * @param embeddings Optional map of workId -> embedding for accurate calculation
 * @returns ILD score between 0 and 1 (1 = maximally diverse)
 */
export function calculateILD(
  recommendations: RankedRecommendation[],
  embeddings?: Map<number, number[]>
): number {
  if (recommendations.length <= 1) return 1;

  let totalDistance = 0;
  let pairs = 0;

  // If embeddings provided, calculate true pairwise distances
  if (embeddings && embeddings.size > 0) {
    for (let i = 0; i < recommendations.length; i++) {
      const embI = embeddings.get(recommendations[i].workId);
      if (!embI) continue;

      for (let j = i + 1; j < recommendations.length; j++) {
        const embJ = embeddings.get(recommendations[j].workId);
        if (!embJ) continue;

        // Distance = 1 - similarity (cosine similarity is between -1 and 1, usually 0-1 for embeddings)
        const similarity = cosineSimilarity(embI, embJ);
        totalDistance += 1 - similarity;
        pairs++;
      }
    }
  } else {
    // Fallback: use author diversity as a proxy for diversity
    // This is less accurate but doesn't require embeddings
    const authorSets = recommendations.map((r) => new Set(r.authors));

    for (let i = 0; i < recommendations.length; i++) {
      for (let j = i + 1; j < recommendations.length; j++) {
        // Jaccard distance for authors
        const setI = authorSets[i];
        const setJ = authorSets[j];
        const intersection = [...setI].filter((a) => setJ.has(a)).length;
        const union = new Set([...setI, ...setJ]).size;

        // If no authors, assume maximum diversity
        const jaccardSim = union > 0 ? intersection / union : 0;
        totalDistance += 1 - jaccardSim;
        pairs++;
      }
    }
  }

  return pairs > 0 ? totalDistance / pairs : 1;
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
