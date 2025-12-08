/**
 * Candidate generation for recommendations
 * Generates initial candidate pools using vector similarity, graph expansion,
 * and collaborative filtering from Open Library reading logs and lists
 */

import { query } from "@/lib/db/pool";
import { knnFromVector, getUserReadWorkIds, getUserBlocks, getGraphNeighbors, getWorksBySubject } from "@/lib/db/sql";
import { parseVector } from "@/lib/db/vector";
import { getCategoryConstraints } from "@/lib/config/categories";
import { getOrBuildUserProfile } from "@/lib/features/userProfile";
import { getCachedCandidates, setCachedCandidates } from "@/lib/features/cache";
import {
  getAlsoReadWorks,
  getListMates,
  getTrendingWorks,
  getSimilarWorks,
  getSimilarWorksBatch,
  getCommunityCandidates,
} from "@/lib/features/ratings";
import { logger, createTimer } from "@/lib/util/logger";

export interface Candidate {
  workId: number;
  score: number;
  source: "vector" | "graph" | "category" | "collaborative" | "trending";
}

export interface CandidateOptions {
  userId: string;
  limit?: number;
  useCache?: boolean;
}

/**
 * Generate candidates for general recommendations
 */
export async function generateGeneralCandidates(
  options: CandidateOptions
): Promise<Candidate[]> {
  const { userId, limit = 2000, useCache = true } = options;

  logger.info("Generating general candidates", { userId, limit });
  const timer = createTimer("General candidate generation");

  // Check cache
  if (useCache) {
    const cached = await getCachedCandidates(userId, "general", "all");
    if (cached) {
      logger.debug("Using cached candidates");
      return cached.workIds.map((workId, i) => ({
        workId,
        score: cached.scores[i],
        source: "vector" as const,
      }));
    }
  }

  // Get user profile
  const profile = await getOrBuildUserProfile(userId);
  if (!profile || profile.profileVec.length === 0) {
    logger.warn("No user profile available", { userId });
    return [];
  }

  // Get exclusions (parallel)
  const [readWorkIds, blocks] = await Promise.all([
    getUserReadWorkIds(userId),
    getUserBlocks(userId),
  ]);
  const excludeWorkIds = [...readWorkIds, ...blocks.workIds];
  const excludeSet = new Set(excludeWorkIds);

  // Prepare anchor data for parallel fetches
  const anchorWorkIds = profile.anchors.slice(0, 10).map((a) => a.workId);
  const graphAnchors = profile.anchors.slice(0, 5);
  const communityAnchors = profile.anchors.slice(0, 3);

  // Run all candidate generation in parallel
  const [
    vectorCandidates,
    graphNeighborResults,
    communityResults,
    anchorOlRows,
  ] = await Promise.all([
    // Vector-based candidates from user profile
    knnFromVector(profile.profileVec, limit, excludeWorkIds),
    // Graph-based candidates (all anchors in parallel)
    Promise.all(graphAnchors.map((anchor) =>
      getGraphNeighbors(anchor.workId, 2).then((neighbors) => ({
        anchor,
        neighbors,
      }))
    )),
    // Community-based candidates (all anchors in parallel)
    Promise.all(communityAnchors.map((anchor) =>
      getCommunityCandidates(anchor.workId, 50).then((works) => ({
        anchor,
        works,
      }))
    )),
    // Look up OL work keys for collaborative filtering
    query<{ id: number; ol_work_key: string }>(
      `SELECT id, ol_work_key FROM "Work" WHERE id = ANY($1) AND ol_work_key IS NOT NULL`,
      [anchorWorkIds]
    ).then((r) => r.rows),
  ]);

  // Process graph neighbors
  const graphCandidates: { id: number; sim: number }[] = [];
  for (const { anchor, neighbors } of graphNeighborResults) {
    for (const neighborId of neighbors) {
      if (!excludeSet.has(neighborId)) {
        graphCandidates.push({
          id: neighborId,
          sim: 0.5 * anchor.weight,
        });
      }
    }
  }

  // Process community candidates
  const communityCandidates: { id: number; sim: number }[] = [];
  for (const { anchor, works } of communityResults) {
    for (const cw of works) {
      if (!excludeSet.has(cw.workId)) {
        communityCandidates.push({
          id: cw.workId,
          sim: 0.3 * anchor.weight,
        });
      }
    }
  }

  // Collaborative filtering from anchor books (Jaccard-based)
  const anchorOlKeys = anchorOlRows.map((r) => r.ol_work_key);
  const collaborativeCandidates: { id: number; sim: number }[] = [];

  if (anchorOlKeys.length > 0) {
    const similarWorksBatch = await getSimilarWorksBatch(anchorOlKeys, 30);

    // Resolve OL keys to work IDs
    const allOlKeys = new Set<string>();
    for (const [, results] of similarWorksBatch) {
      for (const r of results) {
        allOlKeys.add(r.olWorkKey);
      }
    }

    if (allOlKeys.size > 0) {
      const { rows: workRows } = await query<{ id: number; ol_work_key: string }>(
        `SELECT id, ol_work_key FROM "Work" WHERE ol_work_key = ANY($1)`,
        [Array.from(allOlKeys)]
      );
      const olKeyToId = new Map(workRows.map((r) => [r.ol_work_key, r.id]));

      for (const [anchorKey, results] of similarWorksBatch) {
        const anchorWorkId = anchorOlRows.find((r) => r.ol_work_key === anchorKey)?.id;
        const anchorWeight = profile.anchors.find((a) => a.workId === anchorWorkId)?.weight ?? 1;
        for (const r of results) {
          const workId = olKeyToId.get(r.olWorkKey);
          if (workId && !excludeSet.has(workId)) {
            collaborativeCandidates.push({
              id: workId,
              sim: r.jaccard * anchorWeight * 0.8,
            });
          }
        }
      }
    }
  }

  // Merge and deduplicate (all sources already filtered by excludeSet)
  const candidateMap = new Map<number, Candidate>();

  for (const vc of vectorCandidates) {
    candidateMap.set(vc.id, {
      workId: vc.id,
      score: vc.sim,
      source: "vector",
    });
  }

  for (const gc of graphCandidates) {
    const existing = candidateMap.get(gc.id);
    if (existing) {
      existing.score = Math.min(1.0, existing.score + gc.sim * 0.2);
    } else {
      candidateMap.set(gc.id, {
        workId: gc.id,
        score: gc.sim,
        source: "graph",
      });
    }
  }

  for (const cc of collaborativeCandidates) {
    const existing = candidateMap.get(cc.id);
    if (existing) {
      existing.score = Math.min(1.0, existing.score + cc.sim * 0.3);
    } else {
      candidateMap.set(cc.id, {
        workId: cc.id,
        score: cc.sim,
        source: "collaborative",
      });
    }
  }

  for (const cm of communityCandidates) {
    const existing = candidateMap.get(cm.id);
    if (existing) {
      existing.score = Math.min(1.0, existing.score + cm.sim * 0.15);
    } else {
      candidateMap.set(cm.id, {
        workId: cm.id,
        score: cm.sim,
        source: "graph",
      });
    }
  }

  // Apply author blocks (if any)
  if (blocks.authorIds.length > 0) {
    const { rows: blockedWorks } = await query<{ work_id: number }>(
      `SELECT DISTINCT work_id FROM "WorkAuthor" WHERE author_id = ANY($1)`,
      [blocks.authorIds]
    );
    for (const { work_id } of blockedWorks) {
      candidateMap.delete(work_id);
    }
  }

  // Sort by score and limit
  const candidates = Array.from(candidateMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Cache results
  if (useCache && candidates.length > 0) {
    await setCachedCandidates(
      userId,
      "general",
      "all",
      candidates.map((c) => c.workId),
      candidates.map((c) => c.score)
    );
  }

  timer.end({ candidateCount: candidates.length });
  return candidates;
}

/**
 * Generate candidates based on a seed book
 * Uses vector similarity, graph neighbors, and collaborative filtering
 */
export async function generateByBookCandidates(
  options: CandidateOptions & { seedWorkId: number }
): Promise<Candidate[]> {
  const { userId, seedWorkId, limit = 500, useCache = true } = options;

  logger.info("Generating by-book candidates", { userId, seedWorkId, limit });
  const timer = createTimer("By-book candidate generation");

  const cacheKey = String(seedWorkId);

  // Check cache
  if (useCache) {
    const cached = await getCachedCandidates(userId, "by-book", cacheKey);
    if (cached) {
      return cached.workIds.map((workId, i) => ({
        workId,
        score: cached.scores[i],
        source: "vector" as const,
      }));
    }
  }

  // Get seed book embedding and OL key
  const { rows } = await query<{ embedding: string; ol_work_key: string }>(
    `SELECT embedding::text, ol_work_key FROM "Work" WHERE id = $1`,
    [seedWorkId]
  );

  if (!rows[0]?.embedding) {
    logger.warn("Seed work has no embedding", { seedWorkId });
    return [];
  }

  const seedEmbedding = parseVector(rows[0].embedding);
  const seedOlKey = rows[0].ol_work_key;

  // Get exclusions
  const readWorkIds = await getUserReadWorkIds(userId);
  const blocks = await getUserBlocks(userId);
  const excludeWorkIds = [...readWorkIds, ...blocks.workIds, seedWorkId];
  const excludeSet = new Set(excludeWorkIds);

  // Run different candidate sources in parallel
  const [vectorCandidates, graphNeighbors, similarWorks, listMates] = await Promise.all([
    // Vector-based similar works
    knnFromVector(seedEmbedding, limit, excludeWorkIds),
    // Graph-based neighbors
    getGraphNeighbors(seedWorkId, 2),
    // Collaborative: similar works via Jaccard (precomputed or real-time)
    seedOlKey ? getSimilarWorks(seedOlKey, 100) : Promise.resolve([]),
    // Lists: books that appear in same lists
    seedOlKey ? getListMates(seedOlKey, 30) : Promise.resolve([]),
  ]);

  // Merge all candidates
  const candidateMap = new Map<number, Candidate>();

  // Vector candidates (primary)
  for (const vc of vectorCandidates) {
    candidateMap.set(vc.id, {
      workId: vc.id,
      score: vc.sim,
      source: "vector",
    });
  }

  // Graph neighbors
  const filteredNeighbors = graphNeighbors.filter((id) => !excludeSet.has(id));
  for (const neighborId of filteredNeighbors) {
    const existing = candidateMap.get(neighborId);
    if (existing) {
      existing.score = Math.min(1.0, existing.score + 0.15);
    } else {
      candidateMap.set(neighborId, {
        workId: neighborId,
        score: 0.5,
        source: "graph",
      });
    }
  }

  // Collaborative candidates: similar works via Jaccard similarity
  if (similarWorks.length > 0) {
    // Resolve OL keys to work IDs
    const olKeys = similarWorks.map((w) => w.olWorkKey);
    const { rows: workRows } = await query<{ id: number; ol_work_key: string }>(
      `SELECT id, ol_work_key FROM "Work" WHERE ol_work_key = ANY($1)`,
      [olKeys]
    );
    const olKeyToId = new Map(workRows.map((r) => [r.ol_work_key, r.id]));

    for (const similar of similarWorks) {
      const workId = olKeyToId.get(similar.olWorkKey);
      if (!workId || excludeSet.has(workId)) continue;

      // Score based on Jaccard similarity (already normalized 0-1)
      const collabScore = 0.3 + similar.jaccard * 0.5;
      const existing = candidateMap.get(workId);
      if (existing) {
        existing.score = Math.min(1.0, existing.score + collabScore * 0.4);
      } else {
        candidateMap.set(workId, {
          workId,
          score: collabScore,
          source: "collaborative",
        });
      }
    }
  }

  // List mates: books from shared lists
  if (listMates.length > 0) {
    const listWorkKeys = listMates.map((w) => w.olWorkKey.split("/").pop() ?? w.olWorkKey);
    const { rows: listWorkRows } = await query<{ id: number; ol_work_key: string }>(
      `SELECT id, ol_work_key FROM "Work" WHERE ol_work_key = ANY($1)`,
      [listWorkKeys]
    );
    const listOlKeyToId = new Map(listWorkRows.map((r) => [r.ol_work_key, r.id]));

    for (const mate of listMates) {
      const mateKey = mate.olWorkKey.split("/").pop() ?? mate.olWorkKey;
      const workId = listOlKeyToId.get(mateKey);
      if (!workId || excludeSet.has(workId)) continue;

      const listScore = Math.min(0.6, 0.2 + mate.sharedLists * 0.05);
      const existing = candidateMap.get(workId);
      if (existing) {
        existing.score = Math.min(1.0, existing.score + listScore * 0.2);
      } else {
        candidateMap.set(workId, {
          workId,
          score: listScore,
          source: "collaborative",
        });
      }
    }
  }

  const candidates = Array.from(candidateMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Cache
  if (useCache && candidates.length > 0) {
    await setCachedCandidates(
      userId,
      "by-book",
      cacheKey,
      candidates.map((c) => c.workId),
      candidates.map((c) => c.score)
    );
  }

  timer.end({ candidateCount: candidates.length });
  return candidates;
}

/**
 * Generate candidates for a category
 */
export async function generateByCategoryCandidates(
  options: CandidateOptions & { categorySlug: string }
): Promise<Candidate[]> {
  const { userId, categorySlug, limit = 1000, useCache = true } = options;

  logger.info("Generating by-category candidates", { userId, categorySlug, limit });
  const timer = createTimer("By-category candidate generation");

  // Check cache
  if (useCache) {
    const cached = await getCachedCandidates(userId, "by-category", categorySlug);
    if (cached) {
      return cached.workIds.map((workId, i) => ({
        workId,
        score: cached.scores[i],
        source: "category" as const,
      }));
    }
  }

  // Get category constraints
  const constraints = getCategoryConstraints(categorySlug);
  if (!constraints) {
    logger.warn("Unknown category", { categorySlug });
    return [];
  }

  // Get exclusions
  const readWorkIds = await getUserReadWorkIds(userId);
  const blocks = await getUserBlocks(userId);
  const excludeWorkIds = [...readWorkIds, ...blocks.workIds];

  // Get works by subject
  const subjectWorks = await getWorksBySubject(constraints.subjects, {
    yearMin: constraints.yearMin,
    yearMax: constraints.yearMax,
    excludeWorkIds,
    limit: limit * 2, // Get more for filtering
  });

  // Filter out excluded subjects
  let filteredWorks = subjectWorks;
  if (constraints.excludeSubjects.length > 0) {
    const { rows: excludeRows } = await query<{ work_id: number }>(
      `
      SELECT DISTINCT work_id FROM "WorkSubject"
      WHERE subject = ANY($1)
      `,
      [constraints.excludeSubjects]
    );
    const excludeSet = new Set(excludeRows.map((r) => r.work_id));
    filteredWorks = subjectWorks.filter((w) => !excludeSet.has(w.id));
  }

  // Get user profile for scoring
  const profile = await getOrBuildUserProfile(userId);

  // Score candidates
  const candidates: Candidate[] = [];

  if (profile && profile.profileVec.length > 0) {
    // Batch get embeddings for scoring
    const workIds = filteredWorks.slice(0, limit).map((w) => w.id);
    const { rows: embeddings } = await query<{ id: number; embedding: string }>(
      `SELECT id, embedding::text FROM "Work" WHERE id = ANY($1) AND embedding IS NOT NULL`,
      [workIds]
    );

    for (const emb of embeddings) {
      const workVec = parseVector(emb.embedding);
      // Compute cosine similarity
      let dotProduct = 0;
      for (let i = 0; i < profile.profileVec.length; i++) {
        dotProduct += profile.profileVec[i] * workVec[i];
      }
      candidates.push({
        workId: emb.id,
        score: dotProduct,
        source: "category",
      });
    }
  } else {
    // No profile - use base score
    for (const work of filteredWorks.slice(0, limit)) {
      candidates.push({
        workId: work.id,
        score: 0.5,
        source: "category",
      });
    }
  }

  // Sort and limit
  const sortedCandidates = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Cache
  if (useCache && sortedCandidates.length > 0) {
    await setCachedCandidates(
      userId,
      "by-category",
      categorySlug,
      sortedCandidates.map((c) => c.workId),
      sortedCandidates.map((c) => c.score)
    );
  }

  timer.end({ candidateCount: sortedCandidates.length });
  return sortedCandidates;
}
