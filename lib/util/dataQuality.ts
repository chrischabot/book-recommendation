/**
 * Data quality metrics and logging
 * Provides visibility into data health after pipeline runs
 */

import { query } from "@/lib/db/pool";
import { logger } from "./logger";

export interface DataQualityMetrics {
  // Work statistics
  totalWorks: number;
  worksWithEmbedding: number;
  worksWithDescription: number;
  worksWithAuthors: number;
  worksWithSubjects: number;
  stubWorks: number;
  unknownTitleWorks: number;

  // User event statistics
  totalUserEvents: number;
  userEventsWithRating: number;
  userEventsRead: number;
  userEventsDnf: number;

  // Metadata coverage for user's library
  userWorksTotal: number;
  userWorksWithAuthors: number;
  userWorksWithSubjects: number;
  userWorksWithDescription: number;
  userWorksStubs: number;

  // Source distribution
  sourceDistribution: Record<string, number>;
}

/**
 * Compute data quality metrics for the database
 */
export async function computeDataQualityMetrics(
  userId: string
): Promise<DataQualityMetrics> {
  // Global work stats
  const { rows: workStats } = await query<{
    total: string;
    with_embedding: string;
    with_description: string;
    with_authors: string;
    with_subjects: string;
    stubs: string;
    unknown: string;
  }>(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
      COUNT(*) FILTER (WHERE description IS NOT NULL AND description != '') AS with_description,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "WorkAuthor" WHERE work_id = w.id)) AS with_authors,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "WorkSubject" WHERE work_id = w.id)) AS with_subjects,
      COUNT(*) FILTER (WHERE is_stub = true) AS stubs,
      COUNT(*) FILTER (WHERE title ILIKE 'unknown%') AS unknown
    FROM "Work" w
  `);

  // User event stats
  const { rows: eventStats } = await query<{
    total: string;
    with_rating: string;
    read: string;
    dnf: string;
  }>(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE rating IS NOT NULL) AS with_rating,
      COUNT(*) FILTER (WHERE shelf = 'read') AS read,
      COUNT(*) FILTER (WHERE shelf = 'dnf') AS dnf
    FROM "UserEvent"
    WHERE user_id = $1
  `, [userId]);

  // User's works metadata coverage
  const { rows: userWorkStats } = await query<{
    total: string;
    with_authors: string;
    with_subjects: string;
    with_description: string;
    stubs: string;
  }>(`
    SELECT
      COUNT(DISTINCT w.id) AS total,
      COUNT(DISTINCT w.id) FILTER (WHERE EXISTS (SELECT 1 FROM "WorkAuthor" WHERE work_id = w.id)) AS with_authors,
      COUNT(DISTINCT w.id) FILTER (WHERE EXISTS (SELECT 1 FROM "WorkSubject" WHERE work_id = w.id)) AS with_subjects,
      COUNT(DISTINCT w.id) FILTER (WHERE w.description IS NOT NULL AND w.description != '') AS with_description,
      COUNT(DISTINCT w.id) FILTER (WHERE w.is_stub = true) AS stubs
    FROM "UserEvent" ue
    JOIN "Work" w ON w.id = ue.work_id
    WHERE ue.user_id = $1
  `, [userId]);

  // Source distribution for user's works
  const { rows: sourceRows } = await query<{ source: string; count: string }>(`
    SELECT COALESCE(w.source, 'openlibrary') AS source, COUNT(DISTINCT w.id) AS count
    FROM "UserEvent" ue
    JOIN "Work" w ON w.id = ue.work_id
    WHERE ue.user_id = $1
    GROUP BY COALESCE(w.source, 'openlibrary')
    ORDER BY count DESC
  `, [userId]);

  const sourceDistribution: Record<string, number> = {};
  for (const row of sourceRows) {
    sourceDistribution[row.source] = parseInt(row.count, 10);
  }

  const ws = workStats[0];
  const es = eventStats[0];
  const uws = userWorkStats[0];

  return {
    totalWorks: parseInt(ws.total, 10),
    worksWithEmbedding: parseInt(ws.with_embedding, 10),
    worksWithDescription: parseInt(ws.with_description, 10),
    worksWithAuthors: parseInt(ws.with_authors, 10),
    worksWithSubjects: parseInt(ws.with_subjects, 10),
    stubWorks: parseInt(ws.stubs, 10),
    unknownTitleWorks: parseInt(ws.unknown, 10),

    totalUserEvents: parseInt(es.total, 10),
    userEventsWithRating: parseInt(es.with_rating, 10),
    userEventsRead: parseInt(es.read, 10),
    userEventsDnf: parseInt(es.dnf, 10),

    userWorksTotal: parseInt(uws.total, 10),
    userWorksWithAuthors: parseInt(uws.with_authors, 10),
    userWorksWithSubjects: parseInt(uws.with_subjects, 10),
    userWorksWithDescription: parseInt(uws.with_description, 10),
    userWorksStubs: parseInt(uws.stubs, 10),

    sourceDistribution,
  };
}

