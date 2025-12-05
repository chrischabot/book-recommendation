/**
 * Resolution path implementations for Resolver V2
 * Each path handles a different identifier type with appropriate confidence scoring
 */

import { query } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";
import { normalizeIsbn, isbn10ToIsbn13, stringSimilarity } from "@/lib/util/text";
import { searchGoogleBooks, fetchGoogleBooksById } from "@/lib/ingest/googlebooks";
import { upsertWorkAndEdition, findExistingWork, extractYear } from "./upsert";
import type {
  ResolveInput,
  ResolveResult,
  ResolutionPath,
  WorkSource,
  CONFIDENCE,
} from "./types";
import { CONFIDENCE as ConfidenceScores, STUB_THRESHOLD } from "./types";

/**
 * Resolve by ISBN - highest priority path
 * Tries local DB (Open Library data) first, then Google Books for enrichment
 */
export async function resolveByIsbn(input: ResolveInput): Promise<ResolveResult> {
  const isbn = input.isbn13 || input.isbn10;
  if (!isbn) {
    throw new Error("resolveByIsbn requires isbn13 or isbn10");
  }

  // Normalize ISBN
  const normalized = normalizeIsbn(isbn);
  const isbn13 = normalized.isbn13 ?? (normalized.isbn10 ? isbn10ToIsbn13(normalized.isbn10) : null);
  const isbn10 = normalized.isbn10 ?? null;

  // Check if we already have this in local DB (from Open Library ingestion)
  const { rows: localMatch } = await query<{
    work_id: number;
    edition_id: number;
    source: string | null;
  }>(
    `SELECT e.work_id, e.id as edition_id, w.source
     FROM "Edition" e
     JOIN "Work" w ON w.id = e.work_id
     WHERE e.isbn13 = $1 OR e.isbn10 = $2
     LIMIT 1`,
    [isbn13, isbn10]
  );

  if (localMatch[0]) {
    return {
      workId: localMatch[0].work_id,
      editionId: localMatch[0].edition_id,
      confidence: ConfidenceScores.isbn_ol,
      created: false,
      path: "isbn_ol",
      source: (localMatch[0].source as WorkSource) || "openlibrary",
    };
  }

  // Not in local DB - try Google Books for enrichment
  const gbResult = await searchGoogleBooks({ isbn: isbn13 || isbn10 || undefined });

  if (gbResult) {
    // Create Work + Edition with Google Books data
    const enrichedInput: ResolveInput = {
      ...input,
      isbn13: gbResult.isbn13 || input.isbn13,
      isbn10: gbResult.isbn10 || input.isbn10,
      googleVolumeId: gbResult.volumeId,
      title: gbResult.title || input.title,
      author: gbResult.authors.join(", ") || input.author,
      description: gbResult.description || input.description,
      coverUrl: gbResult.coverUrl || input.coverUrl,
      categories: gbResult.categories.length > 0 ? gbResult.categories : input.categories,
      publishedDate: gbResult.publishedDate || input.publishedDate,
      pageCount: gbResult.pageCount || input.pageCount,
      averageRating: gbResult.averageRating || input.averageRating,
      ratingsCount: gbResult.ratingsCount || input.ratingsCount,
    };

    const upsertResult = await upsertWorkAndEdition(enrichedInput, {
      confidence: ConfidenceScores.isbn_gb,
      path: "isbn_gb",
      source: "googlebooks",
    });

    return {
      workId: upsertResult.workId,
      editionId: upsertResult.editionId,
      confidence: ConfidenceScores.isbn_gb,
      created: upsertResult.created,
      path: "isbn_gb",
      source: "googlebooks",
    };
  }

  // No Google Books match - create local ISBN-only entry
  const upsertResult = await upsertWorkAndEdition(
    {
      ...input,
      isbn13: isbn13 || undefined,
      isbn10: isbn10 || undefined,
    },
    {
      confidence: ConfidenceScores.isbn_local,
      path: "isbn_local",
      source: "manual",
    }
  );

  return {
    workId: upsertResult.workId,
    editionId: upsertResult.editionId,
    confidence: ConfidenceScores.isbn_local,
    created: upsertResult.created,
    path: "isbn_local",
    source: "manual",
  };
}

