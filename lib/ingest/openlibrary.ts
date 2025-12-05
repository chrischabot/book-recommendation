/**
 * Open Library data ingestion
 * Processes JSONL dump files for works, editions, authors, ratings,
 * reading-log, redirects, covers, wikidata, and lists
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { PoolClient } from "pg";
import { transaction, query } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

// ============================================================================
// Type definitions for Open Library data structures
// ============================================================================

export interface OLWork {
  key: string;
  title: string;
  subtitle?: string;
  description?: string | { value: string };
  first_publish_date?: string;
  subjects?: string[];
  subject_places?: string[];
  subject_people?: string[];
  subject_times?: string[];
  authors?: Array<{ author: { key: string } }>;
  covers?: number[];
  links?: Array<{ url: string; title: string }>;
  dewey_number?: string[];
  lc_classifications?: string[];
}

export interface OLEdition {
  key: string;
  works?: Array<{ key: string }>;
  title: string;
  isbn_10?: string[];
  isbn_13?: string[];
  publishers?: string[];
  publish_date?: string;
  number_of_pages?: number;
  covers?: number[];
  languages?: Array<{ key: string }>;
  physical_format?: string;
  weight?: string;
  oclc_numbers?: string[];
  lccn?: string[];
}

export interface OLAuthor {
  key: string;
  name: string;
  bio?: string | { value: string };
  birth_date?: string;
  death_date?: string;
  personal_name?: string;
  alternate_names?: string[];
  wikipedia?: string;
  links?: Array<{ url: string; title: string }>;
  photos?: number[];
}

export interface OLRating {
  work_key: string;
  edition_key?: string;
  user_key?: string;
  rating?: number;
  average?: number;
  count?: number;
  date?: string;
}

export interface OLReadingLogEntry {
  work_key: string;
  edition_key?: string;
  user_key: string;
  status: string; // 'want-to-read' | 'currently-reading' | 'already-read'
  date?: string;
}

export interface OLRedirect {
  key: string;
  location: string;
  type?: { key: string };
}

export interface OLCoverMetadata {
  id: number;
  filename?: string;
  olid?: string;
  author?: string;
  source_url?: string;
  width?: number;
  height?: number;
  created?: string;
  last_modified?: string;
}

export interface OLWikidataEntry {
  key: string;
  type?: { key: string };
  wikidata?: string;
  wikipedia?: string;
}

export interface OLList {
  key: string;
  name: string;
  description?: string | { value: string };
  seeds?: Array<{ key: string } | string>;
  seed_count?: number;
  created?: { value: string };
  last_modified?: { value: string };
}

/**
 * Extract text from Open Library description field
 */
function extractDescription(desc: string | { value: string } | undefined): string | null {
  if (!desc) return null;
  if (typeof desc === "string") return desc;
  return desc.value ?? null;
}

/**
 * Extract year from date string
 */
function extractYear(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const match = dateStr.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract OL key ID from full key path
 * e.g., "/works/OL123W" -> "OL123W"
 */
function extractOlId(key: string): string {
  return key.split("/").pop() ?? key;
}

/**
 * Stream and process Open Library JSONL dump file
 */
async function streamJsonl<T>(
  filePath: string,
  processor: (item: T, client: PoolClient) => Promise<void>,
  options: { batchSize?: number; maxItems?: number } = {}
): Promise<number> {
  const { batchSize = 1000, maxItems } = options;
  const timer = createTimer(`Processing ${filePath}`);

  let processed = 0;
  let batch: T[] = [];

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (maxItems && processed >= maxItems) break;

    try {
      // OL dumps have format: type\tkey\trevision\tlast_modified\tjson
      const parts = line.split("\t");
      if (parts.length < 5) continue;

      const json = parts[4];
      const item = JSON.parse(json) as T;
      batch.push(item);

      if (batch.length >= batchSize) {
        await transaction(async (client) => {
          for (const item of batch) {
            await processor(item, client);
          }
        });
        processed += batch.length;
        logger.debug(`Processed ${processed} items`);
        batch = [];
      }
    } catch (error) {
      const errMsg = String(error);
      if (errMsg.includes("too many clients") || errMsg.includes("connection")) {
        logger.error("Database connection error during batch processing", { error: errMsg });
      } else {
        logger.warn("Failed to parse line", { error: errMsg });
      }
    }
  }

  // Process remaining batch
  if (batch.length > 0) {
    await transaction(async (client) => {
      for (const item of batch) {
        await processor(item, client);
      }
    });
    processed += batch.length;
  }

  timer.end({ totalItems: processed });
  return processed;
}

