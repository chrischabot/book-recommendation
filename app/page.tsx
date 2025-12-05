import Link from "next/link";
import { Suspense } from "react";
import {
  BookOpen,
  Sparkles,
  Library,
  ArrowRight,
  Upload,
  Zap,
  Heart,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BookGridSkeleton } from "@/components/ui/skeleton";
import { BookRow } from "@/components/book-grid";
import { cn, formatCategoryName } from "@/lib/utils";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

// Featured categories for the home page
const featuredCategories = [
  {
    slug: "science-fiction",
    icon: "🚀",
    gradient: "from-violet-500 to-purple-600",
  },
  {
    slug: "high-fantasy",
    icon: "🐉",
    gradient: "from-emerald-500 to-teal-600",
  },
  {
    slug: "mystery",
    icon: "🔍",
    gradient: "from-amber-500 to-orange-600",
  },
  {
    slug: "biography",
    icon: "📖",
    gradient: "from-blue-500 to-indigo-600",
  },
  {
    slug: "thriller",
    icon: "🎭",
    gradient: "from-red-500 to-rose-600",
  },
  {
    slug: "history",
    icon: "🏛️",
    gradient: "from-stone-500 to-stone-700",
  },
];

const features = [
  {
    icon: Upload,
    title: "Import Your Library",
    description:
      "Connect your Goodreads or Kindle reading history via easy CLI import.",
  },
  {
    icon: Sparkles,
    title: "AI-Powered Matching",
    description:
      "Advanced embeddings analyze your taste and find perfect matches.",
  },
  {
    icon: Heart,
    title: "Personalized For You",
    description:
      "Every recommendation is tailored to your unique reading preferences.",
  },
  {
    icon: Zap,
    title: "Instant Discovery",
    description:
      "Browse by category or get a curated feed of books you'll love.",
  },
];

async function getHomeRecommendations(): Promise<ExplainedRecommendation[]> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
    const res = await fetch(
      `${baseUrl}/api/recommendations/general?page=1&page_size=12&user_id=me`,
      { cache: "no-store" }
    );

    if (!res.ok) return [];
    const data = await res.json();
    return data.recommendations ?? [];
  } catch {
    return [];
  }
}