/**
 * Resolve by Google Books Volume ID
 */
export async function resolveByGoogleVolumeId(input: ResolveInput): Promise<ResolveResult> {
  if (!input.googleVolumeId) {
    throw new Error("resolveByGoogleVolumeId requires googleVolumeId");
  }

  // Check if we already have this volume ID
  const { rows: existing } = await query<{ work_id: number; edition_id: number }>(
    `SELECT e.work_id, e.id as edition_id
     FROM "Edition" e
     WHERE e.google_volume_id = $1
     LIMIT 1`,
    [input.googleVolumeId]
  );

  if (existing[0]) {
    return {
      workId: existing[0].work_id,
      editionId: existing[0].edition_id,
      confidence: ConfidenceScores.gbid,
      created: false,
      path: "gbid",
      source: "googlebooks",
    };
  }

  // Fetch volume details from Google Books
  const gbResult = await fetchGoogleBooksById(input.googleVolumeId);

  if (gbResult) {
    const enrichedInput: ResolveInput = {
      ...input,
      isbn13: gbResult.isbn13 || input.isbn13,
      isbn10: gbResult.isbn10 || input.isbn10,
      googleVolumeId: gbResult.volumeId,
      title: gbResult.title || input.title,
      author: gbResult.authors.join(", ") || input.author,
      description: gbResult.description || input.description,
      coverUrl: gbResult.coverUrl || input.coverUrl,
      categories: gbResult.categories.length > 0 ? gbResult.categories : input.categories,
      publishedDate: gbResult.publishedDate || input.publishedDate,
      pageCount: gbResult.pageCount || input.pageCount,
      averageRating: gbResult.averageRating || input.averageRating,
      ratingsCount: gbResult.ratingsCount || input.ratingsCount,
    };

    const upsertResult = await upsertWorkAndEdition(enrichedInput, {
      confidence: ConfidenceScores.gbid,
      path: "gbid",
      source: "googlebooks",
    });

    return {
      workId: upsertResult.workId,
      editionId: upsertResult.editionId,
      confidence: ConfidenceScores.gbid,
      created: upsertResult.created,
      path: "gbid",
      source: "googlebooks",
    };
  }

  // Google Books API failed, create with volume ID only
  const upsertResult = await upsertWorkAndEdition(input, {
    confidence: ConfidenceScores.manual,
    path: "gbid",
    source: "googlebooks",
  });

  return {
    workId: upsertResult.workId,
    editionId: upsertResult.editionId,
    confidence: ConfidenceScores.manual,
    created: upsertResult.created,
    path: "gbid",
    source: "googlebooks",
  };
}

/**
 * Resolve by title and author using Google Books search
 */
export async function resolveByTitleAuthor(input: ResolveInput): Promise<ResolveResult> {
  if (!input.title) {
    throw new Error("resolveByTitleAuthor requires title");
  }

  // First check local DB for exact/fuzzy match
  const localMatch = await findLocalTitleMatch(input.title, input.author);

  if (localMatch && localMatch.confidence >= 0.85) {
    return {
      workId: localMatch.workId,
      editionId: localMatch.editionId,
      confidence: localMatch.confidence,
      created: false,
      path: "title_gb", // Using same path since it's title-based resolution
      source: "openlibrary",
    };
  }

  // Try Google Books search
  const gbResult = await searchGoogleBooks({
    title: input.title,
    author: input.author,
  });

  if (gbResult) {
    // Verify title similarity
    const titleSim = stringSimilarity(
      input.title.toLowerCase(),
      gbResult.title.toLowerCase()
    );

    if (titleSim >= 0.6) {
      const enrichedInput: ResolveInput = {
        ...input,
        isbn13: gbResult.isbn13 || input.isbn13,
        isbn10: gbResult.isbn10 || input.isbn10,
        googleVolumeId: gbResult.volumeId,
        title: input.title, // Keep original title
        author: input.author || gbResult.authors.join(", "),
        description: gbResult.description || input.description,
        coverUrl: gbResult.coverUrl || input.coverUrl,
        categories: gbResult.categories.length > 0 ? gbResult.categories : input.categories,
        publishedDate: gbResult.publishedDate || input.publishedDate,
        pageCount: gbResult.pageCount || input.pageCount,
        averageRating: gbResult.averageRating || input.averageRating,
        ratingsCount: gbResult.ratingsCount || input.ratingsCount,
      };

      const upsertResult = await upsertWorkAndEdition(enrichedInput, {
        confidence: ConfidenceScores.title_gb,
        path: "title_gb",
        source: "googlebooks",
      });

      return {
        workId: upsertResult.workId,
        editionId: upsertResult.editionId,
        confidence: ConfidenceScores.title_gb,
        created: upsertResult.created,
        path: "title_gb",
        source: "googlebooks",
      };
    }
  }

  // Lower confidence local match is better than nothing
  if (localMatch && localMatch.confidence >= 0.7) {
    return {
      workId: localMatch.workId,
      editionId: localMatch.editionId,
      confidence: localMatch.confidence,
      created: false,
      path: "title_gb",
      source: "openlibrary",
    };
  }

  // Fall through to manual stub creation
  return await createManualStub(input);
}