/**
 * Metadata from the 5-column TSV dump format
 */
interface DumpMetadata {
  type: string;
  key: string;
  revision: number | null;
  lastModified: string | null;
}

/**
 * Stream and process Open Library JSONL dump file with raw JSON access
 * Used when we need to store the original JSON in a jsonb column
 * Now also parses revision and last_modified from the TSV columns
 */
async function streamJsonlRaw<T>(
  filePath: string,
  processor: (item: T, rawJson: string, meta: DumpMetadata, client: PoolClient) => Promise<void>,
  options: { batchSize?: number; maxItems?: number } = {}
): Promise<number> {
  const { batchSize = 1000, maxItems } = options;
  const timer = createTimer(`Processing ${filePath}`);

  let processed = 0;
  let batch: Array<{ item: T; rawJson: string; meta: DumpMetadata }> = [];

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (maxItems && processed >= maxItems) break;

    try {
      // OL dumps have format: type\tkey\trevision\tlast_modified\tjson
      const parts = line.split("\t");
      if (parts.length < 5) continue;

      const [type, key, revisionStr, lastModified, rawJson] = parts;
      const revision = revisionStr ? parseInt(revisionStr, 10) : null;
      const meta: DumpMetadata = {
        type,
        key,
        revision: isNaN(revision as number) ? null : revision,
        lastModified: lastModified || null,
      };

      const item = JSON.parse(rawJson) as T;
      batch.push({ item, rawJson, meta });

      if (batch.length >= batchSize) {
        await transaction(async (client) => {
          for (const { item, rawJson, meta } of batch) {
            await processor(item, rawJson, meta, client);
          }
        });
        processed += batch.length;
        if (processed % 10000 === 0) {
          logger.info(`Processed ${processed} items`);
        }
        batch = [];
      }
    } catch (error) {
      const errMsg = String(error);
      if (errMsg.includes("too many clients") || errMsg.includes("connection")) {
        logger.error("Database connection error during batch processing", { error: errMsg });
      } else {
        logger.warn("Failed to parse line", { error: errMsg });
      }
    }
  }

  // Process remaining batch
  if (batch.length > 0) {
    await transaction(async (client) => {
      for (const { item, rawJson, meta } of batch) {
        await processor(item, rawJson, meta, client);
      }
    });
    processed += batch.length;
  }

  timer.end({ totalItems: processed });
  return processed;
}

/**
 * Stream tab-separated value files (for ratings, reading-log)
 */
async function streamTsv(
  filePath: string,
  processor: (fields: string[], client: PoolClient) => Promise<void>,
  options: { batchSize?: number; maxItems?: number; minFields?: number } = {}
): Promise<number> {
  const { batchSize = 1000, maxItems, minFields = 1 } = options;
  const timer = createTimer(`Processing TSV ${filePath}`);

  let processed = 0;
  let batch: string[][] = [];

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (maxItems && processed >= maxItems) break;

    try {
      const fields = line.split("\t");
      if (fields.length < minFields) continue;

      batch.push(fields);

      if (batch.length >= batchSize) {
        await transaction(async (client) => {
          for (const fields of batch) {
            await processor(fields, client);
          }
        });
        processed += batch.length;
        if (processed % 10000 === 0) {
          logger.info(`Processed ${processed} items`);
        }
        batch = [];
      }
    } catch (error) {
      const errMsg = String(error);
      if (errMsg.includes("too many clients") || errMsg.includes("connection")) {
        logger.error("Database connection error during batch processing", { error: errMsg });
      } else {
        logger.warn("Failed to process TSV line", { error: errMsg });
      }
    }
  }

  // Process remaining batch
  if (batch.length > 0) {
    await transaction(async (client) => {
      for (const fields of batch) {
        await processor(fields, client);
      }
    });
    processed += batch.length;
  }

  timer.end({ totalItems: processed });
  return processed;
}

