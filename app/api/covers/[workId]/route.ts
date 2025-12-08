import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { query } from "@/lib/db/pool";
import { unstable_cache } from "next/cache";

interface OpenLibraryEdition {
  covers?: number[];
  isbn_13?: string[];
  isbn_10?: string[];
  key: string;
}

interface OpenLibraryEditionsResponse {
  entries?: OpenLibraryEdition[];
}

/**
 * Fetch cover URL for a work, checking local DB first then Open Library API
 */
async function fetchCoverForWork(workId: number): Promise<string | null> {
  // First check local database
  const { rows } = await query<{
    cover_id: string | null;
    isbn13: string | null;
    cover_url: string | null;
    ol_work_key: string | null;
  }>(
    `SELECT e.cover_id, e.isbn13, e.cover_url, w.ol_work_key
     FROM "Work" w
     LEFT JOIN "Edition" e ON w.id = e.work_id
     WHERE w.id = $1
     ORDER BY e.cover_id NULLS LAST
     LIMIT 1`,
    [workId]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  // If we have local cover data, use it
  if (row.cover_url) {
    return row.cover_url;
  }
  if (row.cover_id) {
    return `https://covers.openlibrary.org/b/id/${row.cover_id}-L.jpg`;
  }
  if (row.isbn13) {
    return `https://covers.openlibrary.org/b/isbn/${row.isbn13}-L.jpg`;
  }

  // No local cover data - try Open Library API
  if (!row.ol_work_key) {
    return null;
  }

  try {
    const response = await fetch(
      `https://openlibrary.org/works/${row.ol_work_key}/editions.json?limit=5`,
      { next: { revalidate: 86400 } } // Cache for 24 hours
    );

    if (!response.ok) {
      return null;
    }

    const data: OpenLibraryEditionsResponse = await response.json();
    const editions = data.entries ?? [];

    // Find first edition with a cover
    for (const edition of editions) {
      if (edition.covers && edition.covers.length > 0) {
        const coverId = edition.covers[0];
        if (coverId > 0) {
          // Save to database for future requests
          await saveCoverToDb(workId, coverId, edition);
          return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
        }
      }
    }

    // Try ISBN-based cover as fallback
    for (const edition of editions) {
      if (edition.isbn_13 && edition.isbn_13.length > 0) {
        return `https://covers.openlibrary.org/b/isbn/${edition.isbn_13[0]}-L.jpg`;
      }
      if (edition.isbn_10 && edition.isbn_10.length > 0) {
        return `https://covers.openlibrary.org/b/isbn/${edition.isbn_10[0]}-L.jpg`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Save discovered cover to database for future use
 */
async function saveCoverToDb(
  workId: number,
  coverId: number,
  edition: OpenLibraryEdition
): Promise<void> {
  try {
    const olEditionKey = edition.key?.replace("/books/", "") ?? null;
    const isbn13 = edition.isbn_13?.[0] ?? null;
    const isbn10 = edition.isbn_10?.[0] ?? null;

    // Use ol_edition_key for conflict resolution since Edition table
    // has UNIQUE constraint on ol_edition_key, not work_id
    // A work can have multiple editions, so we insert a new one if needed
    await query(
      `INSERT INTO "Edition" (work_id, ol_edition_key, cover_id, isbn13, isbn10)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ol_edition_key) DO UPDATE SET
         cover_id = COALESCE(EXCLUDED.cover_id, "Edition".cover_id),
         isbn13 = COALESCE(EXCLUDED.isbn13, "Edition".isbn13),
         isbn10 = COALESCE(EXCLUDED.isbn10, "Edition".isbn10)`,
      [workId, olEditionKey, String(coverId), isbn13, isbn10]
    );
  } catch (error) {
    // Log error for debugging but don't fail the request
    console.warn("Failed to save cover to database:", {
      workId,
      coverId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Cache the cover lookup for 1 hour
const getCachedCover = unstable_cache(
  async (workId: number) => fetchCoverForWork(workId),
  ["cover-lookup"],
  { revalidate: 3600 }
);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workId: string }> }
) {
  const { workId: workIdStr } = await params;
  const workId = parseInt(workIdStr, 10);

  if (isNaN(workId)) {
    return NextResponse.json({ error: "Invalid work ID" }, { status: 400 });
  }

  const coverUrl = await getCachedCover(workId);

  if (!coverUrl) {
    return NextResponse.json({ coverUrl: null }, { status: 404 });
  }

  return NextResponse.json({ coverUrl });
}