/**
 * Find title match in local database
 *
 * NOTE: Fuzzy/trigram matching is disabled until we add a GIN trigram index
 * on Work.title. Without the index, similarity queries do full table scans
 * on 18M+ rows, taking 6-72 seconds per lookup.
 */
async function findLocalTitleMatch(
  title: string,
  author?: string
): Promise<{ workId: number; editionId: number; confidence: number } | null> {
  const normalizedTitle = title.toLowerCase().trim();

  // Try exact title match only (fuzzy matching disabled - see note above)
  const { rows } = await query<{
    work_id: number;
    edition_id: number;
    title: string;
    author_name: string | null;
  }>(
    `SELECT w.id as work_id, e.id as edition_id, w.title, a.name as author_name
     FROM "Work" w
     LEFT JOIN "Edition" e ON e.work_id = w.id
     LEFT JOIN "WorkAuthor" wa ON wa.work_id = w.id
     LEFT JOIN "Author" a ON a.id = wa.author_id
     WHERE LOWER(w.title) = $1
     LIMIT 10`,
    [normalizedTitle]
  );

  // TODO: Re-enable fuzzy matching after adding GIN trigram index:
  // CREATE INDEX CONCURRENTLY work_title_trgm_idx ON "Work" USING gin (LOWER(title) gin_trgm_ops);

  if (rows.length === 0) return null;

  // Exact title match found
  if (rows.length === 1) {
    return {
      workId: rows[0].work_id,
      editionId: rows[0].edition_id,
      confidence: 0.9,
    };
  }

  // Multiple matches - verify by author
  if (author) {
    const normalizedAuthor = author.toLowerCase().trim();
    for (const row of rows) {
      if (row.author_name) {
        const authorSim = stringSimilarity(normalizedAuthor, row.author_name.toLowerCase());
        if (authorSim >= 0.7) {
          return {
            workId: row.work_id,
            editionId: row.edition_id,
            confidence: 0.95,
          };
        }
      }
    }
  }

  // Return first match with moderate confidence
  return {
    workId: rows[0].work_id,
    editionId: rows[0].edition_id,
    confidence: 0.75,
  };
}

/**
 * Resolve by ASIN (Kindle books)
 */
