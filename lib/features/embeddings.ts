/**
 * Embedding generation using OpenAI
 */

import OpenAI from "openai";
import Bottleneck from "bottleneck";
import { query, transaction } from "@/lib/db/pool";
import { normalizeVector, toVectorLiteral } from "@/lib/db/vector";
import { buildEmbeddingText } from "@/lib/util/text";
import { logger, createTimer } from "@/lib/util/logger";
import { getEnv } from "@/lib/config/env";

// Rate limiter for OpenAI API
const limiter = new Bottleneck({
  minTime: 100, // 10 requests per second
  maxConcurrent: 5,
});

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    const env = getEnv();
    openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return openai;
}

interface WorkForEmbedding {
  id: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  authors: string[];
  subjects: string[];
}

/**
 * Get works that need embeddings, prioritized by quality signals.
 *
 * Quality filtering strategy:
 * - Only process works with community engagement (2+ users in reading logs OR 1+ ratings)
 * - This naturally favors English content (Open Library is English-focused)
 * - Orders by popularity to process most valuable works first
 * - Works with descriptions are prioritized for better embeddings
 *
 * Uses a CTE to first identify qualifying work_keys from the smaller
 * popularity/rating tables, then joins to Work. This avoids scanning
 * the full 18M row Work table.
 */
async function getWorksNeedingEmbeddings(
  limit: number
): Promise<WorkForEmbedding[]> {
  const { rows } = await query<{
    id: number;
    title: string;
    subtitle: string | null;
    description: string | null;
    authors: string;
    subjects: string;
  }>(
    `
    WITH quality_works AS (
      -- Find work_keys that meet quality threshold, ranked by popularity
      SELECT
        COALESCE(wp.work_key, wr.work_key) AS work_key,
        COALESCE(wp.unique_users, 0) AS popularity,
        COALESCE(wr.rating_count, 0) AS ratings
      FROM "WorkPopularity" wp
      FULL OUTER JOIN "WorkOLRating" wr ON wp.work_key = wr.work_key
      WHERE COALESCE(wp.unique_users, 0) >= 2 OR COALESCE(wr.rating_count, 0) >= 1
    )
    SELECT
      w.id,
      w.title,
      w.subtitle,
      w.description,
      COALESCE(
        array_to_string(array_agg(DISTINCT a.name), ', '),
        ''
      ) AS authors,
      COALESCE(
        array_to_string(array_agg(DISTINCT ws.subject), ', '),
        ''
      ) AS subjects
    FROM quality_works qw
    JOIN "Work" w ON w.ol_work_key = qw.work_key
    LEFT JOIN "WorkAuthor" wa ON w.id = wa.work_id
    LEFT JOIN "Author" a ON wa.author_id = a.id
    LEFT JOIN "WorkSubject" ws ON w.id = ws.work_id
    WHERE w.embedding IS NULL
    GROUP BY w.id, qw.popularity, qw.ratings
    ORDER BY
      qw.popularity DESC,
      (w.description IS NOT NULL) DESC,
      qw.ratings DESC
    LIMIT $1
    `,
    [limit]
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    description: r.description,
    authors: r.authors ? r.authors.split(", ").filter(Boolean) : [],
    subjects: r.subjects ? r.subjects.split(", ").filter(Boolean) : [],
  }));
}

/**
 * Generate embedding for a single text
 * Uses dimension reduction to enable vector indexing (pgvector max 2000 dims)
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const env = getEnv();
  const client = getOpenAI();

  const response = await limiter.schedule(() =>
    client.embeddings.create({
      model: env.OPENAI_EMBED_MODEL,
      input: text,
      dimensions: env.OPENAI_EMBED_DIMENSIONS,
    })
  );

  const embedding = response.data[0].embedding;
  return normalizeVector(embedding);
}

/**
 * Generate embeddings for a batch of texts
 * Uses dimension reduction to enable vector indexing (pgvector max 2000 dims)
 */
async function generateEmbeddingsBatch(
  texts: string[]
): Promise<number[][]> {
  const env = getEnv();
  const client = getOpenAI();

  // OpenAI supports batching up to 2048 inputs
  const batchSize = 100;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const response = await limiter.schedule(() =>
      client.embeddings.create({
        model: env.OPENAI_EMBED_MODEL,
        input: batch,
        dimensions: env.OPENAI_EMBED_DIMENSIONS,
      })
    );

    for (const item of response.data) {
      results.push(normalizeVector(item.embedding));
    }
  }

  return results;
}

/**
 * Build embeddings for all quality works without them.
 *
 * Processes works with community engagement (2+ users OR 1+ ratings),
 * ordered by popularity. Runs until all qualifying works have embeddings.
 */