/**
 * Ingest works from Open Library dump using bulk multi-row INSERT
 * This is 10-20x faster than individual INSERTs
 */
export async function ingestWorks(
  filePath: string,
  options?: { batchSize?: number; maxItems?: number; skipLines?: number }
): Promise<number> {
  logger.info("Starting works ingestion (bulk mode)", { filePath });

  const { batchSize = 2000, maxItems, skipLines = 0 } = options ?? {};
  let lineNumber = 0;
  const timer = createTimer(`Processing ${filePath}`);

  let processed = 0;
  let batch: Array<{
    olKey: string;
    title: string;
    subtitle: string | null;
    description: string | null;
    year: number | null;
    revision: number | null;
    lastModified: string | null;
    subjects: Array<{ val: string; typ: string }>;
  }> = [];

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  const flushBatch = async () => {
    if (batch.length === 0) return;

    await transaction(async (client) => {
      // 1. Bulk insert works (skip ol_data JSONB to save storage - it's never queried)
      const paramsPerRow = 7;
      const values: unknown[] = [];
      const valuePlaceholders: string[] = [];

      for (let i = 0; i < batch.length; i++) {
        const row = batch[i];
        const offset = i * paramsPerRow;
        valuePlaceholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::date, NOW())`
        );
        values.push(
          row.olKey,
          row.title,
          row.subtitle,
          row.description,
          row.year,
          row.revision,
          row.lastModified
        );
      }

      await client.query(
        `
        INSERT INTO "Work" (ol_work_key, title, subtitle, description, first_publish_year, ol_revision, ol_last_modified, updated_at)
        VALUES ${valuePlaceholders.join(", ")}
        ON CONFLICT (ol_work_key) DO UPDATE SET
          title = EXCLUDED.title,
          subtitle = COALESCE(EXCLUDED.subtitle, "Work".subtitle),
          description = COALESCE(EXCLUDED.description, "Work".description),
          first_publish_year = COALESCE(EXCLUDED.first_publish_year, "Work".first_publish_year),
          ol_revision = EXCLUDED.ol_revision,
          ol_last_modified = EXCLUDED.ol_last_modified,
          updated_at = NOW()
        `,
        values
      );

      // 2. Collect all unique subjects and bulk insert
      const allSubjects = new Map<string, string>();
      for (const work of batch) {
        for (const { val, typ } of work.subjects) {
          const normalized = val.toLowerCase().replace(/\s+/g, "_");
          allSubjects.set(normalized, typ);
        }
      }

      if (allSubjects.size > 0) {
        const subjectValues: unknown[] = [];
        const subjectPlaceholders: string[] = [];
        let idx = 0;
        for (const [subject, typ] of allSubjects) {
          subjectPlaceholders.push(`($${idx * 2 + 1}, $${idx * 2 + 2})`);
          subjectValues.push(subject, typ);
          idx++;
        }

        await client.query(
          `INSERT INTO "Subject" (subject, typ) VALUES ${subjectPlaceholders.join(", ")} ON CONFLICT DO NOTHING`,
          subjectValues
        );
      }

      // 3. Bulk insert work-subject relationships
      const workSubjectPairs: Array<{ olKey: string; subject: string }> = [];
      for (const work of batch) {
        for (const { val } of work.subjects) {
          const normalized = val.toLowerCase().replace(/\s+/g, "_");
          workSubjectPairs.push({ olKey: work.olKey, subject: normalized });
        }
      }

      if (workSubjectPairs.length > 0) {
        // Process in chunks to avoid too many parameters
        const chunkSize = 2000;
        for (let i = 0; i < workSubjectPairs.length; i += chunkSize) {
          const chunk = workSubjectPairs.slice(i, i + chunkSize);
          const wsValues: unknown[] = [];
          const wsPlaceholders: string[] = [];

          for (let j = 0; j < chunk.length; j++) {
            wsPlaceholders.push(`($${j * 2 + 1}, $${j * 2 + 2})`);
            wsValues.push(chunk[j].olKey, chunk[j].subject);
          }

          await client.query(
            `
            INSERT INTO "WorkSubject" (work_id, subject)
            SELECT w.id, v.subject
            FROM (VALUES ${wsPlaceholders.join(", ")}) AS v(ol_key, subject)
            JOIN "Work" w ON w.ol_work_key = v.ol_key
            ON CONFLICT DO NOTHING
            `,
            wsValues
          );
        }
      }
    });

    processed += batch.length;
    if (processed % 50000 === 0) {
      logger.info(`Processed ${processed} items`);
    }
    batch = [];
  };

  if (skipLines > 0) {
    logger.info(`Skipping first ${skipLines} lines`);
  }

  for await (const line of rl) {
    lineNumber++;

    // Skip lines until we reach the skipLines threshold
    if (lineNumber <= skipLines) {
      if (lineNumber % 1000000 === 0) {
        logger.info(`Skipping line ${lineNumber}/${skipLines}`);
      }
      continue;
    }

    if (maxItems && processed + batch.length >= maxItems) break;

    try {
      const parts = line.split("\t");
      if (parts.length < 5) continue;

      const [type, key, revisionStr, lastModified, rawJson] = parts;
      const revision = revisionStr ? parseInt(revisionStr, 10) : null;
      const work = JSON.parse(rawJson) as OLWork;

      // Skip works without a title
      if (!work.title) continue;

      const subjects = [
        ...(work.subjects ?? []).map((s) => ({ val: s, typ: "subject" })),
        ...(work.subject_places ?? []).map((s) => ({ val: s, typ: "place" })),
        ...(work.subject_people ?? []).map((s) => ({ val: s, typ: "person" })),
        ...(work.subject_times ?? []).map((s) => ({ val: s, typ: "time" })),
      ].slice(0, 50); // Limit subjects per work

      batch.push({
        olKey: extractOlId(work.key),
        title: work.title,
        subtitle: work.subtitle ?? null,
        description: extractDescription(work.description),
        year: extractYear(work.first_publish_date),
        revision: isNaN(revision as number) ? null : revision,
        lastModified: lastModified || null,
        subjects,
      });

      if (batch.length >= batchSize) {
        await flushBatch();
      }
    } catch (error) {
      // Skip malformed lines silently
    }
  }

  // Flush remaining
  await flushBatch();

  timer.end({ totalItems: processed });
  return processed;
}

/**
 * Ingest editions from Open Library dump
 */
export async function ingestEditions(
  filePath: string,
  options?: { batchSize?: number; maxItems?: number }
): Promise<number> {
  logger.info("Starting editions ingestion", { filePath });

  return streamJsonlRaw(
    filePath,
    async (edition: OLEdition, rawJson: string, meta: DumpMetadata, client: PoolClient) => {
      const workKey = edition.works?.[0]?.key;
      if (!workKey) return;

      const olWorkKey = extractOlId(workKey);
      const olEditionKey = extractOlId(edition.key);
      const isbn13 = edition.isbn_13?.[0] ?? null;
      const isbn10 = edition.isbn_10?.[0] ?? null;
      const coverId = edition.covers?.[0]?.toString() ?? null;

      const result = await client.query(
        `
        INSERT INTO "Edition" (
          ol_edition_key, work_id, isbn10, isbn13,
          publisher, pub_date, page_count, cover_id, ol_data,
          ol_revision, ol_last_modified
        )
        SELECT $1, w.id, $2, $3, $4,
          CASE WHEN $5 ~ '^[0-9]{4}' THEN to_date($5, 'YYYY') ELSE NULL END,
          $6, $7, $9::jsonb, $10, $11::date
        FROM "Work" w WHERE w.ol_work_key = $8
        ON CONFLICT (ol_edition_key) DO UPDATE SET
          isbn10 = COALESCE(EXCLUDED.isbn10, "Edition".isbn10),
          isbn13 = COALESCE(EXCLUDED.isbn13, "Edition".isbn13),
          publisher = COALESCE(EXCLUDED.publisher, "Edition".publisher),
          page_count = COALESCE(EXCLUDED.page_count, "Edition".page_count),
          cover_id = COALESCE(EXCLUDED.cover_id, "Edition".cover_id),
          ol_data = EXCLUDED.ol_data,
          ol_revision = EXCLUDED.ol_revision,
          ol_last_modified = EXCLUDED.ol_last_modified
        RETURNING id
        `,
        [
          olEditionKey,
          isbn10,
          isbn13,
          edition.publishers?.[0] ?? null,
          edition.publish_date ?? null,
          edition.number_of_pages ?? null,
          coverId,
          olWorkKey,
          rawJson,
          meta.revision,
          meta.lastModified,
        ]
      );

      // Populate EditionISBN junction table for all ISBNs
      const editionId = result.rows[0]?.id;
      if (editionId) {
        // Insert all ISBN-13s
        for (const isbn of edition.isbn_13 ?? []) {
          await client.query(
            `INSERT INTO "EditionISBN" (edition_id, isbn, isbn_type) VALUES ($1, $2, 'isbn13') ON CONFLICT DO NOTHING`,
            [editionId, isbn]
          );
        }
        // Insert all ISBN-10s
        for (const isbn of edition.isbn_10 ?? []) {
          await client.query(
            `INSERT INTO "EditionISBN" (edition_id, isbn, isbn_type) VALUES ($1, $2, 'isbn10') ON CONFLICT DO NOTHING`,
            [editionId, isbn]
          );
        }
      }
    },
    options
  );
}

/**
 * Ingest authors from Open Library dump using bulk multi-row INSERT
 * This is 10-20x faster than individual INSERTs
 */
export async function ingestAuthors(
  filePath: string,
  options?: { batchSize?: number; maxItems?: number }
): Promise<number> {
  logger.info("Starting authors ingestion (bulk mode)", { filePath });

  const { batchSize = 5000, maxItems } = options ?? {};
  const timer = createTimer(`Processing ${filePath}`);

  let processed = 0;
  let batch: Array<{
    olKey: string;
    name: string;
    bio: string | null;
    revision: number | null;
    lastModified: string | null;
  }> = [];

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  const flushBatch = async () => {
    if (batch.length === 0) return;

    // Build multi-row INSERT with parameterized values (skip ol_data JSONB to save storage)
    // Each row needs 5 params: olKey, name, bio, revision, lastModified
    const paramsPerRow = 5;
    const values: unknown[] = [];
    const valuePlaceholders: string[] = [];

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const offset = i * paramsPerRow;
      valuePlaceholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::date)`
      );
      values.push(
        row.olKey,
        row.name,
        row.bio,
        row.revision,
        row.lastModified
      );
    }

    await transaction(async (client) => {
      await client.query(
        `
        INSERT INTO "Author" (ol_author_key, name, bio, ol_revision, ol_last_modified)
        VALUES ${valuePlaceholders.join(", ")}
        ON CONFLICT (ol_author_key) DO UPDATE SET
          name = EXCLUDED.name,
          bio = COALESCE(EXCLUDED.bio, "Author".bio),
          ol_revision = EXCLUDED.ol_revision,
          ol_last_modified = EXCLUDED.ol_last_modified
        `,
        values
      );
    });

    processed += batch.length;
    if (processed % 50000 === 0) {
      logger.info(`Processed ${processed} items`);
    }
    batch = [];
  };

  for await (const line of rl) {
    if (maxItems && processed + batch.length >= maxItems) break;

    try {
      const parts = line.split("\t");
      if (parts.length < 5) continue;

      const [type, key, revisionStr, lastModified, rawJson] = parts;
      const revision = revisionStr ? parseInt(revisionStr, 10) : null;
      const author = JSON.parse(rawJson) as OLAuthor;

      // Skip authors without a name
      if (!author.name) continue;

      batch.push({
        olKey: extractOlId(author.key),
        name: author.name,
        bio: extractDescription(author.bio),
        revision: isNaN(revision as number) ? null : revision,
        lastModified: lastModified || null,
      });

      if (batch.length >= batchSize) {
        await flushBatch();
      }
    } catch (error) {
      // Skip malformed lines silently
    }
  }

  // Flush remaining
  await flushBatch();

  timer.end({ totalItems: processed });
  return processed;
}

