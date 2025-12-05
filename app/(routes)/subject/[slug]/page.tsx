import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Tag, Library } from "lucide-react";
import { query } from "@/lib/db/pool";
import { getCoverUrl } from "@/lib/util/covers";
import { BookGridSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BookGrid } from "@/components/book-grid";
import { Pagination, PageInfo } from "@/components/pagination";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

interface SubjectBook {
  workId: number;
  title: string;
  authors: string[];
  year: number | null;
  description: string | null;
  coverUrl: string | null;
  avgRating: number | null;
  ratingCount: number | null;
}

async function getBooksBySubject(
  subject: string,
  page: number,
  pageSize: number
): Promise<{ books: SubjectBook[]; total: number }> {
  // Get total count
  const { rows: countRows } = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT w.id) as count
     FROM "Work" w
     JOIN "WorkSubject" ws ON w.id = ws.work_id
     WHERE ws.subject = $1`,
    [subject]
  );
  const total = parseInt(countRows[0]?.count ?? "0", 10);

  // Get paginated books sorted by quality score
  const offset = (page - 1) * pageSize;
  const { rows } = await query<{
    work_id: number;
    title: string;
    authors: string;
    first_publish_year: number | null;
    description: string | null;
    cover_id: string | null;
    cover_url: string | null;
    isbn13: string | null;
    ol_work_key: string | null;
    avg_rating: string | null;
    rating_count: number | null;
  }>(
    `WITH ranked_works AS (
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
         wq.total_ratings as rating_count
       FROM "Work" w
       JOIN "WorkSubject" ws ON w.id = ws.work_id
       LEFT JOIN work_authors_agg waa ON w.id = waa.work_id
       LEFT JOIN "WorkQuality" wq ON w.id = wq.work_id
       LEFT JOIN "Edition" e ON w.id = e.work_id
       WHERE ws.subject = $1
       ORDER BY w.id, e.cover_url NULLS LAST, e.cover_id NULLS LAST
     )
     SELECT * FROM ranked_works
     ORDER BY avg_rating DESC NULLS LAST, rating_count DESC NULLS LAST
     LIMIT $2 OFFSET $3`,
    [subject, pageSize, offset]
  );

  const books = rows.map((row) => {
    // Use getCoverUrl helper with work key fallback
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
    };
  });

  return { books, total };
}

function formatSubjectName(slug: string): string {
  return decodeURIComponent(slug)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const name = formatSubjectName(slug);

  return {
    title: `${name} Books`,
    description: `Browse books in the ${name} subject`,
  };
}

export default async function SubjectPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await props.params;
  const searchParams = await props.searchParams;
  const page = parseInt(searchParams.page ?? "1", 10);
  const pageSize = 24;
  const subjectName = formatSubjectName(slug);

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="border-b border-border bg-background-warm">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="mb-4 -ml-2"
          >
            <Link href="/recommendations">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back to Recommendations
            </Link>
          </Button>

          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-primary/10 shrink-0">
              <Tag className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="font-display text-3xl md:text-4xl font-bold text-foreground">
                {subjectName}
              </h1>
              <p className="mt-2 text-foreground-muted">
                Browse all books tagged with this subject
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <Suspense fallback={<LoadingState />}>
          <SubjectContent slug={slug} page={page} pageSize={pageSize} />
        </Suspense>
      </div>
    </div>
  );
}

async function SubjectContent({
  slug,
  page,
  pageSize,
}: {
  slug: string;
  page: number;
  pageSize: number;
}) {
  const decodedSlug = decodeURIComponent(slug);
  const { books, total } = await getBooksBySubject(decodedSlug, page, pageSize);
  const totalPages = Math.ceil(total / pageSize);

  if (books.length === 0) {
    return (
      <div className="text-center py-16 bg-muted/30 rounded-2xl">
        <Library className="h-12 w-12 mx-auto text-foreground-muted mb-4" />
        <h2 className="font-display text-xl font-semibold text-foreground">
          No Books Found
        </h2>
        <p className="mt-2 text-foreground-muted max-w-md mx-auto">
          We don't have any books with this subject yet.
        </p>
        <Button asChild className="mt-6">
          <Link href="/recommendations">Browse Recommendations</Link>
        </Button>
      </div>
    );
  }

  // Convert to ExplainedRecommendation format for BookGrid
  const recommendations: ExplainedRecommendation[] = books.map((book) => ({
    workId: book.workId,
    title: book.title,
    authors: book.authors,
    year: book.year,
    description: book.description ?? undefined,
    coverUrl: book.coverUrl ?? undefined,
    avgRating: book.avgRating,
    ratingCount: book.ratingCount,
    relevanceScore: 0,
    qualityScore: 0,
    diversityScore: 0,
    engagementScore: 0,
    finalScore: 0,
    suggestionQuality: "B",
    confidence: 0,
    reasons: [],
  }));

  return (
    <div className="space-y-8">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <PageInfo
          currentPage={page}
          pageSize={pageSize}
          totalItems={total}
        />
      </div>

      {/* Books grid */}
      <BookGrid recommendations={recommendations} />

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="pt-6 border-t border-border">
          <Pagination currentPage={page} totalPages={totalPages} />
        </div>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="h-5 w-40 bg-muted rounded animate-pulse" />
      <BookGridSkeleton count={12} />
    </div>
  );
}
