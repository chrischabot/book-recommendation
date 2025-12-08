import type { PoolClient } from "pg";
import { query, withClient } from "./pool";
import { toVectorLiteral } from "./vector";
import { logger } from "@/lib/util/logger";

/**
 * Find K nearest neighbors by vector similarity (cosine distance)
 */
export async function knnFromVector(
  vec: number[],
  limit = 2000,
  excludeWorkIds: number[] = []
): Promise<{ id: number; sim: number }[]> {
  const vectorLit = toVectorLiteral(vec);

  let excludeClause = "";
  const params: unknown[] = [vectorLit, limit];

  if (excludeWorkIds.length > 0) {
    excludeClause = `AND id != ALL($3::bigint[])`;
    params.push(excludeWorkIds);
  }

  const { rows } = await query<{ id: number; sim: number }>(
    `
    SELECT id, 1 - (embedding <=> $1::vector) AS sim
    FROM "Work"
    WHERE embedding IS NOT NULL
    ${excludeClause}
    ORDER BY embedding <=> $1::vector
    LIMIT $2
    `,
    params
  );

  return rows;
}

/**
 * Find similar works to a given work ID
 */
export async function findSimilarWorks(
  workId: number,
  limit = 100,
  excludeWorkIds: number[] = []
): Promise<{ id: number; sim: number }[]> {
  const allExcluded = [workId, ...excludeWorkIds];

  const { rows } = await query<{ id: number; sim: number }>(
    `
    WITH seed AS (
      SELECT embedding FROM "Work" WHERE id = $1 AND embedding IS NOT NULL
    )
    SELECT w.id, 1 - (w.embedding <=> seed.embedding) AS sim
    FROM "Work" w, seed
    WHERE w.embedding IS NOT NULL
      AND w.id != ALL($3::bigint[])
    ORDER BY w.embedding <=> seed.embedding
    LIMIT $2
    `,
    [workId, limit, allExcluded]
  );

  return rows;
}

/**
 * Get works the user has already read/interacted with
 */