/**
 * Ingest ratings from Open Library dump using multi-row INSERT
 * Format: work_key \t edition_key \t rating \t date
 * or:     work_key \t edition_key \t rating \t date \t user_key
 */
export async function ingestRatings(
  filePath: string,
  options?: { batchSize?: number; maxItems?: number }
): Promise<number> {
  logger.info("Starting ratings ingestion (bulk mode)", { filePath });

  const { batchSize = 2000, maxItems } = options ?? {};
  const timer = createTimer(`Processing ${filePath}`);

  let processed = 0;
  let batch: Array<{
    workKey: string;
    editionKey: string | null;
    userKey: string;
    rating: number;
    ratedDate: string | null;
  }> = [];

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  const flushBatch = async () => {
    if (batch.length === 0) return;

    // Build multi-row INSERT
    const paramsPerRow = 5;
    const values: unknown[] = [];
    const valuePlaceholders: string[] = [];

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const offset = i * paramsPerRow;
      valuePlaceholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::date)`
      );
      values.push(row.workKey, row.editionKey, row.userKey, row.rating, row.ratedDate);
    }

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO "OLRating" (work_key, edition_key, ol_user_key, rating, rated_date)
         VALUES ${valuePlaceholders.join(", ")}
         ON CONFLICT (work_key, ol_user_key) DO UPDATE SET
           rating = EXCLUDED.rating,
           rated_date = COALESCE(EXCLUDED.rated_date, "OLRating".rated_date)`,
        values
      );
    });

    processed += batch.length;
    if (processed % 50000 === 0) {
      logger.info(`Processed ${processed} ratings`);
    }
    batch = [];
  };

  for await (const line of rl) {
    if (maxItems && processed + batch.length >= maxItems) break;

    const fields = line.split("\t");
    if (fields.length < 3) continue;

    const [workKey, editionKey, ratingStr, dateStr, userKey] = fields;
    if (!workKey || !ratingStr) continue;

    const rating = parseInt(ratingStr, 10);
    if (isNaN(rating) || rating < 1 || rating > 5) continue;

    batch.push({
      workKey: extractOlId(workKey),
      editionKey: editionKey ? extractOlId(editionKey) : null,
      userKey: userKey ? extractOlId(userKey) : `anon_${processed + batch.length}`,
      rating,
      ratedDate: dateStr || null,
    });

    if (batch.length >= batchSize) {
      await flushBatch();
    }
  }

  // Flush remaining
  await flushBatch();

  timer.end({ totalItems: processed });
  return processed;
}

