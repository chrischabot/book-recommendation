import { Suspense } from "react";
import type { Metadata } from "next";
import { Sparkles, BookMarked } from "lucide-react";
import { BookGridSkeleton } from "@/components/ui/skeleton";
import { RetryButton } from "@/components/ui/retry-button";
import { RecommendationsView } from "@/components/recommendations-view";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

export const metadata: Metadata = {
  title: "Your Recommendations",
  description:
    "Personalized book recommendations based on your reading history and preferences.",
};

interface RecommendationsResponse {
  recommendations: ExplainedRecommendation[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

async function getRecommendations(
  page: number,
  pageSize: number
): Promise<RecommendationsResponse> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(
    `${baseUrl}/api/recommendations/general?page=${page}&page_size=${pageSize}&user_id=me`,
    { cache: "no-store" }
  );

  if (!res.ok) {
    throw new Error("Failed to fetch recommendations");
  }

  return res.json();
}

export default async function RecommendationsPage(props: {
  searchParams: Promise<{ page?: string }>;
}) {
  const searchParams = await props.searchParams;
  const page = parseInt(searchParams.page ?? "1", 10);
  const pageSize = 24;

  return (
    <div className="min-h-screen">
      {/* Hero Header */}
      <section className="relative overflow-hidden bg-background-warm border-b border-border">
        {/* Background decoration */}
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-0 right-1/4 w-72 h-72 bg-primary/5 rounded-full blur-3xl" />
          <div className="absolute bottom-0 left-1/4 w-72 h-72 bg-accent/5 rounded-full blur-3xl" />
        </div>

        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="animate-fade-up">
            <div className="inline-flex items-center gap-2 text-primary mb-3">
              <Sparkles className="h-5 w-5" />
              <span className="text-sm font-medium uppercase tracking-wider">
                Curated For You
              </span>
            </div>
            <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground">
              Your Recommendations
            </h1>
            <p className="mt-3 text-lg text-foreground-muted max-w-xl">
              Personalized picks based on your reading history, powered by AI
              that understands your unique taste.
            </p>
          </div>
        </div>
      </section>

      {/* Main Content */}
      <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        <Suspense fallback={<LoadingState />}>
          <RecommendationsContent page={page} pageSize={pageSize} />
        </Suspense>
      </section>
    </div>
  );
}

async function RecommendationsContent({
  page,
  pageSize,
}: {
  page: number;
  pageSize: number;
}) {
  try {
    const data = await getRecommendations(page, pageSize);

    if (data.recommendations.length === 0) {
      return <EmptyState />;
    }

    return (
      <RecommendationsView
        recommendations={data.recommendations}
        page={page}
        pageSize={pageSize}
        total={data.total}
        totalPages={data.totalPages}
      />
    );
  } catch {
    return <ErrorState />;
  }
}

function LoadingState() {
  return (
    <div className="space-y-8">
      {/* Page info skeleton */}
      <div className="h-5 w-48 bg-muted rounded animate-pulse" />

      {/* Featured skeleton */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden animate-pulse">
        <div className="grid md:grid-cols-2">
          <div className="aspect-[3/4] md:aspect-auto bg-muted" />
          <div className="p-8 space-y-4">
            <div className="h-4 w-20 bg-muted rounded" />
            <div className="h-10 w-3/4 bg-muted rounded" />
            <div className="h-6 w-1/2 bg-muted rounded" />
            <div className="h-20 w-full bg-muted rounded" />
          </div>
        </div>
      </div>

      {/* Grid skeleton */}
      <BookGridSkeleton count={12} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-6">
        <BookMarked className="h-8 w-8 text-primary" />
      </div>
      <h2 className="font-display text-2xl font-bold text-foreground">
        No Recommendations Yet
      </h2>
      <p className="mt-3 text-foreground-muted max-w-md mx-auto">
        Import your reading history from Goodreads or Kindle to get personalized
        book recommendations.
      </p>
      <div className="mt-8 space-y-4">
        <div className="p-6 rounded-xl bg-muted/50 max-w-md mx-auto text-left">
          <h3 className="font-semibold text-foreground mb-2">Quick Start:</h3>
          <ol className="space-y-2 text-sm text-foreground-muted">
            <li className="flex gap-2">
              <span className="font-medium text-primary">1.</span>
              Export your Goodreads library or Amazon data
            </li>
            <li className="flex gap-2">
              <span className="font-medium text-primary">2.</span>
              Run{" "}
              <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">
                pnpm import:goodreads
              </code>{" "}
              or{" "}
              <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">
                pnpm import:kindle
              </code>
            </li>
            <li className="flex gap-2">
              <span className="font-medium text-primary">3.</span>
              Run{" "}
              <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">
                pnpm profile:build
              </code>{" "}
              to generate your taste profile
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="text-center py-16">
      <div className="mx-auto w-16 h-16 rounded-2xl bg-red-100 flex items-center justify-center mb-6">
        <svg
          className="h-8 w-8 text-red-600"
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
        Failed to Load Recommendations
      </h2>
      <p className="mt-3 text-foreground-muted max-w-md mx-auto">
        We couldn't fetch your recommendations. Please make sure you've imported
        your reading history and try again.
      </p>
      <RetryButton className="mt-6" />
    </div>
  );
}
