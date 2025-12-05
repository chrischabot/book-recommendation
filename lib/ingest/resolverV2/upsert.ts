/**
 * Upsert logic for Work + Edition + Author
 * Handles atomic creation/update of book entities
 */

import type { PoolClient } from "pg";
import { transaction } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";
import type {
  ResolveInput,
  UpsertOptions,
  UpsertResult,
  STUB_THRESHOLD,
} from "./types";

/**
 * Extract year from various date formats
 */
export function extractYear(dateStr?: string): number | null {
  if (!dateStr) return null;

  // Try full date parse
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    return date.getFullYear();
  }

  // Try extracting 4-digit year
  const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    return parseInt(yearMatch[0], 10);
  }

  return null;
}

/**
 * Parse author string into array (handles "Author1, Author2" and "Author1 & Author2")
 */
export function parseAuthors(authorStr?: string): string[] {
  if (!authorStr) return [];

  return authorStr
    .split(/[,&]/)
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

/**
 * Find existing Work by any known identifier
 * Checks in priority order: ISBN13 > ISBN10 > Google Volume ID > ASIN > Royal Road > Goodreads
 */
export async function findExistingWork(
  client: PoolClient,
  input: ResolveInput
): Promise<number | null> {
  // Build checks in priority order
  const checks: Array<{ sql: string; params: unknown[] }> = [];

  if (input.isbn13) {
    checks.push({
      sql: `SELECT work_id FROM "Edition" WHERE isbn13 = $1 LIMIT 1`,
      params: [input.isbn13],
    });
  }

  if (input.isbn10) {
    checks.push({
      sql: `SELECT work_id FROM "Edition" WHERE isbn10 = $1 LIMIT 1`,
      params: [input.isbn10],
    });
  }

  if (input.googleVolumeId) {
    checks.push({
      sql: `SELECT work_id FROM "Edition" WHERE google_volume_id = $1 LIMIT 1`,
      params: [input.googleVolumeId],
    });
  }

  if (input.asin) {
    checks.push({
      sql: `SELECT work_id FROM "Edition" WHERE asin = $1 LIMIT 1`,
      params: [input.asin],
    });
  }

  if (input.royalRoadId) {
    checks.push({
      sql: `SELECT work_id FROM "Edition" WHERE royalroad_fiction_id = $1 LIMIT 1`,
      params: [input.royalRoadId],
    });
  }

  if (input.goodreadsId) {
    checks.push({
      sql: `SELECT work_id FROM "Edition" WHERE goodreads_book_id = $1 LIMIT 1`,
      params: [input.goodreadsId],
    });
  }

  for (const check of checks) {
    const { rows } = await client.query<{ work_id: number }>(check.sql, check.params);
    if (rows[0]?.work_id) {
      return rows[0].work_id;
    }
  }

  return null;
}

/**
 * Find existing Edition by any known identifier
 */
export async function findExistingEdition(
  client: PoolClient,
  input: ResolveInput
): Promise<number | null> {
  const checks: Array<{ sql: string; params: unknown[] }> = [];

  if (input.isbn13) {
    checks.push({
      sql: `SELECT id FROM "Edition" WHERE isbn13 = $1 LIMIT 1`,
      params: [input.isbn13],
    });
  }

  if (input.isbn10) {
    checks.push({
      sql: `SELECT id FROM "Edition" WHERE isbn10 = $1 LIMIT 1`,
      params: [input.isbn10],
    });
  }

  if (input.googleVolumeId) {
    checks.push({
      sql: `SELECT id FROM "Edition" WHERE google_volume_id = $1 LIMIT 1`,
      params: [input.googleVolumeId],
    });
  }

  if (input.asin) {
    checks.push({
      sql: `SELECT id FROM "Edition" WHERE asin = $1 LIMIT 1`,
      params: [input.asin],
    });
  }

  for (const check of checks) {
    const { rows } = await client.query<{ id: number }>(check.sql, check.params);
    if (rows[0]?.id) {
      return rows[0].id;
    }
  }

  return null;
}

/**
 * Create a new Work
 */
async function createWork(
  client: PoolClient,
  input: ResolveInput,
  options: UpsertOptions
): Promise<number> {
  const isStub = options.confidence < 0.70;

  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO "Work" (
      title,
      description,
      first_publish_year,
      source,
      is_stub,
      stub_reason,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    RETURNING id`,
    [
      input.title || "Unknown Title",
      input.description || null,
      extractYear(input.publishedDate),
      options.source,
      isStub,
      isStub ? `Low confidence resolution: ${options.path}` : null,
    ]
  );

  return rows[0].id;
}

/**
 * Update existing Work with new data (only if fields are missing)
 */
async function updateWork(
  client: PoolClient,
  workId: number,
  input: ResolveInput
): Promise<void> {
  // Only update fields that are currently NULL
  await client.query(
    `UPDATE "Work" SET
      description = COALESCE(description, $2),
      first_publish_year = COALESCE(first_publish_year, $3),
      updated_at = NOW()
    WHERE id = $1`,
    [workId, input.description || null, extractYear(input.publishedDate)]
  );
}

/**
 * Upsert authors and create WorkAuthor edges
 */
async function upsertAuthors(
  client: PoolClient,
  workId: number,
  authorStr?: string
): Promise<void> {
  const authors = parseAuthors(authorStr);

  for (const name of authors) {
    // First try to find existing author by name
    let authorId: number | null = null;

    const { rows: existingRows } = await client.query<{ id: number }>(
      `SELECT id FROM "Author" WHERE name = $1 LIMIT 1`,
      [name]
    );

    if (existingRows[0]?.id) {
      authorId = existingRows[0].id;
    } else {
      // Create new author
      const { rows: newRows } = await client.query<{ id: number }>(
        `INSERT INTO "Author" (name, created_at)
         VALUES ($1, NOW())
         RETURNING id`,
        [name]
      );
      authorId = newRows[0]?.id ?? null;
    }

    if (!authorId) continue;

    // Create WorkAuthor edge (use explicit columns for conflict)
    await client.query(
      `INSERT INTO "WorkAuthor" (work_id, author_id, role)
       VALUES ($1, $2, 'author')
       ON CONFLICT (work_id, author_id, role) DO NOTHING`,
      [workId, authorId]
    );
  }
}

/**
 * Create or update Edition with all known identifiers
 */
async function upsertEdition(
  client: PoolClient,
  workId: number,
  input: ResolveInput
): Promise<{ editionId: number; created: boolean }> {
  // Check if edition already exists
  const existingEditionId = await findExistingEdition(client, input);

  if (existingEditionId) {
    // Update existing edition with any new identifiers
    await client.query(
      `UPDATE "Edition" SET
        isbn13 = COALESCE(isbn13, $2),
        isbn10 = COALESCE(isbn10, $3),
        asin = COALESCE(asin, $4),
        google_volume_id = COALESCE(google_volume_id, $5),
        royalroad_fiction_id = COALESCE(royalroad_fiction_id, $6),
        goodreads_book_id = COALESCE(goodreads_book_id, $7),
        cover_url = COALESCE(cover_url, $8),
        page_count = COALESCE(page_count, $9)
      WHERE id = $1`,
      [
        existingEditionId,
        input.isbn13 || null,
        input.isbn10 || null,
        input.asin || null,
        input.googleVolumeId || null,
        input.royalRoadId ? parseInt(input.royalRoadId, 10) : null,
        input.goodreadsId ? parseInt(input.goodreadsId, 10) : null,
        input.coverUrl || null,
        input.pageCount || null,
      ]
    );

    return { editionId: existingEditionId, created: false };
  }

  // Create new edition
  try {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO "Edition" (
        work_id,
        isbn13,
        isbn10,
        asin,
        google_volume_id,
        royalroad_fiction_id,
        goodreads_book_id,
        cover_url,
        page_count,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING id`,
      [
        workId,
        input.isbn13 || null,
        input.isbn10 || null,
        input.asin || null,
        input.googleVolumeId || null,
        input.royalRoadId ? parseInt(input.royalRoadId, 10) : null,
        input.goodreadsId ? parseInt(input.goodreadsId, 10) : null,
        input.coverUrl || null,
        input.pageCount || null,
      ]
    );

    return { editionId: rows[0].id, created: true };
  } catch (error: any) {
    // Handle uniqueness conflicts gracefully (e.g., duplicate ASIN/ISBN)
    if (error?.code === "23505") {
      const existingId = await findExistingEdition(client, input);
      if (existingId) {
        logger.warn("Edition already exists, reusing", {
          asin: input.asin,
          isbn13: input.isbn13,
          existingEditionId: existingId,
        });
        return { editionId: existingId, created: false };
      }
    }
    throw error;
  }
}