/**
 * Ingest reading log from Open Library dump using multi-row INSERT
 * Format: work_key \t edition_key \t date \t user_key \t status
 */
export async function ingestReadingLog(
  filePath: string,
  options?: { batchSize?: number; maxItems?: number }
): Promise<number> {
  logger.info("Starting reading log ingestion (bulk mode)", { filePath });

  const { batchSize = 2000, maxItems } = options ?? {};
  const timer = createTimer(`Processing ${filePath}`);

  let processed = 0;
  let batch: Array<{
    workKey: string;
    editionKey: string | null;
    userKey: string;
    status: string;
    loggedDate: string | null;
  }> = [];

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  const flushBatch = async () => {
    if (batch.length === 0) return;

    // Build multi-row INSERT
    const paramsPerRow = 5;
    const values: unknown[] = [];
    const valuePlaceholders: string[] = [];

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const offset = i * paramsPerRow;
      valuePlaceholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::date)`
      );
      values.push(row.workKey, row.editionKey, row.userKey, row.status, row.loggedDate);
    }

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO "OLReadingLog" (work_key, edition_key, ol_user_key, status, logged_date)
         VALUES ${valuePlaceholders.join(", ")}`,
        values
      );
    });

    processed += batch.length;
    if (processed % 100000 === 0) {
      logger.info(`Processed ${processed} reading log entries`);
    }
    batch = [];
  };

  for await (const line of rl) {
    if (maxItems && processed + batch.length >= maxItems) break;

    const fields = line.split("\t");
    if (fields.length < 5) continue;

    const [workKey, editionKey, dateStr, userKey, status] = fields;
    if (!workKey || !userKey || !status) continue;

    batch.push({
      workKey: extractOlId(workKey),
      editionKey: editionKey ? extractOlId(editionKey) : null,
      userKey: extractOlId(userKey),
      status,
      loggedDate: dateStr || null,
    });

    if (batch.length >= batchSize) {
      await flushBatch();
    }
  }

  // Flush remaining
  await flushBatch();

  timer.end({ totalItems: processed });
  return processed;
}