export async function resolveByAsin(input: ResolveInput): Promise<ResolveResult> {
  if (!input.asin) {
    throw new Error("resolveByAsin requires asin");
  }

  // Check if we already have this ASIN
  const { rows: existing } = await query<{ work_id: number; edition_id: number }>(
    `SELECT e.work_id, e.id as edition_id
     FROM "Edition" e
     WHERE e.asin = $1
     LIMIT 1`,
    [input.asin.toUpperCase()]
  );

  if (existing[0]) {
    return {
      workId: existing[0].work_id,
      editionId: existing[0].edition_id,
      confidence: ConfidenceScores.asin,
      created: false,
      path: "asin",
      source: "amazon",
    };
  }

  // If we have title+author, try to enrich via Google Books
  if (input.title && input.author) {
    const gbResult = await searchGoogleBooks({
      title: input.title,
      author: input.author,
    });

    if (gbResult) {
      const titleSim = stringSimilarity(
        input.title.toLowerCase(),
        gbResult.title.toLowerCase()
      );

      if (titleSim >= 0.6) {
        const enrichedInput: ResolveInput = {
          ...input,
          asin: input.asin.toUpperCase(),
          isbn13: gbResult.isbn13 || input.isbn13,
          isbn10: gbResult.isbn10 || input.isbn10,
          googleVolumeId: gbResult.volumeId,
          description: gbResult.description || input.description,
          coverUrl: gbResult.coverUrl || input.coverUrl,
          categories: gbResult.categories.length > 0 ? gbResult.categories : input.categories,
          publishedDate: gbResult.publishedDate || input.publishedDate,
          pageCount: gbResult.pageCount || input.pageCount,
          averageRating: gbResult.averageRating || input.averageRating,
          ratingsCount: gbResult.ratingsCount || input.ratingsCount,
        };

        const upsertResult = await upsertWorkAndEdition(enrichedInput, {
          confidence: ConfidenceScores.asin,
          path: "asin",
          source: "amazon",
        });

        return {
          workId: upsertResult.workId,
          editionId: upsertResult.editionId,
          confidence: ConfidenceScores.asin,
          created: upsertResult.created,
          path: "asin",
          source: "amazon",
        };
      }
    }
  }

  // Create ASIN-only entry
  const upsertResult = await upsertWorkAndEdition(
    { ...input, asin: input.asin.toUpperCase() },
    {
      confidence: ConfidenceScores.asin,
      path: "asin",
      source: "amazon",
    }
  );

  return {
    workId: upsertResult.workId,
    editionId: upsertResult.editionId,
    confidence: ConfidenceScores.asin,
    created: upsertResult.created,
    path: "asin",
    source: "amazon",
  };
}

/**
 * Resolve by Royal Road fiction ID
 */
export async function resolveByRoyalRoad(input: ResolveInput): Promise<ResolveResult> {
  if (!input.royalRoadId) {
    throw new Error("resolveByRoyalRoad requires royalRoadId");
  }

  const rrId = parseInt(input.royalRoadId, 10);

  // Check if we already have this Royal Road ID
  const { rows: existing } = await query<{ work_id: number; edition_id: number }>(
    `SELECT e.work_id, e.id as edition_id
     FROM "Edition" e
     WHERE e.royalroad_fiction_id = $1
     LIMIT 1`,
    [rrId]
  );

  if (existing[0]) {
    return {
      workId: existing[0].work_id,
      editionId: existing[0].edition_id,
      confidence: ConfidenceScores.royalroad,
      created: false,
      path: "royalroad",
      source: "royalroad",
    };
  }

  // If we have title+author, try to find via Google Books
  if (input.title && input.author) {
    const gbResult = await searchGoogleBooks({
      title: input.title,
      author: input.author,
    });

    if (gbResult) {
      const titleSim = stringSimilarity(
        input.title.toLowerCase(),
        gbResult.title.toLowerCase()
      );

      if (titleSim >= 0.6) {
        const enrichedInput: ResolveInput = {
          ...input,
          royalRoadId: input.royalRoadId,
          isbn13: gbResult.isbn13 || input.isbn13,
          isbn10: gbResult.isbn10 || input.isbn10,
          googleVolumeId: gbResult.volumeId,
          description: gbResult.description || input.description,
          coverUrl: gbResult.coverUrl || input.coverUrl,
          categories: gbResult.categories.length > 0 ? gbResult.categories : input.categories,
          publishedDate: gbResult.publishedDate || input.publishedDate,
          pageCount: gbResult.pageCount || input.pageCount,
          averageRating: gbResult.averageRating || input.averageRating,
          ratingsCount: gbResult.ratingsCount || input.ratingsCount,
        };

        const upsertResult = await upsertWorkAndEdition(enrichedInput, {
          confidence: ConfidenceScores.royalroad,
          path: "royalroad",
          source: "royalroad",
        });

        return {
          workId: upsertResult.workId,
          editionId: upsertResult.editionId,
          confidence: ConfidenceScores.royalroad,
          created: upsertResult.created,
          path: "royalroad",
          source: "royalroad",
        };
      }
    }
  }

  // Create Royal Road entry
  const upsertResult = await upsertWorkAndEdition(input, {
    confidence: ConfidenceScores.royalroad,
    path: "royalroad",
    source: "royalroad",
  });

  return {
    workId: upsertResult.workId,
    editionId: upsertResult.editionId,
    confidence: ConfidenceScores.royalroad,
    created: upsertResult.created,
    path: "royalroad",
    source: "royalroad",
  };
}

