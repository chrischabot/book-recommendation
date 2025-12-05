import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Library, ChevronRight, Sparkles, ArrowLeft } from "lucide-react";
import { getCategoryConstraints, getCategoryMetadata } from "@/lib/config/categories";
import { BookGridSkeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { CategorySelector } from "@/components/category-selector";
import { CategoryView } from "@/components/category-view";
import { cn, formatCategoryName } from "@/lib/utils";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

interface CategoryResponse {
  category: {
    slug: string;
    description?: string;
  };
  recommendations: ExplainedRecommendation[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

async function getCategoryRecommendations(
  slug: string,
  page: number,
  pageSize: number
): Promise<CategoryResponse> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(
    `${baseUrl}/api/recommendations/by-category?slug=${slug}&page=${page}&page_size=${pageSize}&user_id=me`,
    { cache: "no-store" }
  );

  if (!res.ok) {
    throw new Error("Failed to fetch category recommendations");
  }

  return res.json();
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const constraints = getCategoryConstraints(slug);

  if (!constraints) {
    return { title: "Category Not Found" };
  }

  return {
    title: formatCategoryName(slug),
    description:
      constraints.description ??
      `Explore our curated ${formatCategoryName(slug)} book recommendations.`,
  };
}

export default async function CategoryPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await props.params;
  const resolvedSearchParams = await props.searchParams;
  const page = parseInt(resolvedSearchParams.page ?? "1", 10);
  const pageSize = 24;

  // Validate category exists
  const constraints = getCategoryConstraints(slug);
  if (!constraints) {
    notFound();
  }

  const allCategories = getCategoryMetadata();

  return (
    <div className="min-h-screen">
      {/* Breadcrumb */}
      <div className="border-b border-border bg-background-warm">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
          <nav className="flex items-center gap-2 text-sm">
            <Link
              href="/categories"
              className="text-foreground-muted hover:text-foreground transition-colors"
            >
              Categories
            </Link>
            <ChevronRight className="h-4 w-4 text-foreground-subtle" />
            <span className="text-foreground font-medium">
              {formatCategoryName(slug)}
            </span>
          </nav>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="lg:grid lg:grid-cols-[280px_1fr] lg:gap-8">
          {/* Sidebar - Desktop */}
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center gap-2 mb-4">
                  <Library className="h-5 w-5 text-primary" />
                  <h2 className="font-display text-lg font-semibold text-foreground">
                    Categories
                  </h2>
                </div>

                <ScrollArea className="h-[calc(100vh-280px)]">
                  <nav className="space-y-1 pr-4">
                    {allCategories.map((cat) => {
                      const isActive = cat.slug === slug;

                      return (
                        <Link
                          key={cat.slug}
                          href={`/category/${cat.slug}`}
                          className={cn(
                            "flex items-center justify-between rounded-lg px-3 py-2.5 text-sm",
                            "transition-all duration-150",
                            isActive
                              ? "bg-primary/10 text-primary font-medium"
                              : "text-foreground-muted hover:bg-muted hover:text-foreground"
                          )}
                        >
                          <span>{formatCategoryName(cat.slug)}</span>
                          {isActive && (
                            <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                          )}
                        </Link>
                      );
                    })}
                  </nav>
                </ScrollArea>
              </div>
            </div>
          </aside>

          {/* Main content */}
          <div className="mt-6 lg:mt-0">
            {/* Header */}
            <div className="mb-8 animate-fade-up">
              {/* Mobile back button */}
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="mb-4 lg:hidden -ml-2"
              >
                <Link href="/categories">
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  All Categories
                </Link>
              </Button>

              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl bg-primary/10 shrink-0">
                  <Sparkles className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h1 className="font-display text-3xl md:text-4xl font-bold text-foreground">
                    {formatCategoryName(slug)}
                  </h1>
                  {constraints.description && (
                    <p className="mt-2 text-foreground-muted">
                      {constraints.description}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Mobile category selector */}
            <div className="mb-6 lg:hidden">
              <CategorySelector categories={allCategories} currentSlug={slug} />
            </div>

            {/* Content */}
            <Suspense fallback={<LoadingState />}>
              <CategoryContent slug={slug} page={page} pageSize={pageSize} />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}

async function CategoryContent({
  slug,
  page,
  pageSize,
}: {
  slug: string;
  page: number;
  pageSize: number;
}) {
  try {
    const data = await getCategoryRecommendations(slug, page, pageSize);

    if (data.recommendations.length === 0) {
      return (
        <div className="text-center py-16 bg-muted/30 rounded-2xl">
          <Library className="h-12 w-12 mx-auto text-foreground-muted mb-4" />
          <h2 className="font-display text-xl font-semibold text-foreground">
            No Books Found
          </h2>
          <p className="mt-2 text-foreground-muted max-w-md mx-auto">
            We don't have recommendations for this category yet. Try browsing
            another genre.
          </p>
          <Button asChild className="mt-6">
            <Link href="/categories">Browse Categories</Link>
          </Button>
        </div>
      );
    }

    return (
      <CategoryView
        recommendations={data.recommendations}
        page={page}
        pageSize={pageSize}
        total={data.total}
        totalPages={data.totalPages}
      />
    );
  } catch {
    return (
      <div className="text-center py-16 bg-red-50 rounded-2xl border border-red-100">
        <div className="mx-auto w-12 h-12 rounded-xl bg-red-100 flex items-center justify-center mb-4">
          <svg
            className="h-6 w-6 text-red-600"
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
        <h3 className="font-display text-lg font-semibold text-red-800">
          Failed to Load
        </h3>
        <p className="mt-2 text-sm text-red-600">
          We couldn't load recommendations for this category.
        </p>
      </div>
    );
  }
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="h-5 w-40 bg-muted rounded animate-pulse" />
      <BookGridSkeleton count={12} />
    </div>
  );
}
