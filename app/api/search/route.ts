import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { query } from "@/lib/db/pool";
import { getCoverUrl } from "@/lib/util/covers";

export const dynamic = "force-dynamic";

interface SearchResult {
  workId: number;
  title: string;
  authors: string[];
  year: number | null;
  description: string | null;
  coverUrl: string | null;
  avgRating: number | null;
  ratingCount: number | null;
  source: string | null;
  matchType: "title" | "author";
}

interface SearchResponse {
  results: SearchResult[];
  query: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const q = searchParams.get("q")?.trim() ?? "";
  const page = parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Math.min(parseInt(searchParams.get("page_size") ?? "20", 10), 50);

  if (!q || q.length < 2) {
    return NextResponse.json({
      results: [],
      query: q,
      page: 1,
      pageSize,
      total: 0,
      totalPages: 0,
    } satisfies SearchResponse);
  }

  const offset = (page - 1) * pageSize;

  try {
    // Search by title using trigram similarity (fuzzy) and ILIKE (exact substring)
    // Also search by author name
    const { rows: countRows } = await query<{ count: string }>(`
      SELECT COUNT(DISTINCT w.id) as count
      FROM "Work" w
      LEFT JOIN work_authors_agg waa ON w.id = waa.work_id
      WHERE
        w.title ILIKE '%' || $1 || '%'
        OR w.title % $1
        OR waa.author_names ILIKE '%' || $1 || '%'
    `, [q]);

    const total = parseInt(countRows[0]?.count ?? "0", 10);
    const totalPages = Math.ceil(total / pageSize);

    if (total === 0) {
      return NextResponse.json({
        results: [],
        query: q,
        page,
        pageSize,
        total: 0,
        totalPages: 0,
      } satisfies SearchResponse);
    }

    // Get paginated results sorted by relevance
    const { rows } = await query<{
      work_id: number;
      title: string;
      authors: string | null;
      first_publish_year: number | null;
      description: string | null;
      cover_id: string | null;
      cover_url: string | null;
      isbn13: string | null;
      ol_work_key: string | null;
      avg_rating: string | null;
      rating_count: number | null;
      source: string | null;
      title_match: boolean;
      author_match: boolean;
      similarity: number;
    }>(`
      WITH search_results AS (
        SELECT DISTINCT ON (w.id)
          w.id as work_id,
          w.title,
          COALESCE(waa.author_names, '') as authors,
          w.first_publish_year,
          w.description,
          e.cover_id,
          e.cover_url,
          e.isbn13,
          w.ol_work_key,
          wq.blended_avg as avg_rating,
          wq.total_ratings as rating_count,
          w.source,
          (w.title ILIKE '%' || $1 || '%' OR w.title % $1) as title_match,
          (waa.author_names ILIKE '%' || $1 || '%') as author_match,
          GREATEST(
            similarity(w.title, $1),
            CASE WHEN w.title ILIKE $1 || '%' THEN 0.9 ELSE 0 END,
            CASE WHEN w.title ILIKE '%' || $1 || '%' THEN 0.7 ELSE 0 END
          ) as similarity
        FROM "Work" w
        LEFT JOIN work_authors_agg waa ON w.id = waa.work_id
        LEFT JOIN "WorkQuality" wq ON w.id = wq.work_id
        LEFT JOIN "Edition" e ON w.id = e.work_id
        WHERE
          w.title ILIKE '%' || $1 || '%'
          OR w.title % $1
          OR waa.author_names ILIKE '%' || $1 || '%'
        ORDER BY w.id, e.cover_url NULLS LAST, e.cover_id NULLS LAST
      )
      SELECT *
      FROM search_results
      ORDER BY
        similarity DESC,
        title_match DESC,
        rating_count DESC NULLS LAST,
        avg_rating DESC NULLS LAST
      LIMIT $2 OFFSET $3
    `, [q, pageSize, offset]);

    const results: SearchResult[] = rows.map((row) => {
      const coverUrl = row.cover_url ?? getCoverUrl({
        coverId: row.cover_id,
        isbn13: row.isbn13,
        olWorkKey: row.ol_work_key,
      });

      return {
        workId: row.work_id,
        title: row.title,
        authors: row.authors?.split(", ").filter(Boolean) ?? [],
        year: row.first_publish_year,
        description: row.description,
        coverUrl,
        avgRating: row.avg_rating ? parseFloat(row.avg_rating) : null,
        ratingCount: row.rating_count,
        source: row.source,
        matchType: row.title_match ? "title" : "author",
      };
    });

    return NextResponse.json({
      results,
      query: q,
      page,
      pageSize,
      total,
      totalPages,
    } satisfies SearchResponse);
  } catch (error) {
    console.error("Search error:", error);
    return NextResponse.json(
      { error: "Search failed", details: String(error) },
      { status: 500 }
    );
  }
}