/**
 * Ingest redirects from Open Library dump
 */
export async function ingestRedirects(
  filePath: string,
  options?: { batchSize?: number; maxItems?: number }
): Promise<number> {
  logger.info("Starting redirects ingestion", { filePath });

  return streamJsonl<OLRedirect>(
    filePath,
    async (redirect, client) => {
      if (!redirect.location) return;

      const oldKey = redirect.key;
      const newKey = redirect.location;

      // Determine entity type from key path
      let entityType = "unknown";
      if (oldKey.includes("/works/")) entityType = "work";
      else if (oldKey.includes("/editions/") || oldKey.includes("/books/")) entityType = "edition";
      else if (oldKey.includes("/authors/")) entityType = "author";

      await client.query(
        `
        INSERT INTO "OLRedirect" (old_key, new_key, entity_type)
        VALUES ($1, $2, $3)
        ON CONFLICT (old_key) DO UPDATE SET
          new_key = EXCLUDED.new_key,
          entity_type = EXCLUDED.entity_type
        `,
        [oldKey, newKey, entityType]
      );
    },
    options
  );
}

/**
 * Ingest covers metadata from Open Library dump
 */
export async function ingestCoversMetadata(
  filePath: string,
  options?: { batchSize?: number; maxItems?: number }
): Promise<number> {
  logger.info("Starting covers metadata ingestion", { filePath });

  return streamJsonl<OLCoverMetadata>(
    filePath,
    async (cover, client) => {
      if (!cover.id) return;

      const coverId = cover.id.toString();
      const olid = cover.olid ?? null;

      // Determine if this is an edition or author cover
      const isAuthor = cover.author ? true : false;

      await client.query(
        `
        INSERT INTO "OLCover" (cover_id, archive_id, edition_key, author_key, width, height)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (cover_id) DO UPDATE SET
          archive_id = COALESCE(EXCLUDED.archive_id, "OLCover".archive_id),
          width = COALESCE(EXCLUDED.width, "OLCover".width),
          height = COALESCE(EXCLUDED.height, "OLCover".height)
        `,
        [
          coverId,
          cover.filename ?? null,
          isAuthor ? null : olid,
          isAuthor ? olid : null,
          cover.width ?? null,
          cover.height ?? null,
        ]
      );
    },
    options
  );
}

