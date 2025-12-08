/**
 * Goodreads CSV export parser
 * Imports user reading history from Goodreads export
 *
 * Optimized for performance with:
 * - Two-phase import (parse all, then resolve all, then insert all)
 * - Batch ISBN resolution (single query for all ISBNs)
 * - Parallel title/author resolution with concurrency limit
 * - Batch database inserts
 * - Resume capability (skips already imported books)
 */

import { createReadStream } from "fs";
import { parse } from "csv-parse";
import pLimit from "p-limit";
import { query, transaction } from "@/lib/db/pool";
import { resolveByIsbnBatch } from "./resolve";
import { resolveWork, type ResolveInput } from "./resolverV2";
import { logger, createTimer } from "@/lib/util/logger";

interface GoodreadsRow {
  "Book Id": string;
  Title: string;
  Author: string;
  "Author l-f": string;
  "Additional Authors": string;
  ISBN: string;
  ISBN13: string;
  "My Rating": string;
  "Average Rating": string;
  Publisher: string;
  Binding: string;
  "Number of Pages": string;
  "Year Published": string;
  "Original Publication Year": string;
  "Date Read": string;
  "Date Added": string;
  Bookshelves: string;
  "Bookshelves with positions": string;
  "Exclusive Shelf": string;
  "My Review": string;
  Spoiler: string;
  "Private Notes": string;
  "Read Count": string;
  "Owned Copies": string;
}

interface ParsedBook {
  isbn13: string;
  isbn10: string;
  title: string;
  author: string;
  shelf: string;
  rating: number | null;
  finishedAt: Date | null;
  notes: string | null;
}

interface UserEventInsert {
  userId: string;
  workId: number;
  shelf: string;
  rating: number | null;
  finishedAt: Date | null;
  notes: string | null;
}

// Batch sizes for database operations
const INSERT_BATCH_SIZE = 500;
const TITLE_RESOLUTION_CONCURRENCY = 10;

/**
 * Map Goodreads shelf to our shelf type
 */
function mapShelf(exclusiveShelf: string): string {
  const shelf = exclusiveShelf.toLowerCase().trim();

  switch (shelf) {
    case "read":
      return "read";
    case "currently-reading":
      return "currently-reading";
    case "to-read":
      return "to-read";
    case "did-not-finish":
    case "dnf":
      return "dnf";
    default:
      return shelf;
  }
}

/**
 * Parse Goodreads date format
 */
function parseDate(dateStr: string): Date | null {
  if (!dateStr || dateStr.trim() === "") return null;

  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    return date;
  }

  return null;
}

/**
 * Clean ISBN from Goodreads format (="0123456789")
 */
function cleanIsbn(isbn: string): string {
  return isbn.replace(/^="?/, "").replace(/"?$/, "").trim();
}

/**
 * Get ISBNs of books already imported for this user
 * Used for resume capability
 */
async function getExistingImports(
  userId: string,
  source: string
): Promise<Set<string>> {
  const { rows } = await query<{ isbn13: string | null; isbn10: string | null }>(
    `SELECT e.isbn13, e.isbn10
     FROM "UserEvent" ue
     JOIN "Edition" e ON e.work_id = ue.work_id
     WHERE ue.user_id = $1 AND ue.source = $2`,
    [userId, source]
  );

  const existing = new Set<string>();
  for (const row of rows) {
    if (row.isbn13) existing.add(row.isbn13);
    if (row.isbn10) existing.add(row.isbn10);
  }
  return existing;
}

/**
 * Parse all rows from CSV into memory
 */
async function parseAllRows(csvPath: string): Promise<ParsedBook[]> {
  const books: ParsedBook[] = [];

  const parser = createReadStream(csvPath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
    })
  );

  for await (const row of parser as AsyncIterable<GoodreadsRow>) {
    // Goodreads uses "0" to mean "no rating", so treat 0 as null
    const rawRating = row["My Rating"] ? parseFloat(row["My Rating"]) : null;
    const rating = rawRating && rawRating > 0 ? rawRating : null;

    books.push({
      isbn13: cleanIsbn(row.ISBN13 || ""),
      isbn10: cleanIsbn(row.ISBN || ""),
      title: row.Title,
      author: row.Author,
      shelf: mapShelf(row["Exclusive Shelf"] || "read"),
      rating,
      finishedAt: parseDate(row["Date Read"]),
      notes: row["My Review"] || null,
    });
  }

  return books;
}