/**
 * Log data quality metrics in a readable format
 */
export function logDataQualityMetrics(metrics: DataQualityMetrics): void {
  const pct = (n: number, total: number) =>
    total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "N/A";

  console.log("\n========================================");
  console.log("  Data Quality Report");
  console.log("========================================\n");

  console.log("Global Work Statistics:");
  console.log(`  Total works:        ${metrics.totalWorks.toLocaleString()}`);
  console.log(`  With embeddings:    ${metrics.worksWithEmbedding.toLocaleString()} (${pct(metrics.worksWithEmbedding, metrics.totalWorks)})`);
  console.log(`  With description:   ${metrics.worksWithDescription.toLocaleString()} (${pct(metrics.worksWithDescription, metrics.totalWorks)})`);
  console.log(`  With authors:       ${metrics.worksWithAuthors.toLocaleString()} (${pct(metrics.worksWithAuthors, metrics.totalWorks)})`);
  console.log(`  With subjects:      ${metrics.worksWithSubjects.toLocaleString()} (${pct(metrics.worksWithSubjects, metrics.totalWorks)})`);
  console.log(`  Stub works:         ${metrics.stubWorks.toLocaleString()} (${pct(metrics.stubWorks, metrics.totalWorks)})`);
  console.log(`  Unknown titles:     ${metrics.unknownTitleWorks.toLocaleString()}`);

  console.log("\nUser Library Statistics:");
  console.log(`  Total events:       ${metrics.totalUserEvents.toLocaleString()}`);
  console.log(`  With ratings:       ${metrics.userEventsWithRating.toLocaleString()} (${pct(metrics.userEventsWithRating, metrics.totalUserEvents)})`);
  console.log(`  Read:               ${metrics.userEventsRead.toLocaleString()}`);
  console.log(`  DNF:                ${metrics.userEventsDnf.toLocaleString()}`);

  console.log("\nUser Works Metadata Coverage:");
  console.log(`  Total unique works: ${metrics.userWorksTotal.toLocaleString()}`);
  console.log(`  With authors:       ${metrics.userWorksWithAuthors.toLocaleString()} (${pct(metrics.userWorksWithAuthors, metrics.userWorksTotal)})`);
  console.log(`  With subjects:      ${metrics.userWorksWithSubjects.toLocaleString()} (${pct(metrics.userWorksWithSubjects, metrics.userWorksTotal)})`);
  console.log(`  With description:   ${metrics.userWorksWithDescription.toLocaleString()} (${pct(metrics.userWorksWithDescription, metrics.userWorksTotal)})`);
  console.log(`  Stubs:              ${metrics.userWorksStubs.toLocaleString()} (${pct(metrics.userWorksStubs, metrics.userWorksTotal)})`);

  console.log("\nSource Distribution:");
  for (const [source, count] of Object.entries(metrics.sourceDistribution)) {
    console.log(`  ${source}: ${count.toLocaleString()} (${pct(count, metrics.userWorksTotal)})`);
  }

  // Warnings
  const warnings: string[] = [];

  if (metrics.userWorksWithAuthors / metrics.userWorksTotal < 0.5) {
    warnings.push("Less than 50% of user works have author metadata");
  }
  if (metrics.userWorksWithSubjects / metrics.userWorksTotal < 0.3) {
    warnings.push("Less than 30% of user works have subject metadata");
  }
  if (metrics.userWorksStubs / metrics.userWorksTotal > 0.5) {
    warnings.push("More than 50% of user works are stubs - consider running cross-source deduplication");
  }
  if (metrics.unknownTitleWorks > 100) {
    warnings.push(`${metrics.unknownTitleWorks} works have 'Unknown' titles - consider running kindle:fix-unknowns`);
  }

  if (warnings.length > 0) {
    console.log("\n⚠️  Warnings:");
    for (const warning of warnings) {
      console.log(`  - ${warning}`);
    }
  }

  console.log("");

  // Log structured for machine parsing
  logger.info("Data quality metrics", { ...metrics });
}

/**
 * Run data quality check and log results
 */
export async function runDataQualityCheck(userId: string): Promise<DataQualityMetrics> {
  const metrics = await computeDataQualityMetrics(userId);
  logDataQualityMetrics(metrics);
  return metrics;
}