export async function getUserReadWorkIds(userId: string): Promise<number[]> {
  const { rows } = await query<{ work_id: number }>(
    `SELECT DISTINCT work_id FROM "UserEvent" WHERE user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.work_id);
}

/**
 * Get blocked work IDs and author IDs for a user
 */
export async function getUserBlocks(
  userId: string
): Promise<{ workIds: number[]; authorIds: number[] }> {
  const { rows } = await query<{ work_id: number | null; author_id: number | null }>(
    `SELECT work_id, author_id FROM "Block" WHERE user_id = $1`,
    [userId]
  );

  return {
    workIds: rows
      .map((r) => r.work_id)
      .filter((id): id is number => id !== null),
    authorIds: rows
      .map((r) => r.author_id)
      .filter((id): id is number => id !== null),
  };
}

/**
 * Safely escape a string for Cypher query inclusion
 * Handles single quotes, backslashes, and other special characters
 */
function escapeCypherString(value: string): string {
  // Escape backslashes first, then single quotes
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Validate parameter key to prevent regex injection
 * Only allows alphanumeric characters and underscores
 */
function isValidParamKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

/**
 * Execute an AGE Cypher query
 * Note: AGE doesn't support parameterized Cypher directly, so we use safe substitution
 */
export async function cypherQuery<T>(
  cypherStatement: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  return withClient(async (client) => {
    // Set up AGE
    await client.query(`LOAD 'age'`);
    await client.query(`SET search_path = ag_catalog, "$user", public`);

    // Build parameter substitution with proper validation and escaping
    const paramEntries = Object.entries(params);
    let processedCypher = cypherStatement;

    for (const [key, value] of paramEntries) {
      // Validate parameter key to prevent regex injection
      if (!isValidParamKey(key)) {
        throw new Error(`Invalid Cypher parameter key: ${key}. Only alphanumeric characters and underscores allowed.`);
      }

      let replacement: string;

      if (typeof value === "string") {
        // Properly escape string values for Cypher
        replacement = `'${escapeCypherString(value)}'`;
      } else if (typeof value === "number") {
        // Validate number to prevent NaN/Infinity injection
        if (!Number.isFinite(value)) {
          throw new Error(`Invalid number value for parameter ${key}: ${value}`);
        }
        replacement = String(value);
      } else if (typeof value === "boolean") {
        replacement = value ? "true" : "false";
      } else if (value === null || value === undefined) {
        replacement = "null";
      } else if (Array.isArray(value)) {
        // Handle arrays safely
        const escapedItems = value.map((item) => {
          if (typeof item === "string") {
            return `'${escapeCypherString(item)}'`;
          } else if (typeof item === "number" && Number.isFinite(item)) {
            return String(item);
          } else if (typeof item === "boolean") {
            return item ? "true" : "false";
          } else if (item === null) {
            return "null";
          }
          throw new Error(`Unsupported array item type for parameter ${key}`);
        });
        replacement = `[${escapedItems.join(", ")}]`;
      } else {
        throw new Error(`Unsupported parameter type for ${key}: ${typeof value}`);
      }

      // Use word boundary matching with validated key
      processedCypher = processedCypher.replace(
        new RegExp(`\\$${key}\\b`, "g"),
        replacement
      );
    }

    // Additional safety: check for unsubstituted parameters
    const unsubstituted = processedCypher.match(/\$[a-zA-Z_][a-zA-Z0-9_]*/g);
    if (unsubstituted && unsubstituted.length > 0) {
      console.warn(`Cypher query has unsubstituted parameters: ${unsubstituted.join(", ")}`);
    }

    const result = await client.query(
      `SELECT * FROM cypher('books', $$ ${processedCypher} $$) AS (result agtype)`
    );

    // Parse agtype results
    return result.rows.map((row) => {
      const val = row.result;
      if (typeof val === "string") {
        try {
          return JSON.parse(val.replace(/::[\w]+$/, ""));
        } catch {
          return val;
        }
      }
      return val;
    }) as T[];
  });
}

/**
 * Get 2-hop neighbors from a seed work via graph
 */
export async function getGraphNeighbors(
  workId: number,
  maxHops = 2
): Promise<number[]> {
  try {
    const results = await cypherQuery<number>(
      `
      MATCH (w:Work {id: ${workId}})-[:HAS_SUBJECT|:IN_SERIES|:WROTE*1..${maxHops}]-(n:Work)
      WHERE n.id <> ${workId}
      RETURN DISTINCT n.id AS id
      `
    );
    return results;
  } catch (error) {
    // AGE extension may not be installed - this is expected, just skip graph features
    const errMsg = String(error);
    if (!errMsg.includes("age") && !errMsg.includes("No such file")) {
      logger.error("Graph neighbor query failed", { error: errMsg, workId });
    }
    return [];
  }
}

/**
 * Get works by subject with optional year constraints
 */
export async function getWorksBySubject(
  subjects: string[],
  options: {
    yearMin?: number;
    yearMax?: number;
    language?: string;
    limit?: number;
    excludeWorkIds?: number[];
  } = {}
): Promise<{ id: number; title: string }[]> {
  const { yearMin, yearMax, language, limit = 1000, excludeWorkIds = [] } = options;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  // Subject filter
  conditions.push(`ws.subject = ANY($${paramIdx}::text[])`);
  params.push(subjects);
  paramIdx++;

  // Year constraints
  if (yearMin !== undefined) {
    conditions.push(`w.first_publish_year >= $${paramIdx}`);
    params.push(yearMin);
    paramIdx++;
  }
  if (yearMax !== undefined) {
    conditions.push(`w.first_publish_year <= $${paramIdx}`);
    params.push(yearMax);
    paramIdx++;
  }

  // Language
  if (language) {
    conditions.push(`w.language = $${paramIdx}`);
    params.push(language);
    paramIdx++;
  }

  // Exclusions
  if (excludeWorkIds.length > 0) {
    conditions.push(`w.id != ALL($${paramIdx}::bigint[])`);
    params.push(excludeWorkIds);
    paramIdx++;
  }

  params.push(limit);

  const { rows } = await query<{ id: number; title: string }>(
    `
    SELECT DISTINCT w.id, w.title
    FROM "Work" w
    JOIN "WorkSubject" ws ON w.id = ws.work_id
    WHERE ${conditions.join(" AND ")}
    LIMIT $${paramIdx}
    `,
    params
  );

  return rows;
}

/**
 * Upsert a work record
 */
export async function upsertWork(
  client: PoolClient,
  work: {
    ol_work_key?: string;
    title: string;
    subtitle?: string;
    description?: string;
    first_publish_year?: number;
    language?: string;
    series?: string;
    page_count_median?: number;
  }
): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `
    INSERT INTO "Work" (
      ol_work_key, title, subtitle, description,
      first_publish_year, language, series, page_count_median, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (ol_work_key) DO UPDATE SET
      title = EXCLUDED.title,
      subtitle = COALESCE(EXCLUDED.subtitle, "Work".subtitle),
      description = COALESCE(EXCLUDED.description, "Work".description),
      first_publish_year = COALESCE(EXCLUDED.first_publish_year, "Work".first_publish_year),
      language = COALESCE(EXCLUDED.language, "Work".language),
      series = COALESCE(EXCLUDED.series, "Work".series),
      page_count_median = COALESCE(EXCLUDED.page_count_median, "Work".page_count_median),
      updated_at = NOW()
    RETURNING id
    `,
    [
      work.ol_work_key ?? null,
      work.title,
      work.subtitle ?? null,
      work.description ?? null,
      work.first_publish_year ?? null,
      work.language ?? null,
      work.series ?? null,
      work.page_count_median ?? null,
    ]
  );

  return rows[0].id;
}

/**
 * Update work embedding
 */
export async function updateWorkEmbedding(
  workId: number,
  embedding: number[]
): Promise<void> {
  const vectorLit = toVectorLiteral(embedding);
  await query(
    `UPDATE "Work" SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
    [vectorLit, workId]
  );
}