/**
 * Upsert subjects/categories
 */
async function upsertCategories(
  client: PoolClient,
  workId: number,
  categories?: string[]
): Promise<void> {
  if (!categories || categories.length === 0) return;

  for (const category of categories) {
    const normalized = category.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    if (!normalized) continue;

    // Upsert Subject (primary key is subject)
    await client.query(
      `INSERT INTO "Subject" (subject, typ)
       VALUES ($1, 'category')
       ON CONFLICT (subject) DO NOTHING`,
      [normalized]
    );

    // Create WorkSubject edge (primary key is work_id, subject)
    await client.query(
      `INSERT INTO "WorkSubject" (work_id, subject)
       VALUES ($1, $2)
       ON CONFLICT (work_id, subject) DO NOTHING`,
      [workId, normalized]
    );
  }
}

/**
 * Upsert ratings from external source
 */
async function upsertRating(
  client: PoolClient,
  workId: number,
  source: string,
  avgRating?: number,
  count?: number
): Promise<void> {
  if (!avgRating || !count) return;

  await client.query(
    `INSERT INTO "Rating" (work_id, source, avg, count, last_updated)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (work_id, source) DO UPDATE SET
       avg = EXCLUDED.avg,
       count = EXCLUDED.count,
       last_updated = NOW()`,
    [workId, source, avgRating, count]
  );
}

/**
 * Main upsert function - creates or updates Work + Edition atomically
 */
export async function upsertWorkAndEdition(
  input: ResolveInput,
  options: UpsertOptions
): Promise<UpsertResult> {
  return await transaction(async (client) => {
    // 1. Check for existing Work
    let workId = await findExistingWork(client, input);
    let workCreated = false;

    if (workId) {
      // Update existing work with any new data
      await updateWork(client, workId, input);
      logger.debug("Found existing work", { workId, input: input.title });
    } else {
      // Create new Work
      workId = await createWork(client, input, options);
      workCreated = true;
      logger.debug("Created new work", { workId, title: input.title, source: options.source });
    }

    // 2. Upsert Author(s)
    await upsertAuthors(client, workId, input.author);

    // 3. Upsert Edition
    const { editionId, created: editionCreated } = await upsertEdition(client, workId, input);

    // 4. Upsert Categories
    await upsertCategories(client, workId, input.categories);

    // 5. Upsert Ratings
    if (options.source === "googlebooks") {
      await upsertRating(client, workId, "googlebooks", input.averageRating, input.ratingsCount);
    }

    return {
      workId,
      editionId,
      created: workCreated || editionCreated,
      workCreated,
      editionCreated,
    };
  });
}
