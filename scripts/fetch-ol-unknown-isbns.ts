#!/usr/bin/env tsx
/**
 * Fetch ISBNs for "unknown" Open Library works and upsert into Edition/EditionISBN.
 *
 * Usage:
 *   pnpm fetch:ol-isbns            # process all unknown works with ol_work_key
 *   pnpm fetch:ol-isbns -- --limit 50 --concurrency 4
 */

import "dotenv/config";
import { parseArgs } from "util";
import pLimit from "p-limit";
import { query, transaction, closePool } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";

const { values } = parseArgs({
  options: {
    limit: { type: "string" },
    concurrency: { type: "string", default: "6" },
  },
  allowPositionals: true,
});

interface UnknownWork {
  id: number;
  olWorkKey: string;
}

interface EditionEntry {
  key?: string;
  title?: string;
  publishers?: string[];
  isbn_10?: string[];
  isbn_13?: string[];
  [k: string]: unknown;
}

async function main() {
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const concurrency = parseInt(values.concurrency ?? "6", 10);
  const limiter = pLimit(concurrency);

  const timer = createTimer("Fetch OL ISBNs");
  const unknowns = await getUnknownWorks(limit);

  if (unknowns.length === 0) {
    logger.info("No unknown Open Library works found");
    await closePool();
    return;
  }

  logger.info("Fetching ISBNs for unknown OL works", {
    count: unknowns.length,
    concurrency,
  });

  let updated = 0;
  let withIsbn = 0;
  let failures = 0;

  await Promise.all(
    unknowns.map((work) =>
      limiter(async () => {
        try {
          const edition = await fetchEditionWithIsbn(work.olWorkKey);
          if (!edition) return;

          withIsbn++;
          const isbn13 = edition.isbn_13?.[0] ?? null;
          const isbn10 = edition.isbn_10?.[0] ?? null;
          const publisher = edition.publishers?.[0] ?? null;
          const olEditionKey = edition.key?.split("/").pop() ?? null;

          if (!olEditionKey) return;

          const editionId = await upsertEdition({
            workId: work.id,
            olEditionKey,
            isbn10,
            isbn13,
            publisher,
            olData: edition,
          });

          if (isbn13) {
            await upsertEditionIsbn(editionId, isbn13, "isbn13");
          }
          if (isbn10) {
            await upsertEditionIsbn(editionId, isbn10, "isbn10");
          }

          updated++;
        } catch (error) {
          failures++;
          logger.warn("Failed to fetch/update ISBN", {
            workId: work.id,
            olWorkKey: work.olWorkKey,
            error: String(error),
          });
        }
      })
    )
  );

  timer.end({ processed: unknowns.length, withIsbn, updated, failures });
  logger.info("Finished fetching OL ISBNs", {
    processed: unknowns.length,
    withIsbn,
    updated,
    failures,
  });

  await closePool();
}

async function getUnknownWorks(limit?: number): Promise<UnknownWork[]> {
  const { rows } = await query<UnknownWork>(
    `
    SELECT id, ol_work_key AS "olWorkKey"
    FROM "Work"
    WHERE title ILIKE 'unknown%'
      AND ol_work_key IS NOT NULL
    ORDER BY id
    ${limit ? "LIMIT " + limit : ""}
    `
  );
  return rows;
}

async function fetchEditionWithIsbn(olWorkKey: string): Promise<EditionEntry | null> {
  const url = `https://openlibrary.org/works/${olWorkKey}/editions.json?limit=50`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open Library request failed (${res.status})`);
  }
  const data = (await res.json()) as { entries?: EditionEntry[]; editions?: EditionEntry[] };
  const editions = data.entries ?? data.editions ?? [];

  for (const ed of editions) {
    const hasIsbn13 = Array.isArray(ed.isbn_13) && ed.isbn_13.length > 0;
    const hasIsbn10 = Array.isArray(ed.isbn_10) && ed.isbn_10.length > 0;
    if (hasIsbn13 || hasIsbn10) {
      return ed;
    }
  }
  return null;
}

async function upsertEdition(params: {
  workId: number;
  olEditionKey: string;
  isbn10: string | null;
  isbn13: string | null;
  publisher: string | null;
  olData: unknown;
}): Promise<number> {
  const { workId, olEditionKey, isbn10, isbn13, publisher, olData } = params;

  // If an edition already exists with this ISBN, reuse it to avoid unique conflicts
  if (isbn13) {
    const { rows } = await query<{ id: number; work_id: number | null; ol_edition_key: string | null }>(
      `SELECT id, work_id, ol_edition_key FROM "Edition" WHERE isbn13 = $1 LIMIT 1`,
      [isbn13]
    );
    if (rows[0]) {
      const existingId = rows[0].id;
      await transaction(async (client) => {
        await client.query(
          `
          UPDATE "Edition"
          SET work_id = COALESCE(work_id, $1),
              ol_edition_key = COALESCE(ol_edition_key, $2),
              publisher = COALESCE(publisher, $3),
              ol_data = COALESCE(ol_data, $4)
          WHERE id = $5
          `,
          [workId, olEditionKey, publisher, JSON.stringify(olData), existingId]
        );
      });
      return existingId;
    }
  }

  if (isbn10) {
    const { rows } = await query<{ id: number; work_id: number | null; ol_edition_key: string | null }>(
      `SELECT id, work_id, ol_edition_key FROM "Edition" WHERE isbn10 = $1 LIMIT 1`,
      [isbn10]
    );
    if (rows[0]) {
      const existingId = rows[0].id;
      await transaction(async (client) => {
        await client.query(
          `
          UPDATE "Edition"
          SET work_id = COALESCE(work_id, $1),
              ol_edition_key = COALESCE(ol_edition_key, $2),
              publisher = COALESCE(publisher, $3),
              ol_data = COALESCE(ol_data, $4)
          WHERE id = $5
          `,
          [workId, olEditionKey, publisher, JSON.stringify(olData), existingId]
        );
      });
      return existingId;
    }
  }

  const { rows } = await transaction(async (client) => {
    return client.query<{ id: number }>(
      `
      INSERT INTO "Edition" (work_id, ol_edition_key, isbn10, isbn13, publisher, ol_data)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (ol_edition_key) DO UPDATE SET
        work_id = COALESCE("Edition".work_id, EXCLUDED.work_id),
        isbn10 = COALESCE(EXCLUDED.isbn10, "Edition".isbn10),
        isbn13 = COALESCE(EXCLUDED.isbn13, "Edition".isbn13),
        publisher = COALESCE(EXCLUDED.publisher, "Edition".publisher),
        ol_data = COALESCE(EXCLUDED.ol_data, "Edition".ol_data)
      RETURNING id
      `,
      [workId, olEditionKey, isbn10, isbn13, publisher, JSON.stringify(olData)]
    );
  });

  return rows[0]!.id;
}

async function upsertEditionIsbn(
  editionId: number,
  isbn: string,
  isbnType: "isbn10" | "isbn13"
): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `
      INSERT INTO "EditionISBN" (edition_id, isbn, isbn_type)
      VALUES ($1, $2, $3)
      ON CONFLICT (edition_id, isbn) DO NOTHING
      `,
      [editionId, isbn, isbnType]
    );
  });
}

main().catch((error) => {
  logger.error("Fetch OL ISBNs failed", { error: String(error) });
  process.exit(1);
});
