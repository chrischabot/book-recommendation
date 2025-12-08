#!/usr/bin/env tsx
/**
 * Build book communities using Label Propagation algorithm
 *
 * Groups books into communities based on co-occurrence patterns.
 * Books in the same community share many common readers.
 *
 * Usage:
 *   pnpm community:build
 *   pnpm community:build -- --iterations 15 --min-community 10
 */

import "dotenv/config";

import { parseArgs } from "util";
import { query, withClient } from "@/lib/db/pool";
import { closePool } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

const args = process.argv.slice(2).filter((arg) => arg !== "--");

const { values } = parseArgs({
  args,
  options: {
    iterations: { type: "string", default: "15" },
    "min-community": { type: "string", default: "5" },
    "min-jaccard": { type: "string", default: "0.05" },
  },
  allowPositionals: true,
});

const ITERATIONS = parseInt(values.iterations!, 10);
const MIN_COMMUNITY_SIZE = parseInt(values["min-community"]!, 10);
const MIN_JACCARD = parseFloat(values["min-jaccard"]!);

async function main() {
  logger.info("Building book communities via Label Propagation", {
    iterations: ITERATIONS,
    minCommunitySize: MIN_COMMUNITY_SIZE,
    minJaccard: MIN_JACCARD,
  });

  const timer = createTimer("Community detection");

  // Step 1: Get all works with co-occurrence data
  logger.info("Phase 1: Loading co-occurrence graph...");
  const { rows: edges } = await query<{
    work_key_a: string;
    work_key_b: string;
    jaccard: string;
  }>(`
    SELECT work_key_a, work_key_b, jaccard
    FROM "WorkCooccurrence"
    WHERE jaccard >= $1
  `, [MIN_JACCARD]);

  logger.info(`Loaded ${edges.length} edges above jaccard threshold`);

  // Build adjacency list
  const neighbors = new Map<string, Array<{ key: string; weight: number }>>();
  const allNodes = new Set<string>();

  for (const edge of edges) {
    allNodes.add(edge.work_key_a);
    allNodes.add(edge.work_key_b);

    if (!neighbors.has(edge.work_key_a)) {
      neighbors.set(edge.work_key_a, []);
    }
    if (!neighbors.has(edge.work_key_b)) {
      neighbors.set(edge.work_key_b, []);
    }

    const weight = parseFloat(edge.jaccard);
    neighbors.get(edge.work_key_a)!.push({ key: edge.work_key_b, weight });
    neighbors.get(edge.work_key_b)!.push({ key: edge.work_key_a, weight });
  }

  logger.info(`Graph has ${allNodes.size} nodes`);

  // Step 2: Initialize labels (each node gets its own label)
  logger.info("Phase 2: Running Label Propagation...");
  const labels = new Map<string, number>();
  const nodeList = Array.from(allNodes);
  let labelId = 0;

  for (const node of nodeList) {
    labels.set(node, labelId++);
  }

  // Step 3: Iterate label propagation
  for (let iter = 0; iter < ITERATIONS; iter++) {
    let changes = 0;

    // Shuffle nodes for randomness
    const shuffled = [...nodeList].sort(() => Math.random() - 0.5);

    for (const node of shuffled) {
      const nodeNeighbors = neighbors.get(node) ?? [];
      if (nodeNeighbors.length === 0) continue;

      // Count weighted votes for each label
      const labelVotes = new Map<number, number>();
      for (const { key, weight } of nodeNeighbors) {
        const neighborLabel = labels.get(key)!;
        labelVotes.set(
          neighborLabel,
          (labelVotes.get(neighborLabel) ?? 0) + weight
        );
      }

      // Find label with max votes
      let maxLabel = labels.get(node)!;
      let maxVotes = 0;
      for (const [label, votes] of labelVotes) {
        if (votes > maxVotes) {
          maxVotes = votes;
          maxLabel = label;
        }
      }

      // Update if different
      if (maxLabel !== labels.get(node)) {
        labels.set(node, maxLabel);
        changes++;
      }
    }

    logger.debug(`Iteration ${iter + 1}/${ITERATIONS}: ${changes} label changes`);

    // Early stop if converged
    if (changes === 0) {
      logger.info(`Converged after ${iter + 1} iterations`);
      break;
    }
  }

  // Step 4: Consolidate community IDs (renumber from 0)
  logger.info("Phase 3: Consolidating communities...");
  const uniqueLabels = new Set(labels.values());
  const labelRemap = new Map<number, number>();
  let newId = 0;
  for (const oldLabel of uniqueLabels) {
    labelRemap.set(oldLabel, newId++);
  }

  // Count community sizes
  const communitySizes = new Map<number, number>();
  for (const node of nodeList) {
    const oldLabel = labels.get(node)!;
    const newLabel = labelRemap.get(oldLabel)!;
    labels.set(node, newLabel);
    communitySizes.set(newLabel, (communitySizes.get(newLabel) ?? 0) + 1);
  }

  // Filter small communities (assign to -1)
  for (const node of nodeList) {
    const label = labels.get(node)!;
    if ((communitySizes.get(label) ?? 0) < MIN_COMMUNITY_SIZE) {
      labels.set(node, -1);
    }
  }

  // Recount valid communities
  const validCommunities = new Set<number>();
  for (const [, label] of labels) {
    if (label >= 0) validCommunities.add(label);
  }

  logger.info(`Found ${validCommunities.size} communities with >= ${MIN_COMMUNITY_SIZE} members`);

  // Step 5: Update database
  logger.info("Phase 4: Updating database...");
  const updateTimer = createTimer("Database update");

  // Clear existing communities
  await query(`UPDATE "Work" SET community_id = NULL WHERE community_id IS NOT NULL`);
  await query(`TRUNCATE "BookCommunity" RESTART IDENTITY`);

  // Update works with community IDs using temp table + JOIN (much faster than CASE batches)
  const entries = Array.from(labels.entries()).filter(([, label]) => label >= 0);

  // Create temp table
  await query(`
    CREATE TEMP TABLE IF NOT EXISTS temp_community_labels (
      work_key TEXT PRIMARY KEY,
      community_id INTEGER
    ) ON COMMIT DROP
  `);
  await query(`TRUNCATE temp_community_labels`);

  // Bulk insert into temp table in batches
  const batchSize = 5000;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const values = batch.map(([key, label]) => `('${key}', ${label})`).join(",");
    await query(`INSERT INTO temp_community_labels (work_key, community_id) VALUES ${values}`);

    if ((i + batchSize) % 10000 === 0) {
      logger.debug(`Inserted ${Math.min(i + batchSize, entries.length)}/${entries.length} labels into temp table`);
    }
  }

  // Single efficient JOIN-based update
  logger.debug("Running bulk UPDATE via JOIN...");
  const updateResult = await query(`
    UPDATE "Work" w
    SET community_id = t.community_id
    FROM temp_community_labels t
    WHERE w.ol_work_key = t.work_key
  `);
  logger.debug(`Updated ${updateResult.rowCount} works with community IDs`);

  // Create community metadata using efficient CTEs instead of correlated subqueries
  logger.info("Phase 5: Building community metadata...");
  await query(`
    WITH community_counts AS (
      SELECT community_id, COUNT(*) as member_count
      FROM "Work"
      WHERE community_id IS NOT NULL AND community_id >= 0
      GROUP BY community_id
      HAVING COUNT(*) >= $1
    ),
    subject_ranked AS (
      SELECT
        w.community_id,
        ws.subject,
        COUNT(*) as cnt,
        ROW_NUMBER() OVER (PARTITION BY w.community_id ORDER BY COUNT(*) DESC) as rn
      FROM "Work" w
      JOIN "WorkSubject" ws ON ws.work_id = w.id
      WHERE w.community_id IS NOT NULL AND w.community_id >= 0
      GROUP BY w.community_id, ws.subject
    ),
    top_subjects AS (
      SELECT community_id, ARRAY_AGG(subject ORDER BY cnt DESC) as subjects
      FROM subject_ranked
      WHERE rn <= 5
      GROUP BY community_id
    ),
    author_ranked AS (
      SELECT
        w.community_id,
        a.name,
        COUNT(*) as cnt,
        ROW_NUMBER() OVER (PARTITION BY w.community_id ORDER BY COUNT(*) DESC) as rn
      FROM "Work" w
      JOIN "WorkAuthor" wa ON wa.work_id = w.id
      JOIN "Author" a ON a.id = wa.author_id
      WHERE w.community_id IS NOT NULL AND w.community_id >= 0
      GROUP BY w.community_id, a.name
    ),
    top_authors AS (
      SELECT community_id, ARRAY_AGG(name ORDER BY cnt DESC) as authors
      FROM author_ranked
      WHERE rn <= 5
      GROUP BY community_id
    )
    INSERT INTO "BookCommunity" (id, member_count, top_subjects, top_authors)
    SELECT
      cc.community_id,
      cc.member_count,
      ts.subjects,
      ta.authors
    FROM community_counts cc
    LEFT JOIN top_subjects ts ON ts.community_id = cc.community_id
    LEFT JOIN top_authors ta ON ta.community_id = cc.community_id
    ON CONFLICT (id) DO UPDATE SET
      member_count = EXCLUDED.member_count,
      top_subjects = EXCLUDED.top_subjects,
      top_authors = EXCLUDED.top_authors
  `, [MIN_COMMUNITY_SIZE]);

  updateTimer.end();

  // Final stats
  const { rows: stats } = await query<{ count: string; communities: string }>(`
    SELECT
      COUNT(*) as count,
      COUNT(DISTINCT community_id) as communities
    FROM "Work"
    WHERE community_id IS NOT NULL AND community_id >= 0
  `);

  timer.end({
    totalNodes: allNodes.size,
    totalEdges: edges.length,
    communities: parseInt(stats[0]?.communities ?? "0", 10),
    assignedWorks: parseInt(stats[0]?.count ?? "0", 10),
  });

  logger.info(`Community detection complete: ${stats[0]?.communities} communities, ${stats[0]?.count} works assigned`);

  await closePool();
}

main().catch((error) => {
  logger.error("Community detection failed", { error: String(error) });
  process.exit(1);
});
