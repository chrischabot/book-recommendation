import { Suspense } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  Calendar,
  Users,
  ExternalLink,
  Sparkles,
  Clock,
  TrendingUp,
  BookText,
  Building2,
  Library,
  ShoppingCart,
} from "lucide-react";
import { query } from "@/lib/db/pool";
import { getCoverUrl } from "@/lib/util/covers";
import { BookCoverPlaceholder } from "@/components/ui/book-cover-placeholder";
import { BookCoverImage } from "@/components/ui/book-cover-image";
import { BookRow } from "@/components/book-grid";
import { BookGridSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge, QualityBadge } from "@/components/ui/badge";
import { StarRating } from "@/components/ui/star-rating";
import { cn, formatCount, formatHours } from "@/lib/utils";
import { MarkdownDescription } from "@/components/ui/markdown-description";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

interface Author {
  id: number;
  name: string;
}

interface WorkDetails {
  id: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  year: number | null;
  authors: Author[];
  subjects: string[];
  avgRating: number | null;
  ratingCount: number | null;
  coverUrl: string | null;
  olWorkKey: string | null;
  // Edition data
  pageCount: number | null;
  publisher: string | null;
  isbn13: string | null;
  asin: string | null;
  series: string | null;
  // Engagement data
  totalMs: number | null;
  lastReadAt: Date | null;
  sessions: number | null;
}

/**
 * Generate Amazon URL for a book
 * Priority: ASIN (direct link) > ISBN (search) > Title+Author (search)
 */
function getAmazonUrl(work: WorkDetails): string {
  // Direct link if we have ASIN
  if (work.asin) {
    return `https://www.amazon.com/dp/${work.asin}`;
  }

  // Search by ISBN if available
  if (work.isbn13) {
    return `https://www.amazon.com/s?k=${work.isbn13}&i=stripbooks`;
  }

  // Fall back to title + author search
  const authorName = work.authors.length > 0 ? work.authors[0].name : "";
  const searchQuery = encodeURIComponent(`${work.title} ${authorName}`.trim());
  return `https://www.amazon.com/s?k=${searchQuery}&i=stripbooks`;
}

/**
 * Fetch cover from Open Library editions API when local data is missing
 */
