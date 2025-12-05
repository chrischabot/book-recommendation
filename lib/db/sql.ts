import { PoolClient } from "pg";
import { getPool, query, withClient } from "./pool";
import { toVectorLiteral } from "./vector";

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
    workIds: rows.filter((r) => r.work_id !== null).map((r) => r.work_id!),
    authorIds: rows.filter((r) => r.author_id !== null).map((r) => r.author_id!),
  };
}

/**
 * Execute an AGE Cypher query
 */
export async function cypherQuery<T>(
  cypherStatement: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  return withClient(async (client) => {
    // Set up AGE
    await client.query(`LOAD 'age'`);
    await client.query(`SET search_path = ag_catalog, "$user", public`);

    // Build parameter substitution
    const paramEntries = Object.entries(params);
    let processedCypher = cypherStatement;

    // AGE doesn't support parameterized Cypher directly, so we substitute
    for (const [key, value] of paramEntries) {
      const placeholder = `$${key}`;
      let replacement: string;

      if (typeof value === "string") {
        replacement = `'${value.replace(/'/g, "''")}'`;
      } else if (typeof value === "number") {
        replacement = String(value);
      } else if (typeof value === "boolean") {
        replacement = value ? "true" : "false";
      } else if (value === null) {
        replacement = "null";
      } else {
        replacement = JSON.stringify(value);
      }

      processedCypher = processedCypher.replace(
        new RegExp(`\\$${key}\\b`, "g"),
        replacement
      );
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
      console.error("Graph neighbor query failed:", error);
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
