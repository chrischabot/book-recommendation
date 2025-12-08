import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Tag } from "lucide-react";
import { query } from "@/lib/db/pool";
import { getCoverUrl } from "@/lib/util/covers";
import { BookGridSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { SubjectContentClient } from "@/components/subject-content";
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
  source: "openlibrary" | "googlebooks" | "amazon" | "royalroad" | "goodreads" | "manual" | null;
  isStub: boolean;
  stubReason: string | null;
}

type SuggestionQuality = "A+" | "A" | "A-" | "B+" | "B" | "B-";

/**
 * Calculate suggestion quality based on rating and count
 */
function calculateQuality(avgRating: number | null, ratingCount: number | null): { quality: SuggestionQuality; confidence: number } {
  if (avgRating === null || ratingCount === null || ratingCount < 5) {
    return { quality: "B-", confidence: 0.5 };
  }

  // Confidence scales with log of rating count (diminishing returns)
  const confidence = Math.min(0.95, 0.6 + Math.log10(ratingCount) * 0.1);

  // Quality based on rating
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
    source: string | null;
    is_stub: boolean | null;
    stub_reason: string | null;
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
         wq.total_ratings as rating_count,
         w.source,
         w.is_stub,
         w.stub_reason
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

  type WorkSource = "openlibrary" | "googlebooks" | "amazon" | "royalroad" | "goodreads" | "manual";
  const validSources: WorkSource[] = ["openlibrary", "googlebooks", "amazon", "royalroad", "goodreads", "manual"];

  const books: SubjectBook[] = rows.map((row) => {
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
      source: row.source && validSources.includes(row.source as WorkSource) ? row.source as WorkSource : null,
      isStub: row.is_stub ?? false,
      stubReason: row.stub_reason,
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

  // Convert to ExplainedRecommendation format for the client component
  const recommendations: ExplainedRecommendation[] = books.map((book) => {
    const { quality, confidence } = calculateQuality(book.avgRating, book.ratingCount);
    return {
      workId: book.workId,
      title: book.title,
      authors: book.authors,
      year: book.year,
      description: book.description ?? undefined,
      coverUrl: book.coverUrl ?? undefined,
      avgRating: book.avgRating,
      ratingCount: book.ratingCount,
      relevanceScore: 0,
      qualityScore: book.avgRating ? book.avgRating / 5 : 0,
      diversityScore: 0,
      engagementScore: 0,
      finalScore: 0,
      suggestionQuality: quality,
      confidence,
      reasons: [],
      source: book.source ?? undefined,
      isStub: book.isStub,
      stubReason: book.stubReason ?? undefined,
    };
  });

  return (
    <SubjectContentClient
      recommendations={recommendations}
      page={page}
      pageSize={pageSize}
      total={total}
      totalPages={totalPages}
    />
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