/**
 * Resolve by Goodreads book ID
 * Note: We can't fetch data from Goodreads API, only store the ID
 */
export async function resolveByGoodreadsId(input: ResolveInput): Promise<ResolveResult> {
  if (!input.goodreadsId) {
    throw new Error("resolveByGoodreadsId requires goodreadsId");
  }

  const grId = parseInt(input.goodreadsId, 10);

  // Check if we already have this Goodreads ID
  const { rows: existing } = await query<{ work_id: number; edition_id: number }>(
    `SELECT e.work_id, e.id as edition_id
     FROM "Edition" e
     WHERE e.goodreads_book_id = $1
     LIMIT 1`,
    [grId]
  );

  if (existing[0]) {
    return {
      workId: existing[0].work_id,
      editionId: existing[0].edition_id,
      confidence: ConfidenceScores.goodreads,
      created: false,
      path: "goodreads",
      source: "goodreads",
    };
  }

  // If we have title+author, try to enrich via Google Books
  if (input.title && input.author) {
    const gbResult = await searchGoogleBooks({
      title: input.title,
      author: input.author,
    });

    if (gbResult) {
      const titleSim = stringSimilarity(
        input.title.toLowerCase(),
        gbResult.title.toLowerCase()
      );

      if (titleSim >= 0.6) {
        const enrichedInput: ResolveInput = {
          ...input,
          goodreadsId: input.goodreadsId,
          isbn13: gbResult.isbn13 || input.isbn13,
          isbn10: gbResult.isbn10 || input.isbn10,
          googleVolumeId: gbResult.volumeId,
          description: gbResult.description || input.description,
          coverUrl: gbResult.coverUrl || input.coverUrl,
          categories: gbResult.categories.length > 0 ? gbResult.categories : input.categories,
          publishedDate: gbResult.publishedDate || input.publishedDate,
          pageCount: gbResult.pageCount || input.pageCount,
          averageRating: gbResult.averageRating || input.averageRating,
          ratingsCount: gbResult.ratingsCount || input.ratingsCount,
        };

        const upsertResult = await upsertWorkAndEdition(enrichedInput, {
          confidence: ConfidenceScores.goodreads,
          path: "goodreads",
          source: "goodreads",
        });

        return {
          workId: upsertResult.workId,
          editionId: upsertResult.editionId,
          confidence: ConfidenceScores.goodreads,
          created: upsertResult.created,
          path: "goodreads",
          source: "goodreads",
        };
      }
    }
  }

  // Create Goodreads ID-only entry
  const upsertResult = await upsertWorkAndEdition(input, {
    confidence: ConfidenceScores.goodreads,
    path: "goodreads",
    source: "goodreads",
  });

  return {
    workId: upsertResult.workId,
    editionId: upsertResult.editionId,
    confidence: ConfidenceScores.goodreads,
    created: upsertResult.created,
    path: "goodreads",
    source: "goodreads",
  };
}

/**
 * Create a manual stub when no other resolution is possible
 * Lowest confidence - marked as stub for future enrichment
 */
export async function createManualStub(input: ResolveInput): Promise<ResolveResult> {
  if (!input.title) {
    throw new Error("createManualStub requires at least a title");
  }

  logger.debug("Creating manual stub", { title: input.title, author: input.author });

  const upsertResult = await upsertWorkAndEdition(input, {
    confidence: ConfidenceScores.manual,
    path: "manual",
    source: "manual",
  });

  return {
    workId: upsertResult.workId,
    editionId: upsertResult.editionId,
    confidence: ConfidenceScores.manual,
    created: upsertResult.created,
    path: "manual",
    source: "manual",
  };
}