export default function HomePage() {
  return (
    <div className="relative">
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        {/* Background decoration */}
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
          <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-accent/5 rounded-full blur-3xl" />
        </div>

        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 lg:py-32">
          <div className="text-center max-w-4xl mx-auto">
            {/* Tagline */}
            <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-1.5 text-sm font-medium text-primary mb-6 animate-fade-up">
              <Sparkles className="h-4 w-4" />
              AI-Powered Book Discovery
            </div>

            {/* Main heading */}
            <h1 className="font-display text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight text-foreground animate-fade-up stagger-1">
              Find Your Next{" "}
              <span className="relative">
                <span className="relative z-10 text-primary">Favorite Book</span>
                <svg
                  className="absolute -bottom-2 left-0 w-full h-3 text-primary/20"
                  viewBox="0 0 200 12"
                  preserveAspectRatio="none"
                >
                  <path
                    d="M0 6 Q 50 0, 100 6 T 200 6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="8"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </h1>

            {/* Subtitle */}
            <p className="mt-6 text-lg sm:text-xl text-foreground-muted max-w-2xl mx-auto leading-relaxed animate-fade-up stagger-2">
              Import your reading history from Goodreads or Kindle, and discover
              personalized recommendations powered by advanced AI that truly
              understands your taste.
            </p>

            {/* CTA Buttons */}
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4 animate-fade-up stagger-3">
              <Button asChild size="xl" className="group">
                <Link href="/recommendations">
                  Get Recommendations
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="xl">
                <Link href="/categories">
                  Browse Categories
                </Link>
              </Button>
            </div>

            {/* Stats */}
            <div className="mt-16 grid grid-cols-3 gap-8 max-w-lg mx-auto animate-fade-up stagger-4">
              <div className="text-center">
                <div className="text-3xl font-display font-bold text-foreground">
                  100K+
                </div>
                <div className="text-sm text-foreground-muted">Books Indexed</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-display font-bold text-foreground">
                  20+
                </div>
                <div className="text-sm text-foreground-muted">Categories</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-display font-bold text-foreground">
                  AI
                </div>
                <div className="text-sm text-foreground-muted">Powered</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Categories Section */}
      <section className="py-16 sm:py-24 bg-background-warm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground">
              Explore by Genre
            </h2>
            <p className="mt-4 text-foreground-muted max-w-xl mx-auto">
              Dive into curated collections across your favorite genres
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {featuredCategories.map((category, index) => (
              <Link
                key={category.slug}
                href={`/category/${category.slug}`}
                className={cn(
                  "group relative overflow-hidden rounded-2xl p-6 sm:p-8",
                  "bg-card border border-border/50 shadow-card",
                  "transition-all duration-300",
                  "hover:shadow-book hover:-translate-y-1 hover:border-primary/20",
                  "animate-fade-up"
                )}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                {/* Gradient background on hover */}
                <div
                  className={cn(
                    "absolute inset-0 opacity-0 group-hover:opacity-5 transition-opacity duration-300",
                    "bg-gradient-to-br",
                    category.gradient
                  )}
                />

                <div className="relative flex items-center gap-4">
                  <span className="text-4xl">{category.icon}</span>
                  <div>
                    <h3 className="font-display text-xl font-semibold text-foreground group-hover:text-primary transition-colors">
                      {formatCategoryName(category.slug)}
                    </h3>
                    <p className="text-sm text-foreground-muted mt-1">
                      Browse collection &rarr;
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          <div className="mt-8 text-center">
            <Button asChild variant="outline">
              <Link href="/categories">
                <Library className="h-4 w-4 mr-2" />
                View All Categories
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* For You Preview Section */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Suspense
            fallback={
              <div className="space-y-6">
                <div className="flex items-end justify-between">
                  <div>
                    <div className="h-8 w-48 bg-muted rounded animate-pulse" />
                    <div className="h-4 w-64 bg-muted rounded animate-pulse mt-2" />
                  </div>
                </div>
                <BookGridSkeleton count={6} />
              </div>
            }
          >
            <RecommendationsPreview />
          </Suspense>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 sm:py-24 bg-background-warm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground">
              How It Works
            </h2>
            <p className="mt-4 text-foreground-muted max-w-xl mx-auto">
              Getting personalized recommendations is simple
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {features.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <div
                  key={feature.title}
                  className={cn(
                    "relative rounded-2xl p-6",
                    "bg-card border border-border/50 shadow-card",
                    "animate-fade-up"
                  )}
                  style={{ animationDelay: `${index * 100}ms` }}
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary mb-4">
                    <Icon className="h-6 w-6" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-foreground">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm text-foreground-muted leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary to-primary-hover p-8 sm:p-12 lg:p-16">
            {/* Decorative elements */}
            <div className="absolute top-0 right-0 -translate-y-1/4 translate-x-1/4 w-64 h-64 bg-white/10 rounded-full blur-3xl" />
            <div className="absolute bottom-0 left-0 translate-y-1/4 -translate-x-1/4 w-64 h-64 bg-white/10 rounded-full blur-3xl" />

            <div className="relative text-center">
              <BookOpen className="h-12 w-12 mx-auto text-primary-foreground/80 mb-6" />
              <h2 className="font-display text-3xl sm:text-4xl font-bold text-primary-foreground">
                Ready to Find Your Next Read?
              </h2>
              <p className="mt-4 text-lg text-primary-foreground/80 max-w-xl mx-auto">
                Start exploring personalized recommendations tailored just for
                you.
              </p>
              <Button
                asChild
                size="xl"
                variant="secondary"
                className="mt-8 bg-white text-primary hover:bg-white/90"
              >
                <Link href="/recommendations">
                  Get Started
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// Server component for recommendations preview
async function RecommendationsPreview() {
  const recommendations = await getHomeRecommendations();

  if (recommendations.length === 0) {
    return (
      <div className="text-center py-12">
        <TrendingUp className="h-12 w-12 mx-auto text-foreground-muted mb-4" />
        <h3 className="font-display text-xl font-semibold text-foreground">
          Import Your Reading History
        </h3>
        <p className="mt-2 text-foreground-muted max-w-md mx-auto">
          Connect your Goodreads or Kindle library to see personalized
          recommendations here.
        </p>
        <Button asChild className="mt-6">
          <Link href="/recommendations">Learn How</Link>
        </Button>
      </div>
    );
  }

  return (
    <BookRow
      recommendations={recommendations}
      title="Recommended For You"
      subtitle="Based on your reading history"
      seeAllHref="/recommendations"
    />
  );
}
