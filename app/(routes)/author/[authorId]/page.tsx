import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, User, BookOpen } from "lucide-react";
import { notFound } from "next/navigation";
import { BookGridSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BookGrid } from "@/components/book-grid";
import { Pagination, PageInfo } from "@/components/pagination";
import { RetryButton } from "@/components/ui/retry-button";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

interface AuthorDetails {
  id: number;
  name: string;
  bio: string | null;
  olAuthorKey: string | null;
  bookCount: number;
}

interface AuthorBooksResponse {
  author: AuthorDetails;
  books: ExplainedRecommendation[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface ApiError {
  error: string;
  details?: string;
  stack?: string;
}

class AuthorPageError extends Error {
  details?: string;
  stack?: string;
  status: number;

  constructor(message: string, status: number, details?: string, stack?: string) {
    super(message);
    this.name = "AuthorPageError";
    this.status = status;
    this.details = details;
    this.stack = stack;
  }
}

async function getAuthorBooks(
  authorId: number,
  page: number,
  pageSize: number
): Promise<AuthorBooksResponse> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(
    `${baseUrl}/api/books/by-author?author_id=${authorId}&page=${page}&page_size=${pageSize}`,
    { cache: "no-store" }
  );

  if (!res.ok) {
    let apiError: ApiError | null = null;
    try {
      apiError = await res.json();
    } catch {
      // Failed to parse error response
    }

    throw new AuthorPageError(
      apiError?.error ?? "Failed to fetch author books",
      res.status,
      apiError?.details,
      apiError?.stack
    );
  }

  return res.json();
}

export async function generateMetadata(props: {
  params: Promise<{ authorId: string }>;
}): Promise<Metadata> {
  const { authorId: authorIdStr } = await props.params;
  const authorId = parseInt(authorIdStr, 10);

  if (isNaN(authorId)) {
    return { title: "Author Not Found" };
  }

  try {
    const data = await getAuthorBooks(authorId, 1, 1);
    return {
      title: `${data.author.name} - Books`,
      description: data.author.bio?.slice(0, 160) ?? `Browse all books by ${data.author.name}`,
    };
  } catch {
    return { title: "Author Not Found" };
  }
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

  return (
    <div className="min-h-screen">
      <Suspense fallback={<HeaderSkeleton />}>
        <AuthorHeader authorId={authorId} />
      </Suspense>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <Suspense fallback={<LoadingState />}>
          <AuthorBooksContent authorId={authorId} page={page} pageSize={pageSize} />
        </Suspense>
      </div>
    </div>
  );
}

async function AuthorHeader({ authorId }: { authorId: number }) {
  try {
    const data = await getAuthorBooks(authorId, 1, 1);
    const author = data.author;

    return (
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
    );
  } catch (error) {
    if (error instanceof AuthorPageError && error.status === 404) {
      notFound();
    }
    throw error;
  }
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
  try {
    const data = await getAuthorBooks(authorId, page, pageSize);
    const { books, total, totalPages } = data;

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

    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <PageInfo
            currentPage={page}
            pageSize={pageSize}
            totalItems={total}
          />
        </div>

        <BookGrid recommendations={books} />

        {totalPages > 1 && (
          <div className="pt-6 border-t border-border">
            <Pagination currentPage={page} totalPages={totalPages} />
          </div>
        )}
      </div>
    );
  } catch (error) {
    const pageError = error instanceof AuthorPageError ? error : null;
    const isDev = process.env.NODE_ENV === "development";

    return (
      <div className="text-center py-16">
        <div className="mx-auto w-16 h-16 rounded-2xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-6">
          <svg
            className="h-8 w-8 text-red-600 dark:text-red-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="font-display text-2xl font-bold text-foreground">
          Failed to Load Books
        </h2>
        <p className="mt-3 text-foreground-muted max-w-md mx-auto">
          We couldn't fetch the books for this author. Please try again.
        </p>

        {isDev && pageError && (pageError.details || pageError.stack) && (
          <div className="mt-6 max-w-2xl mx-auto text-left">
            <details className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
              <summary className="cursor-pointer font-medium text-red-800 dark:text-red-300 text-sm">
                Error Details (Development Only)
              </summary>
              <div className="mt-3 space-y-3">
                {pageError.details && (
                  <div>
                    <h4 className="text-xs font-semibold text-red-700 dark:text-red-400 uppercase tracking-wide">
                      Details
                    </h4>
                    <p className="mt-1 text-sm text-red-600 dark:text-red-300 font-mono">
                      {pageError.details}
                    </p>
                  </div>
                )}
                {pageError.stack && (
                  <div>
                    <h4 className="text-xs font-semibold text-red-700 dark:text-red-400 uppercase tracking-wide">
                      Stack Trace
                    </h4>
                    <pre className="mt-1 text-xs text-red-600 dark:text-red-300 font-mono overflow-x-auto whitespace-pre-wrap break-all">
                      {pageError.stack}
                    </pre>
                  </div>
                )}
              </div>
            </details>
          </div>
        )}

        <RetryButton className="mt-6" />
      </div>
    );
  }
}

function HeaderSkeleton() {
  return (
    <div className="border-b border-border bg-background-warm">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="h-8 w-48 bg-muted rounded animate-pulse mb-4" />
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-xl bg-muted animate-pulse" />
          <div className="space-y-3">
            <div className="h-10 w-64 bg-muted rounded animate-pulse" />
            <div className="h-5 w-32 bg-muted rounded animate-pulse" />
          </div>
        </div>
      </div>
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