async function fetchCoverFromOpenLibrary(olWorkKey: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://openlibrary.org/works/${olWorkKey}/editions.json?limit=5`,
      { next: { revalidate: 86400 } } // Cache for 24 hours
    );

    if (!response.ok) return null;

    const data = await response.json();
    const editions = data.entries ?? [];

    // Find first edition with a cover
    for (const edition of editions) {
      if (edition.covers && edition.covers.length > 0) {
        const coverId = edition.covers[0];
        if (coverId > 0) {
          return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
        }
      }
    }

    // Try ISBN-based cover as fallback
    for (const edition of editions) {
      if (edition.isbn_13 && edition.isbn_13.length > 0) {
        return `https://covers.openlibrary.org/b/isbn/${edition.isbn_13[0]}-L.jpg`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Clean and format description text
 * - Converts HTML tags to proper line breaks
 * - Decodes HTML entities
 */
function formatDescription(text: string): string {
  let result = text;

  // Convert HTML tags to newlines
  result = result.replace(/<br\s*\/?>/gi, "\n");
  result = result.replace(/<\/p>\s*<p>/gi, "\n\n");
  result = result.replace(/<\/?p>/gi, "\n");
  result = result.replace(/<[^>]+>/g, ""); // Remove any remaining HTML tags

  // Decode HTML entities
  result = result
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Normalize whitespace (but preserve intentional newlines)
  result = result.replace(/[ \t]+/g, " ");
  result = result.replace(/\n /g, "\n");
  result = result.replace(/ \n/g, "\n");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Fetch description from Open Library work API
 */
async function fetchDescriptionFromOpenLibrary(olWorkKey: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://openlibrary.org/works/${olWorkKey}.json`,
      { next: { revalidate: 86400 } }
    );

    if (!response.ok) return null;

    const data = await response.json();

    // Description can be a string or an object with "value" property
    let description: string | null = null;
    if (typeof data.description === "string") {
      description = data.description;
    } else if (data.description?.value) {
      description = data.description.value;
    }

    return description ? formatDescription(description) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch description from Google Books API by title + author search
 */
async function fetchDescriptionFromGoogleBooks(
  title: string,
  authorName: string | null
): Promise<string | null> {
  try {
    // Build search query
    let query = `intitle:${encodeURIComponent(title)}`;
    if (authorName) {
      query += `+inauthor:${encodeURIComponent(authorName)}`;
    }

    const response = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1`,
      { next: { revalidate: 86400 } }
    );

    if (!response.ok) return null;

    const data = await response.json();
    const book = data.items?.[0];

    if (book?.volumeInfo?.description) {
      return formatDescription(book.volumeInfo.description);
    }

    return null;
  } catch {
    return null;
  }
}

async function getWorkDetails(workId: number): Promise<WorkDetails | null> {
  const { rows } = await query<{
    id: number;
    title: string;
    subtitle: string | null;
    description: string | null;
    first_publish_year: number | null;
    authors_json: { id: number; name: string }[] | null;
    subjects: string;
    avg_rating: string | null;
    rating_count: number | null;
    cover_id: string | null;
    isbn13: string | null;
    ol_work_key: string | null;
    page_count: number | null;
    publisher: string | null;
    asin: string | null;
    series: string | null;
    total_ms: string | null;
    last_read_at: Date | null;
    sessions: number | null;
  }>(
    `
    SELECT
      w.id,
      w.title,
      w.subtitle,
      w.description,
      w.first_publish_year,
      (
        SELECT COALESCE(json_agg(json_build_object('id', a.id, 'name', a.name)), '[]')
        FROM "WorkAuthor" wa2
        JOIN "Author" a ON wa2.author_id = a.id
        WHERE wa2.work_id = w.id
      ) AS authors_json,
      COALESCE(string_agg(DISTINCT ws.subject, ', '), '') AS subjects,
      wq.blended_avg AS avg_rating,
      wq.total_ratings AS rating_count,
      e.cover_id,
      e.isbn13,
      w.ol_work_key,
      COALESCE(e.page_count, w.page_count_median) AS page_count,
      e.publisher,
      e.asin,
      w.series,
      ua.total_ms,
      ua.last_read_at,
      ua.sessions
    FROM "Work" w
    LEFT JOIN "WorkSubject" ws ON w.id = ws.work_id
    LEFT JOIN "WorkQuality" wq ON w.id = wq.work_id
    LEFT JOIN "Edition" e ON w.id = e.work_id AND (e.cover_id IS NOT NULL OR e.isbn13 IS NOT NULL OR e.asin IS NOT NULL)
    LEFT JOIN "UserReadingAggregate" ua ON ua.asin = e.asin AND ua.user_id = 'me'
    WHERE w.id = $1
    GROUP BY w.id, wq.blended_avg, wq.total_ratings, e.cover_id, e.isbn13, e.page_count, e.publisher, e.asin, ua.total_ms, ua.last_read_at, ua.sessions
    LIMIT 1
    `,
    [workId]
  );

  if (rows.length === 0) return null;

  const row = rows[0];

  // Try local cover data first (only if we have actual edition cover data)
  let coverUrl = getCoverUrl({
    coverId: row.cover_id,
    isbn13: row.isbn13,
    // Don't use olWorkKey here - work-level covers are unreliable
    size: "L",
  });

  // If no local cover and we have an OL work key, fetch from Open Library editions API
  if (!coverUrl && row.ol_work_key) {
    coverUrl = await fetchCoverFromOpenLibrary(row.ol_work_key);
  }

  // If no description, try to fetch from external sources
  let description = row.description;
  if (!description) {
    const authors = row.authors_json ?? [];
    const authorName = authors.length > 0 ? authors[0].name : null;

    // Try Open Library first
    if (row.ol_work_key) {
      description = await fetchDescriptionFromOpenLibrary(row.ol_work_key);
    }

    // Fall back to Google Books
    if (!description) {
      description = await fetchDescriptionFromGoogleBooks(row.title, authorName);
    }
  }

  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    description,
    year: row.first_publish_year,
    authors: row.authors_json ?? [],
    subjects: row.subjects?.split(", ").filter(Boolean) ?? [],
    avgRating: row.avg_rating ? parseFloat(row.avg_rating) : null,
    ratingCount: row.rating_count,
    coverUrl,
    olWorkKey: row.ol_work_key,
    pageCount: row.page_count,
    publisher: row.publisher,
    isbn13: row.isbn13,
    asin: row.asin,
    series: row.series,
    totalMs: row.total_ms ? parseInt(row.total_ms, 10) : null,
    lastReadAt: row.last_read_at,
    sessions: row.sessions,
  };
}

async function getSimilarBooks(
  workId: number
): Promise<ExplainedRecommendation[]> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(
      `${baseUrl}/api/recommendations/by-book?work_id=${workId}&user_id=me&k=12`,
      { cache: "no-store" }
    );

    if (!res.ok) return [];

    const data = await res.json();
    return data.recommendations ?? [];
  } catch {
    return [];
  }
}

export async function generateMetadata(props: {
  params: Promise<{ workId: string }>;
}): Promise<Metadata> {
  const { workId: workIdStr } = await props.params;
  const workId = parseInt(workIdStr, 10);

  if (isNaN(workId)) {
    return { title: "Book Not Found" };
  }

  const work = await getWorkDetails(workId);

  if (!work) {
    return { title: "Book Not Found" };
  }

  return {
    title: work.title,
    description:
      work.description?.slice(0, 160) ??
      `View details and similar books for ${work.title}`,
  };
}

export default async function BookPage(props: {
  params: Promise<{ workId: string }>;
}) {
  const { workId: workIdStr } = await props.params;
  const workId = parseInt(workIdStr, 10);

  if (isNaN(workId)) {
    notFound();
  }

  const work = await getWorkDetails(workId);

  if (!work) {
    notFound();
  }

  const hoursRead = work.totalMs ? work.totalMs / 3_600_000 : null;
  const lastReadLabel = work.lastReadAt
    ? new Date(work.lastReadAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div className="min-h-screen">
      {/* Hero section with cover */}
      <section className="relative overflow-hidden bg-gradient-to-b from-background-warm to-background">
        {/* Background blur effect from cover */}
        <div className="absolute inset-0 -z-10 overflow-hidden">
          {work.coverUrl && (
            <div
              className="absolute inset-0 scale-110 blur-3xl opacity-20"
              style={{
                backgroundImage: `url(${work.coverUrl})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }}
            />
          )}
        </div>

        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {/* Back button */}
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="mb-6 -ml-2 animate-fade-in"
          >
            <Link href="/recommendations">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back to Recommendations
            </Link>
          </Button>

          <div className="grid gap-8 lg:grid-cols-[350px_1fr] lg:gap-12">
            {/* Cover image */}
            <div className="animate-fade-up">
              <div className="relative mx-auto lg:mx-0 max-w-[280px] lg:max-w-none">
                <div
                  className={cn(
                    "relative aspect-[2/3] overflow-hidden rounded-2xl",
                    "bg-muted shadow-book",
                    "ring-1 ring-border/50"
                  )}
                >
                  <BookCoverImage
                    coverUrl={work.coverUrl}
                    title={work.title}
                    author={work.authors.length > 0 ? work.authors.map(a => a.name).join(", ") : undefined}
                  />
                  {/* Page edge effect */}
                  <div className="absolute inset-y-0 right-0 w-[4px] bg-gradient-to-l from-black/15 to-transparent" />
                </div>

                {/* Reading stats card */}
                {hoursRead && hoursRead > 0 && (
                  <div
                    className={cn(
                      "mt-4 p-4 rounded-xl",
                      "bg-card border border-border shadow-card"
                    )}
                  >
                    <h3 className="text-sm font-medium text-foreground-muted mb-3">
                      Your Reading Activity
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-primary" />
                        <div>
                          <div className="text-lg font-semibold text-foreground">
                            {formatHours(hoursRead)}
                          </div>
                          <div className="text-xs text-foreground-muted">
                            Total time
                          </div>
                        </div>
                      </div>
                      {work.sessions && (
                        <div className="flex items-center gap-2">
                          <TrendingUp className="h-4 w-4 text-secondary" />
                          <div>
                            <div className="text-lg font-semibold text-foreground">
                              {work.sessions}
                            </div>
                            <div className="text-xs text-foreground-muted">
                              Sessions
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    {lastReadLabel && (
                      <p className="mt-3 text-xs text-foreground-subtle">
                        Last read on {lastReadLabel}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Book details */}
            <div className="animate-fade-up stagger-1">
              {/* Year badge */}
              {work.year && (
                <div className="flex items-center gap-2 text-foreground-muted mb-3">
                  <Calendar className="h-4 w-4" />
                  <span className="text-sm font-medium">
                    First published {work.year}
                  </span>
                </div>
              )}

              {/* Title */}
              <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground leading-tight">
                {work.title}
              </h1>

              {/* Subtitle */}
              {work.subtitle && (
                <p className="mt-3 text-xl text-foreground-muted font-serif italic">
                  {work.subtitle}
                </p>
              )}

              {/* Authors */}
              <p className="mt-4 text-lg text-foreground-muted">
                by{" "}
                {work.authors.length > 0 ? (
                  work.authors.map((author, idx) => (
                    <span key={author.id}>
                      <Link
                        href={`/author/${author.id}`}
                        className="text-foreground font-medium hover:text-primary transition-colors"
                      >
                        {author.name}
                      </Link>
                      {idx < work.authors.length - 1 && ", "}
                    </span>
                  ))
                ) : (
                  <span className="text-foreground font-medium">
                    Unknown Author
                  </span>
                )}
              </p>

              {/* Rating */}
              {work.avgRating !== null && (
                <div className="mt-6 flex items-center gap-4">
                  <StarRating
                    rating={work.avgRating}
                    size="lg"
                    count={work.ratingCount ?? undefined}
                  />
                </div>
              )}

              {/* Book Details */}
              {(work.pageCount || work.publisher || work.series) && (
                <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-sm">
                  {work.pageCount && (
                    <div className="flex items-center gap-2 text-foreground-muted">
                      <BookText className="h-4 w-4 text-foreground-subtle" />
                      <span>{work.pageCount} pages</span>
                    </div>
                  )}
                  {work.publisher && (
                    <div className="flex items-center gap-2 text-foreground-muted">
                      <Building2 className="h-4 w-4 text-foreground-subtle" />
                      <span>{work.publisher}</span>
                    </div>
                  )}
                  {work.series && (
                    <div className="flex items-center gap-2 text-foreground-muted">
                      <Library className="h-4 w-4 text-foreground-subtle" />
                      <span>{work.series}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Description */}
              {work.description && (
                <div className="mt-8">
                  <h2 className="font-display text-lg font-semibold text-foreground mb-3">
                    About This Book
                  </h2>
                  <MarkdownDescription>{work.description}</MarkdownDescription>
                </div>
              )}

              {/* Subjects */}
              {work.subjects.length > 0 && (
                <div className="mt-8">
                  <h2 className="font-display text-lg font-semibold text-foreground mb-3">
                    Genres & Topics
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    {work.subjects.slice(0, 12).map((subject) => (
                      <Link
                        key={subject}
                        href={`/subject/${encodeURIComponent(subject)}`}
                      >
                        <Badge
                          variant="outline"
                          className="text-sm cursor-pointer hover:bg-primary/10 hover:border-primary/50 transition-colors"
                        >
                          {subject.replace(/_/g, " ")}
                        </Badge>
                      </Link>
                    ))}
                    {work.subjects.length > 12 && (
                      <Badge variant="muted" className="text-sm">
                        +{work.subjects.length - 12} more
                      </Badge>
                    )}
                  </div>
                </div>
              )}

              {/* External links */}
              <div className="mt-8 flex flex-wrap gap-3">
                {work.olWorkKey && (
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={`https://openlibrary.org/works/${work.olWorkKey}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <BookOpen className="h-4 w-4 mr-2" />
                      Open Library
                      <ExternalLink className="h-3 w-3 ml-1.5 opacity-50" />
                    </a>
                  </Button>
                )}
                <Button asChild variant="outline" size="sm">
                  <a
                    href={getAmazonUrl(work)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ShoppingCart className="h-4 w-4 mr-2" />
                    Amazon
                    <ExternalLink className="h-3 w-3 ml-1.5 opacity-50" />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Similar Books Section */}
      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <Suspense fallback={<SimilarBooksLoading />}>
          <SimilarBooksSection workId={workId} title={work.title} />
        </Suspense>
      </section>
    </div>
  );
}

async function SimilarBooksSection({
  workId,
  title,
}: {
  workId: number;
  title: string;
}) {
  const similar = await getSimilarBooks(workId);

  if (similar.length === 0) {
    return (
      <div className="text-center py-12 bg-muted/30 rounded-2xl">
        <Sparkles className="h-10 w-10 mx-auto text-foreground-muted mb-4" />
        <h2 className="font-display text-xl font-semibold text-foreground">
          No Similar Books Found
        </h2>
        <p className="mt-2 text-foreground-muted max-w-md mx-auto">
          We're still learning about this book. Check back later for similar
          recommendations.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="border-t border-border pt-8" />

      <BookRow
        recommendations={similar}
        title="Similar Books"
        subtitle={`Because you're viewing "${title}"`}
      />
    </div>
  );
}

function SimilarBooksLoading() {
  return (
    <div className="space-y-6">
      <div className="border-t border-border pt-8" />
      <div>
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="h-4 w-64 bg-muted rounded animate-pulse mt-2" />
      </div>
      <BookGridSkeleton count={6} />
    </div>
  );
}
