import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { query } from "@/lib/db/pool";
import { getCoverUrl } from "@/lib/util/covers";
import { logger } from "@/lib/util/logger";
import { isDevelopment } from "@/lib/config/env";

type WorkSource = "openlibrary" | "googlebooks" | "amazon" | "royalroad" | "goodreads" | "manual";
type SuggestionQuality = "A+" | "A" | "A-" | "B+" | "B" | "B-";

const validSources: WorkSource[] = ["openlibrary", "googlebooks", "amazon", "royalroad", "goodreads", "manual"];

/**
 * Calculate suggestion quality based on rating and count
 */
function calculateQuality(avgRating: number | null, ratingCount: number | null): { quality: SuggestionQuality; confidence: number } {
  if (avgRating === null || ratingCount === null || ratingCount < 5) {
    return { quality: "B-", confidence: 0.5 };
  }

  const confidence = Math.min(0.95, 0.6 + Math.log10(ratingCount) * 0.1);

  let quality: SuggestionQuality;
  if (avgRating >= 4.5 && ratingCount >= 100) {
    quality = "A+";
  } else if (avgRating >= 4.2) {
    quality = "A";
  } else if (avgRating >= 4.0) {
    quality = "A-";
  } else if (avgRating >= 3.7) {
    quality = "B+";
  } else if (avgRating >= 3.4) {
    quality = "B";
  } else {
    quality = "B-";
  }

  return { quality, confidence };
}

/**
 * Parse and validate a positive integer parameter
 */
function parsePositiveInt(
  value: string | null,
  defaultValue: number,
  max?: number
): number | null {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1) return null;
  return max ? Math.min(parsed, max) : parsed;
}

interface AuthorDetails {
  id: number;
  name: string;
  bio: string | null;
  olAuthorKey: string | null;
  bookCount: number;
}

async function getAuthorDetails(authorId: number): Promise<AuthorDetails | null> {
  const { rows } = await query<{
    id: number;
    name: string;
    bio: string | null;
    ol_author_key: string | null;
    book_count: string;
  }>(
    `SELECT
       a.id,
       a.name,
       a.bio,
       a.ol_author_key,
       COUNT(DISTINCT wa.work_id) as book_count
     FROM "Author" a
     LEFT JOIN "WorkAuthor" wa ON a.id = wa.author_id
     WHERE a.id = $1
     GROUP BY a.id`,
    [authorId]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    bio: row.bio,
    olAuthorKey: row.ol_author_key,
    bookCount: parseInt(row.book_count, 10),
  };
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const authorIdStr = searchParams.get("author_id");

    if (!authorIdStr) {
      return NextResponse.json(
        { error: "author_id parameter is required" },
        { status: 400 }
      );
    }

    const authorId = parseInt(authorIdStr, 10);
    if (isNaN(authorId)) {
      return NextResponse.json(
        { error: "author_id must be a valid integer" },
        { status: 400 }
      );
    }

    const page = parsePositiveInt(searchParams.get("page"), 1);
    const pageSize = parsePositiveInt(searchParams.get("page_size"), 24, 100);

    if (page === null) {
      return NextResponse.json(
        { error: "page must be a positive integer" },
        { status: 400 }
      );
    }
    if (pageSize === null) {
      return NextResponse.json(
        { error: "page_size must be a positive integer" },
        { status: 400 }
      );
    }

    logger.info("Books by author request", { authorId, page, pageSize });

    // Get author details
    const author = await getAuthorDetails(authorId);
    if (!author) {
      return NextResponse.json(
        { error: "Author not found" },
        { status: 404 }
      );
    }

    // Get total count
    const { rows: countRows } = await query<{ count: string }>(
      `SELECT COUNT(DISTINCT wa.work_id) as count
       FROM "WorkAuthor" wa
       WHERE wa.author_id = $1`,
      [authorId]
    );
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    // Get paginated books sorted by quality
    const offset = (page - 1) * pageSize;
    const { rows } = await query<{
      work_id: number;
      title: string;
      first_publish_year: number | null;
      description: string | null;
      cover_id: string | null;
      isbn13: string | null;
      ol_work_key: string | null;
      avg_rating: string | null;
      rating_count: number | null;
      authors: string;
      source: string | null;
      is_stub: boolean | null;
      stub_reason: string | null;
    }>(
      `WITH author_works AS (
         SELECT DISTINCT ON (w.id)
           w.id as work_id,
           w.title,
           w.first_publish_year,
           w.description,
           e.cover_id,
           e.isbn13,
           w.ol_work_key,
           wq.blended_avg as avg_rating,
           wq.total_ratings as rating_count,
           COALESCE(waa.author_names, '') as authors,
           w.source,
           w.is_stub,
           w.stub_reason
         FROM "WorkAuthor" wa
         JOIN "Work" w ON wa.work_id = w.id
         LEFT JOIN work_authors_agg waa ON w.id = waa.work_id
         LEFT JOIN "WorkQuality" wq ON w.id = wq.work_id
         LEFT JOIN "Edition" e ON w.id = e.work_id
         WHERE wa.author_id = $1
         ORDER BY w.id, e.cover_id NULLS LAST
       )
       SELECT * FROM author_works
       ORDER BY avg_rating DESC NULLS LAST, rating_count DESC NULLS LAST
       LIMIT $2 OFFSET $3`,
      [authorId, pageSize, offset]
    );

    const books = rows.map((row) => {
      const avgRating = row.avg_rating ? parseFloat(row.avg_rating) : null;
      const { quality, confidence } = calculateQuality(avgRating, row.rating_count);

      return {
        workId: row.work_id,
        title: row.title,
        authors: row.authors?.split(", ").filter(Boolean) ?? [],
        year: row.first_publish_year,
        description: row.description ?? undefined,
        coverUrl: getCoverUrl({
          coverId: row.cover_id,
          isbn13: row.isbn13,
          olWorkKey: row.ol_work_key,
        }),
        avgRating,
        ratingCount: row.rating_count,
        relevanceScore: 0,
        qualityScore: avgRating ? avgRating / 5 : 0,
        diversityScore: 0,
        engagementScore: 0,
        finalScore: 0,
        suggestionQuality: quality,
        confidence,
        reasons: [],
        source: row.source && validSources.includes(row.source as WorkSource) ? row.source : undefined,
        isStub: row.is_stub ?? false,
        stubReason: row.stub_reason ?? undefined,
      };
    });

    const totalPages = Math.ceil(total / pageSize);

    return NextResponse.json({
      author,
      books,
      page,
      pageSize,
      total,
      totalPages,
    });
  } catch (error) {
    const errorMessage = String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error("Books by author error", {
      error: errorMessage,
      stack: errorStack,
    });

    const responseBody = isDevelopment()
      ? {
          error: "Failed to fetch books",
          details: errorMessage,
          stack: errorStack,
        }
      : { error: "Failed to fetch books" };

    return NextResponse.json(responseBody, { status: 500 });
  }
}
