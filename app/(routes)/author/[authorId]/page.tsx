import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, User, BookOpen } from "lucide-react";
import { notFound } from "next/navigation";
import { query } from "@/lib/db/pool";
import { getCoverUrl } from "@/lib/util/covers";
import { BookGridSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BookGrid } from "@/components/book-grid";
import { Pagination, PageInfo } from "@/components/pagination";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

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

interface AuthorBook {
  workId: number;
  title: string;
  year: number | null;
  description: string | null;
  coverUrl: string | null;
  avgRating: number | null;
  ratingCount: number | null;
}

async function getBooksByAuthor(
  authorId: number,
  page: number,
  pageSize: number
): Promise<{ books: AuthorBook[]; total: number }> {
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
         COALESCE(waa.author_names, '') as authors
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

  const books = rows.map((row) => ({
    workId: row.work_id,
    title: row.title,
    year: row.first_publish_year,
    description: row.description,
    coverUrl: getCoverUrl({
      coverId: row.cover_id,
      isbn13: row.isbn13,
      olWorkKey: row.ol_work_key,
    }),
    avgRating: row.avg_rating ? parseFloat(row.avg_rating) : null,
    ratingCount: row.rating_count,
    authors: row.authors?.split(", ").filter(Boolean) ?? [],
  }));

  return { books, total };
}

export async function generateMetadata(props: {
  params: Promise<{ authorId: string }>;
}): Promise<Metadata> {
  const { authorId: authorIdStr } = await props.params;
  const authorId = parseInt(authorIdStr, 10);

  if (isNaN(authorId)) {
    return { title: "Author Not Found" };
  }

  const author = await getAuthorDetails(authorId);

  if (!author) {
    return { title: "Author Not Found" };
  }

  return {
    title: `${author.name} - Books`,
    description: author.bio?.slice(0, 160) ?? `Browse all books by ${author.name}`,
  };
}

export default async function AuthorPage(props: {
  params: Promise<{ authorId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { authorId: authorIdStr } = await props.params;
  const searchParams = await props.searchParams;
  const authorId = parseInt(authorIdStr, 10);
  const page = parseInt(searchParams.page ?? "1", 10);
  const pageSize = 24;

  if (isNaN(authorId)) {
    notFound();
  }

  const author = await getAuthorDetails(authorId);

  if (!author) {
    notFound();
  }

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

          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl bg-primary/10 shrink-0">
              <User className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className="font-display text-3xl md:text-4xl font-bold text-foreground">
                {author.name}
              </h1>
              <div className="mt-2 flex items-center gap-2 text-foreground-muted">
                <BookOpen className="h-4 w-4" />
                <span>
                  {author.bookCount} {author.bookCount === 1 ? "book" : "books"}
                </span>
              </div>
              {author.bio && (
                <p className="mt-4 text-foreground-muted max-w-2xl leading-relaxed">
                  {author.bio}
                </p>
              )}
              {author.olAuthorKey && (
                <a
                  href={`https://openlibrary.org/authors/${author.olAuthorKey}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  View on Open Library →
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <Suspense fallback={<LoadingState />}>
          <AuthorBooksContent authorId={authorId} page={page} pageSize={pageSize} />
        </Suspense>
      </div>
    </div>
  );
}

async function AuthorBooksContent({
  authorId,
  page,
  pageSize,
}: {
  authorId: number;
  page: number;
  pageSize: number;
}) {
  const { books, total } = await getBooksByAuthor(authorId, page, pageSize);
  const totalPages = Math.ceil(total / pageSize);

  if (books.length === 0) {
    return (
      <div className="text-center py-16 bg-muted/30 rounded-2xl">
        <BookOpen className="h-12 w-12 mx-auto text-foreground-muted mb-4" />
        <h2 className="font-display text-xl font-semibold text-foreground">
          No Books Found
        </h2>
        <p className="mt-2 text-foreground-muted max-w-md mx-auto">
          We don't have any books by this author yet.
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
    authors: (book as { authors?: string[] }).authors ?? [],
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
