"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Search, Loader2, BookOpen, User } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { Pagination, PageInfo } from "@/components/pagination";
import { InlineRating } from "@/components/ui/star-rating";
import { BookCoverPlaceholder } from "@/components/ui/book-cover-placeholder";
import { SourceBadge, type BookSource } from "@/components/ui/badge";

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

function SearchResultCard({
  result,
  index,
}: {
  result: SearchResult;
  index: number;
}) {
  const [imageError, setImageError] = useState(false);
  const hasCover = result.coverUrl && !imageError;
  const authorString =
    result.authors.length > 0 ? result.authors.join(", ") : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.4 }}
    >
      <Link
        href={`/book/${result.workId}`}
        className={cn(
          "flex gap-4 p-4 rounded-xl",
          "bg-card border border-border/50 shadow-card",
          "transition-all duration-300",
          "hover:shadow-book hover:-translate-y-0.5 hover:border-primary/20",
          "group"
        )}
      >
        {/* Cover */}
        <div className="relative w-20 h-28 flex-shrink-0 overflow-hidden rounded-lg bg-muted shadow-sm">
          {hasCover ? (
            <Image
              src={result.coverUrl as string}
              alt={result.title}
              fill
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              onError={() => setImageError(true)}
              onLoad={(e) => {
                const img = e.currentTarget as HTMLImageElement;
                if (img.naturalWidth <= 1 || img.naturalHeight <= 1) {
                  setImageError(true);
                }
              }}
              sizes="80px"
            />
          ) : (
            <BookCoverPlaceholder title={result.title} author={authorString} />
          )}
          <div className="absolute inset-y-0 right-0 w-[2px] bg-gradient-to-l from-black/10 to-transparent" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 py-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-display font-semibold text-foreground group-hover:text-primary transition-colors line-clamp-2">
              {result.title}
            </h3>
            {result.matchType === "author" && (
              <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs text-foreground-muted bg-muted px-2 py-0.5 rounded-full">
                <User className="h-3 w-3" />
                Author match
              </span>
            )}
          </div>

          <p className="text-sm text-foreground-muted mt-1 line-clamp-1">
            {result.authors.length > 0
              ? result.authors.join(", ")
              : "Unknown Author"}
          </p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-sm">
            {result.year && (
              <span className="text-foreground-subtle tabular-nums">
                {result.year}
              </span>
            )}
            {result.avgRating !== null && (
              <InlineRating
                rating={result.avgRating}
                count={result.ratingCount ?? undefined}
              />
            )}
            {result.source && <SourceBadge source={result.source as BookSource} />}
          </div>

          {result.description && (
            <p className="text-sm text-foreground-muted mt-2 line-clamp-2">
              {result.description}
            </p>
          )}
        </div>
      </Link>
    </motion.div>
  );
}

function SearchContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const initialPage = parseInt(searchParams.get("page") ?? "1", 10);

  const [_query, setQuery] = useState(initialQuery);
  const [inputValue, setInputValue] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [pageSize, setPageSize] = useState(20);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(!!initialQuery);

  const performSearch = useCallback(
    async (searchQuery: string, page: number) => {
      if (!searchQuery || searchQuery.length < 2) {
        setResults([]);
        setTotal(0);
        setTotalPages(0);
        return;
      }

      setIsLoading(true);
      try {
        const params = new URLSearchParams({
          q: searchQuery,
          page: page.toString(),
          page_size: "20",
        });

        const response = await fetch(`/api/search?${params}`);
        if (!response.ok) throw new Error("Search failed");

        const data: SearchResponse = await response.json();
        setResults(data.results);
        setTotal(data.total);
        setTotalPages(data.totalPages);
        setCurrentPage(data.page);
        setPageSize(data.pageSize);
        setHasSearched(true);
      } catch (error) {
        console.error("Search error:", error);
        setResults([]);
        setTotal(0);
        setTotalPages(0);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // Search on initial load if query present
  useEffect(() => {
    if (initialQuery) {
      performSearch(initialQuery, initialPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only on mount

  // Handle form submission
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim().length >= 2) {
      setQuery(inputValue.trim());
      router.push(`/search?q=${encodeURIComponent(inputValue.trim())}`);
      performSearch(inputValue.trim(), 1);
    }
  };

  // Handle page change from pagination
  useEffect(() => {
    const pageParam = parseInt(searchParams.get("page") ?? "1", 10);
    const queryParam = searchParams.get("q") ?? "";
    if (queryParam && pageParam !== currentPage) {
      performSearch(queryParam, pageParam);
    }
  }, [searchParams, currentPage, performSearch]);

  return (
    <div className="min-h-screen">
      {/* Search Header */}
      <section className="relative overflow-hidden bg-background-warm border-b border-border">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-0 left-1/4 w-72 h-72 bg-primary/5 rounded-full blur-3xl" />
          <div className="absolute bottom-0 right-1/4 w-72 h-72 bg-secondary/5 rounded-full blur-3xl" />
        </div>

        <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="text-center animate-fade-up">
            <div className="inline-flex items-center gap-2 text-primary mb-3">
              <Search className="h-5 w-5" />
              <span className="text-sm font-medium uppercase tracking-wider">
                Search
              </span>
            </div>
            <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground">
              Find Books
            </h1>
            <p className="mt-4 text-lg text-foreground-muted">
              Search by title or author name
            </p>
          </div>

          {/* Search Form */}
          <form onSubmit={handleSubmit} className="mt-8">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-foreground-muted" />
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Search for books or authors..."
                className={cn(
                  "w-full h-14 pl-12 pr-4 rounded-xl",
                  "bg-card border border-border shadow-card",
                  "text-foreground placeholder:text-foreground-muted",
                  "focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary",
                  "transition-all duration-200"
                )}
                autoFocus
              />
              {isLoading && (
                <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 h-5 w-5 text-primary animate-spin" />
              )}
            </div>
          </form>
        </div>
      </section>

      {/* Results */}
      <section className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <AnimatePresence mode="wait">
          {isLoading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-16"
            >
              <Loader2 className="h-8 w-8 text-primary animate-spin" />
              <p className="mt-4 text-foreground-muted">Searching...</p>
            </motion.div>
          ) : hasSearched && results.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="text-center py-16"
            >
              <BookOpen className="h-12 w-12 text-foreground-muted mx-auto mb-4" />
              <h2 className="font-display text-xl font-semibold text-foreground">
                No books found
              </h2>
              <p className="mt-2 text-foreground-muted">
                Try a different search term or check your spelling
              </p>
            </motion.div>
          ) : hasSearched && results.length > 0 ? (
            <motion.div
              key="results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {/* Results header */}
              <div className="flex items-center justify-between mb-6">
                <PageInfo
                  currentPage={currentPage}
                  pageSize={pageSize}
                  totalItems={total}
                />
              </div>

              {/* Results list */}
              <div className="space-y-4">
                {results.map((result, index) => (
                  <SearchResultCard
                    key={result.workId}
                    result={result}
                    index={index}
                  />
                ))}
              </div>

              {/* Pagination */}
              <div className="mt-8">
                <Pagination currentPage={currentPage} totalPages={totalPages} />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="initial"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center py-16"
            >
              <Search className="h-12 w-12 text-foreground-muted mx-auto mb-4" />
              <h2 className="font-display text-xl font-semibold text-foreground">
                Start searching
              </h2>
              <p className="mt-2 text-foreground-muted">
                Enter at least 2 characters to search for books
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}

// Loading fallback for Suspense boundary
function SearchLoading() {
  return (
    <div className="min-h-screen">
      <section className="relative overflow-hidden bg-background-warm border-b border-border">
        <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="text-center">
            <div className="inline-flex items-center gap-2 text-primary mb-3">
              <Search className="h-5 w-5" />
              <span className="text-sm font-medium uppercase tracking-wider">
                Search
              </span>
            </div>
            <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground">
              Find Books
            </h1>
            <p className="mt-4 text-lg text-foreground-muted">
              Search by title or author name
            </p>
          </div>
          <div className="mt-8">
            <div className="w-full h-14 rounded-xl bg-card border border-border animate-pulse" />
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center justify-center py-16">
          <Loader2 className="h-8 w-8 text-primary animate-spin" />
          <p className="mt-4 text-foreground-muted">Loading...</p>
        </div>
      </section>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<SearchLoading />}>
      <SearchContent />
    </Suspense>
  );
}