export async function buildWorkEmbeddings(options: {
  batchSize?: number;
}): Promise<{ processed: number; failed: number }> {
  const { batchSize = 50 } = options;

  logger.info("Starting embedding generation for quality works", { batchSize });
  const timer = createTimer("Embedding generation");

  let processed = 0;
  let failed = 0;

  while (true) {
    const works = await getWorksNeedingEmbeddings(batchSize);

    if (works.length === 0) {
      logger.info("No more works need embeddings");
      break;
    }

    // Build texts for batch
    const texts = works.map((work) =>
      buildEmbeddingText({
        title: work.title,
        subtitle: work.subtitle,
        description: work.description,
        authors: work.authors,
        subjects: work.subjects,
      })
    );

    try {
      const embeddings = await generateEmbeddingsBatch(texts);

      // Store embeddings in database
      await transaction(async (client) => {
        for (let i = 0; i < works.length; i++) {
          const work = works[i];
          const embedding = embeddings[i];
          const vectorLit = toVectorLiteral(embedding);

          await client.query(
            `UPDATE "Work" SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
            [vectorLit, work.id]
          );
        }
      });

      processed += works.length;
      logger.info(`Processed ${processed} works`);
    } catch (error) {
      logger.error("Batch embedding failed", { error: String(error) });
      failed += works.length;

      // Try one by one on failure
      for (const work of works) {
        try {
          const text = buildEmbeddingText({
            title: work.title,
            subtitle: work.subtitle,
            description: work.description,
            authors: work.authors,
            subjects: work.subjects,
          });

          const embedding = await generateEmbedding(text);
          const vectorLit = toVectorLiteral(embedding);

          await query(
            `UPDATE "Work" SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
            [vectorLit, work.id]
          );

          processed++;
          failed--; // Undo the batch failure count
        } catch (err) {
          logger.warn(`Failed to embed work ${work.id}`, { error: String(err) });
        }
      }
    }
  }

  timer.end({ processed, failed });
  return { processed, failed };
}

/**
 * Build embeddings for works that appear in a user's history but lack embeddings.
 * This is purposely scoped to the user to avoid embedding the entire catalog.
 */
export async function buildUserEventEmbeddings(
  userId: string,
  options: { batchSize?: number } = {}
): Promise<{ processed: number; failed: number }> {
  const { batchSize = 50 } = options;
  logger.info("Starting embedding generation for user events", { userId, batchSize });
  const timer = createTimer("User event embeddings");

  let processed = 0;
  let failed = 0;

  while (true) {
    const { rows } = await query<{
      id: number;
      title: string;
      subtitle: string | null;
      description: string | null;
      authors: string;
      subjects: string;
    }>(
      `
      SELECT
        w.id,
        w.title,
        w.subtitle,
        w.description,
        COALESCE(array_to_string(array_agg(DISTINCT a.name), ', '), '') AS authors,
        COALESCE(array_to_string(array_agg(DISTINCT ws.subject), ', '), '') AS subjects
      FROM "UserEvent" ue
      JOIN "Work" w ON w.id = ue.work_id
      LEFT JOIN "WorkAuthor" wa ON w.id = wa.work_id
      LEFT JOIN "Author" a ON wa.author_id = a.id
      LEFT JOIN "WorkSubject" ws ON w.id = ws.work_id
      WHERE ue.user_id = $1
        AND w.embedding IS NULL
      GROUP BY w.id
      ORDER BY COALESCE(MAX(ue.finished_at), NOW()) DESC, w.id
      LIMIT $2
      `,
      [userId, batchSize]
    );

    if (rows.length === 0) {
      logger.info("No more user-event works need embeddings", { userId });
      break;
    }

    const works = rows.map((r) => ({
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      description: r.description,
      authors: r.authors ? r.authors.split(", ").filter(Boolean) : [],
      subjects: r.subjects ? r.subjects.split(", ").filter(Boolean) : [],
    }));

    const texts = works.map((work) =>
      buildEmbeddingText({
        title: work.title,
        subtitle: work.subtitle,
        description: work.description,
        authors: work.authors,
        subjects: work.subjects,
      })
    );

    try {
      const embeddings = await generateEmbeddingsBatch(texts);

      await transaction(async (client) => {
        for (let i = 0; i < works.length; i++) {
          const vectorLit = toVectorLiteral(embeddings[i]);
          await client.query(
            `UPDATE "Work" SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
            [vectorLit, works[i]!.id]
          );
        }
      });

      processed += works.length;
      logger.info("Embedded user-event batch", { userId, processed });
    } catch (error) {
      logger.error("User-event batch embedding failed", { error: String(error) });
      failed += works.length;

      // Retry one-by-one for the batch
      for (const work of works) {
        try {
          const text = buildEmbeddingText({
            title: work.title,
            subtitle: work.subtitle,
            description: work.description,
            authors: work.authors,
            subjects: work.subjects,
          });

          const embedding = await generateEmbedding(text);
          const vectorLit = toVectorLiteral(embedding);

          await query(
            `UPDATE "Work" SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
            [vectorLit, work.id]
          );

          processed++;
          failed--; // Counter-correct for successful retry
        } catch (err) {
          logger.warn("Failed to embed individual work from user events", {
            workId: work.id,
            error: String(err),
          });
        }
      }
    }
  }

  timer.end({ processed, failed });
  return { processed, failed };
}

/**
 * Get embedding for a single work
 */
export async function getWorkEmbedding(workId: number): Promise<number[] | null> {
  const { rows } = await query<{ embedding: string }>(
    `SELECT embedding::text FROM "Work" WHERE id = $1`,
    [workId]
  );

  if (!rows[0]?.embedding) return null;

  const embStr = rows[0].embedding;
  const inner = embStr.replace(/^\[/, "").replace(/\]$/, "");
  return inner.split(",").map((s) => parseFloat(s));
}

/**
 * Generate embedding for arbitrary text (for queries)
 */
export async function embedText(text: string): Promise<number[]> {
  return generateEmbedding(text);
}