/**
 * Ingest wikidata links from Open Library dump
 */
export async function ingestWikidata(
  filePath: string,
  options?: { batchSize?: number; maxItems?: number }
): Promise<number> {
  logger.info("Starting wikidata ingestion", { filePath });

  return streamJsonlRaw(
    filePath,
    async (entry: OLWikidataEntry, rawJson: string, _meta: DumpMetadata, client: PoolClient) => {
      if (!entry.wikidata) return;

      const olKey = entry.key;
      const wikidataId = entry.wikidata;

      // Determine entity type from key path
      let entityType = "unknown";
      if (olKey.includes("/works/")) entityType = "work";
      else if (olKey.includes("/editions/") || olKey.includes("/books/")) entityType = "edition";
      else if (olKey.includes("/authors/")) entityType = "author";

      await client.query(
        `
        INSERT INTO "OLWikidata" (ol_key, entity_type, wikidata_id, data)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (ol_key) DO UPDATE SET
          wikidata_id = EXCLUDED.wikidata_id,
          data = EXCLUDED.data
        `,
        [olKey, entityType, wikidataId, rawJson]
      );
    },
    options
  );
}

/**
 * Ingest lists from Open Library dump
 */
export async function ingestLists(
  filePath: string,
  options?: { batchSize?: number; maxItems?: number }
): Promise<number> {
  logger.info("Starting lists ingestion", { filePath });

  return streamJsonlRaw(
    filePath,
    async (list: OLList, rawJson: string, _meta: DumpMetadata, client: PoolClient) => {
      if (!list.key || !list.name) return;

      const listKey = list.key;
      const description = extractDescription(list.description);

      // Extract user key from list key: /people/username/lists/OL123L
      const userMatch = listKey.match(/\/people\/([^/]+)\//);
      const olUserKey = userMatch ? userMatch[1] : "unknown";

      // Insert or update the list
      const result = await client.query(
        `
        INSERT INTO "OLList" (list_key, ol_user_key, name, description, seed_count, data, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
        ON CONFLICT (list_key) DO UPDATE SET
          name = EXCLUDED.name,
          description = COALESCE(EXCLUDED.description, "OLList".description),
          seed_count = EXCLUDED.seed_count,
          data = EXCLUDED.data,
          updated_at = NOW()
        RETURNING id
        `,
        [listKey, olUserKey, list.name, description, list.seed_count ?? 0, rawJson]
      );

      const listId = result.rows[0]?.id;
      if (!listId || !list.seeds) return;

      // Insert seeds
      for (let i = 0; i < Math.min(list.seeds.length, 1000); i++) {
        const seed = list.seeds[i];
        const seedKey = typeof seed === "string" ? seed : seed.key;
        if (!seedKey) continue;

        const seedType = seedKey.includes("/works/") ? "work" : "edition";

        await client.query(
          `
          INSERT INTO "OLListSeed" (list_id, seed_key, seed_type, position)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (list_id, seed_key) DO NOTHING
          `,
          [listId, seedKey, seedType, i]
        );
      }
    },
    options
  );
}

/**
 * Link works to authors (post-processing after works and authors are ingested)
 */
export async function linkWorkAuthors(worksFilePath: string): Promise<number> {
  logger.info("Linking works to authors");

  let linked = 0;

  return streamJsonl<OLWork>(
    worksFilePath,
    async (work, client) => {
      if (!work.authors || work.authors.length === 0) return;

      const olWorkKey = extractOlId(work.key);

      for (const authorRef of work.authors) {
        const olAuthorKey = extractOlId(authorRef.author.key);

        const result = await client.query(
          `
          INSERT INTO "WorkAuthor" (work_id, author_id, role)
          SELECT w.id, a.id, 'author'
          FROM "Work" w, "Author" a
          WHERE w.ol_work_key = $1 AND a.ol_author_key = $2
          ON CONFLICT DO NOTHING
          `,
          [olWorkKey, olAuthorKey]
        );

        if (result.rowCount && result.rowCount > 0) linked++;
      }
    },
    { batchSize: 1000 }
  );
}

/**
 * Compute page count median for works from their editions
 */
export async function computePageCountMedian(): Promise<void> {
  logger.info("Computing page count medians");
  const timer = createTimer("Page count median computation");

  await transaction(async (client) => {
    await client.query(`
      UPDATE "Work" w
      SET page_count_median = sub.median_pages
      FROM (
        SELECT
          work_id,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY page_count) AS median_pages
        FROM "Edition"
        WHERE page_count IS NOT NULL AND page_count > 0
        GROUP BY work_id
      ) sub
      WHERE w.id = sub.work_id
    `);
  });

  timer.end();
}

/**
 * Refresh all materialized views for aggregated data
 */
export async function refreshMaterializedViews(): Promise<void> {
  logger.info("Refreshing materialized views");
  const timer = createTimer("Materialized view refresh");

  // Refresh work popularity from reading logs
  await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY "WorkPopularity"`).catch(() => {
    // If CONCURRENTLY fails (no unique index), do regular refresh
    return query(`REFRESH MATERIALIZED VIEW "WorkPopularity"`);
  });

  // Refresh aggregated OL ratings
  await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY "WorkOLRating"`).catch(() => {
    return query(`REFRESH MATERIALIZED VIEW "WorkOLRating"`);
  });

  // Update the aggregate Rating table from individual OL ratings
  await transaction(async (client) => {
    await client.query(`
      INSERT INTO "Rating" (work_id, source, avg, count, last_updated)
      SELECT w.id, 'openlibrary', r.avg_rating, r.rating_count, NOW()
      FROM "WorkOLRating" r
      JOIN "Work" w ON w.ol_work_key = SUBSTRING(r.work_key FROM '[^/]+$')
      ON CONFLICT (work_id, source) DO UPDATE SET
        avg = EXCLUDED.avg,
        count = EXCLUDED.count,
        last_updated = NOW()
    `);
  });

  timer.end();
}