/**
 * Batch insert user events
 */
async function batchInsertUserEvents(events: UserEventInsert[]): Promise<void> {
  if (events.length === 0) return;

  for (let i = 0; i < events.length; i += INSERT_BATCH_SIZE) {
    const batch = events.slice(i, i + INSERT_BATCH_SIZE);

    await transaction(async (client) => {
      const values: unknown[] = [];
      const placeholders: string[] = [];

      batch.forEach((e, idx) => {
        const offset = idx * 6;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, 'goodreads', $${offset + 6})`
        );
        values.push(e.userId, e.workId, e.shelf, e.rating, e.finishedAt, e.notes);
      });

      await client.query(
        `INSERT INTO "UserEvent" (user_id, work_id, shelf, rating, finished_at, source, notes)
         VALUES ${placeholders.join(", ")}
         ON CONFLICT (user_id, work_id, source) DO UPDATE SET
           shelf = EXCLUDED.shelf,
           rating = COALESCE(EXCLUDED.rating, "UserEvent".rating),
           finished_at = COALESCE(EXCLUDED.finished_at, "UserEvent".finished_at),
           notes = COALESCE(EXCLUDED.notes, "UserEvent".notes)`,
        values
      );
    });
  }
}

/**
 * Import reading history from Goodreads CSV export
 *
 * Two-phase import for optimal performance:
 * 1. Parse CSV and collect all ISBNs
 * 2. Batch resolve ISBNs in single query
 * 3. Parallel resolve unmatched by title/author
 * 4. Batch insert all UserEvents
 */
export async function importGoodreads(options: {
  csvPath: string;
  userId: string;
  resolveUnknown?: boolean;
  createStubs?: boolean;
}): Promise<{
  imported: number;
  resolved: number;
  created: number;
  unresolved: number;
  skipped: number;
  errors: number;
}> {
  const { csvPath, userId, resolveUnknown = true, createStubs = true } = options;

  logger.info("Starting Goodreads import", { csvPath, userId });
  const timer = createTimer("Goodreads import");

  const stats = {
    imported: 0,
    resolved: 0,
    created: 0,
    unresolved: 0,
    skipped: 0,
    errors: 0,
  };

  // Phase 1: Parse entire CSV into memory
  logger.info("Phase 1: Parsing CSV");
  const allBooks = await parseAllRows(csvPath);
  logger.info(`Parsed ${allBooks.length} books from CSV`);

  // Phase 1b: Get existing imports for resume capability
  logger.info("Checking for existing imports (resume capability)");
  const existingIsbns = await getExistingImports(userId, "goodreads");
  logger.info(`Found ${existingIsbns.size} already imported ISBNs`);

  // Filter out already imported books and collect ISBNs for resolution
  const booksToProcess: ParsedBook[] = [];
  const isbnsToResolve: string[] = [];

  for (const book of allBooks) {
    // Check if already imported (resume capability)
    if (
      (book.isbn13 && existingIsbns.has(book.isbn13)) ||
      (book.isbn10 && existingIsbns.has(book.isbn10))
    ) {
      stats.skipped++;
      continue;
    }

    booksToProcess.push(book);

    // Collect ISBNs for batch resolution
    if (book.isbn13) isbnsToResolve.push(book.isbn13);
    if (book.isbn10) isbnsToResolve.push(book.isbn10);
  }

  logger.info(`${booksToProcess.length} books to process, ${stats.skipped} skipped (already imported)`);

  if (booksToProcess.length === 0) {
    timer.end(stats);
    return stats;
  }

  // Phase 2: Batch resolve all ISBNs in single query
  logger.info("Phase 2: Batch resolving ISBNs");
  const isbnResolutions = await resolveByIsbnBatch(isbnsToResolve);

  // Map books to work IDs and identify unresolved
  const pendingInserts: UserEventInsert[] = [];
  const unresolvedBooks: ParsedBook[] = [];

  for (const book of booksToProcess) {
    const workId =
      (book.isbn13 && isbnResolutions.get(book.isbn13)) ||
      (book.isbn10 && isbnResolutions.get(book.isbn10)) ||
      null;

    if (workId) {
      pendingInserts.push({
        userId,
        workId,
        shelf: book.shelf,
        rating: book.rating,
        finishedAt: book.finishedAt,
        notes: book.notes,
      });
    } else if (resolveUnknown) {
      unresolvedBooks.push(book);
    } else {
      stats.unresolved++;
    }
  }

  logger.info(`ISBN resolution: ${pendingInserts.length} resolved, ${unresolvedBooks.length} need title/author lookup`);

  // Phase 3: Resolve unmatched using resolverV2 (with stub creation)
  if (unresolvedBooks.length > 0) {
    logger.info("Phase 3: Resolving via resolverV2 (parallel)", {
      count: unresolvedBooks.length,
      createStubs,
    });

    const limit = pLimit(TITLE_RESOLUTION_CONCURRENCY);

    const resolutionPromises = unresolvedBooks.map((book, index) =>
      limit(async () => {
        try {
          // Build input for resolverV2
          const input: ResolveInput = {
            title: book.title,
            author: book.author,
            isbn13: book.isbn13 || undefined,
            isbn10: book.isbn10 || undefined,
          };

          // Use resolverV2 which will create stubs if createStubs is enabled
          // and no existing match is found
          const result = await resolveWork(input);

          return {
            index,
            workId: result.workId,
            created: result.created,
            confidence: result.confidence,
            path: result.path,
            error: null,
          };
        } catch (error) {
          return { index, workId: null, created: false, confidence: 0, path: null, error };
        }
      })
    );

    const resolutionResults = await Promise.all(resolutionPromises);

    for (const result of resolutionResults) {
      const book = unresolvedBooks[result.index];

      if (result.error) {
        stats.errors++;
        logger.warn("Error resolving book via resolverV2", {
          title: book.title,
          error: String(result.error),
        });
        continue;
      }

      if (result.workId) {
        // Check if we should skip low-confidence stubs when createStubs is false
        if (!createStubs && result.created && result.confidence < 0.7) {
          stats.unresolved++;
          logger.debug("Skipping low-confidence stub (createStubs=false)", {
            title: book.title,
            confidence: result.confidence,
          });
          continue;
        }

        pendingInserts.push({
          userId,
          workId: result.workId,
          shelf: book.shelf,
          rating: book.rating,
          finishedAt: book.finishedAt,
          notes: book.notes,
        });

        if (result.created) {
          stats.created++;
          logger.debug("Created new work for book", {
            title: book.title,
            workId: result.workId,
            path: result.path,
            confidence: result.confidence,
          });
        } else {
          stats.resolved++;
        }
      } else {
        stats.unresolved++;
        logger.debug("Could not resolve book", {
          title: book.title,
          author: book.author,
        });
      }
    }
  }

  // Phase 4: Batch insert all resolved books
  logger.info(`Phase 4: Batch inserting ${pendingInserts.length} user events`);
  await batchInsertUserEvents(pendingInserts);
  stats.imported = pendingInserts.length;

  timer.end(stats);
  return stats;
}

/**
 * Get import statistics for a user
 */
export async function getImportStats(userId: string): Promise<{
  total: number;
  read: number;
  toRead: number;
  currentlyReading: number;
  rated: number;
}> {
  const { rows } = await query<{
    total: string;
    read: string;
    to_read: string;
    currently_reading: string;
    rated: string;
  }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE shelf = 'read') AS read,
       COUNT(*) FILTER (WHERE shelf = 'to-read') AS to_read,
       COUNT(*) FILTER (WHERE shelf = 'currently-reading') AS currently_reading,
       COUNT(*) FILTER (WHERE rating IS NOT NULL) AS rated
     FROM "UserEvent"
     WHERE user_id = $1 AND source = 'goodreads'`,
    [userId]
  );

  const row = rows[0];
  return {
    total: parseInt(row.total, 10),
    read: parseInt(row.read, 10),
    toRead: parseInt(row.to_read, 10),
    currentlyReading: parseInt(row.currently_reading, 10),
    rated: parseInt(row.rated, 10),
  };
}
