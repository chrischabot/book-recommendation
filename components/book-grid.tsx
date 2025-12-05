"use client";

import { motion } from "motion/react";
import { BookCard, BookCardCompact, BookCardFeatured } from "@/components/book-card";
import { cn } from "@/lib/utils";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

interface BookGridProps {
  recommendations: ExplainedRecommendation[];
  className?: string;
  showDescription?: boolean;
}

export function BookGrid({
  recommendations,
  className,
  showDescription = true,
}: BookGridProps) {
  if (recommendations.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-foreground-muted">No recommendations found</p>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className={cn(
        "grid gap-6",
        "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
        className
      )}
    >
      {recommendations.map((rec, index) => (
        <BookCard
          key={rec.workId}
          recommendation={rec}
          index={index}
          priority={index < 6}
          showDescription={showDescription}
        />
      ))}
    </motion.div>
  );
}

// Horizontal scrolling row of books
interface BookRowProps {
  recommendations: ExplainedRecommendation[];
  title?: string;
  subtitle?: string;
  seeAllHref?: string;
  className?: string;
}

export function BookRow({
  recommendations,
  title,
  subtitle,
  seeAllHref,
  className,
}: BookRowProps) {
  if (recommendations.length === 0) return null;

  return (
    <section className={cn("space-y-4", className)}>
      {(title || seeAllHref) && (
        <div className="flex items-end justify-between">
          <div>
            {title && (
              <h2 className="font-display text-2xl font-bold text-foreground">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-1 text-foreground-muted">{subtitle}</p>
            )}
          </div>
          {seeAllHref && (
            <a
              href={seeAllHref}
              className="text-sm font-medium text-primary hover:text-primary-hover transition-colors"
            >
              See all &rarr;
            </a>
          )}
        </div>
      )}

      <div className="relative -mx-4 px-4">
        <div
          className={cn(
            "flex gap-4 overflow-x-auto pb-4",
            "scrollbar-thin snap-x snap-mandatory"
          )}
        >
          {recommendations.map((rec, index) => (
            <motion.div
              key={rec.workId}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05, duration: 0.4 }}
              className="w-[180px] sm:w-[200px] flex-shrink-0 snap-start"
            >
              <BookCard
                recommendation={rec}
                index={index}
                showDescription={false}
              />
            </motion.div>
          ))}
        </div>

        {/* Fade edges */}
        <div className="absolute left-0 top-0 bottom-4 w-4 bg-gradient-to-r from-background to-transparent pointer-events-none" />
        <div className="absolute right-0 top-0 bottom-4 w-4 bg-gradient-to-l from-background to-transparent pointer-events-none" />
      </div>
    </section>
  );
}

// Featured section with one large card
interface FeaturedBookSectionProps {
  recommendation: ExplainedRecommendation;
  title?: string;
  className?: string;
}

export function FeaturedBookSection({
  recommendation,
  title,
  className,
}: FeaturedBookSectionProps) {
  return (
    <section className={cn("space-y-6", className)}>
      {title && (
        <div className="text-center">
          <h2 className="font-display text-3xl font-bold text-foreground">
            {title}
          </h2>
        </div>
      )}
      <BookCardFeatured recommendation={recommendation} />
    </section>
  );
}

// Compact list for sidebars
interface BookListProps {
  recommendations: ExplainedRecommendation[];
  title?: string;
  className?: string;
}

export function BookList({ recommendations, title, className }: BookListProps) {
  if (recommendations.length === 0) return null;

  return (
    <div className={cn("space-y-2", className)}>
      {title && (
        <h3 className="font-display text-lg font-semibold text-foreground px-2">
          {title}
        </h3>
      )}
      <div className="space-y-1">
        {recommendations.map((rec, index) => (
          <BookCardCompact key={rec.workId} recommendation={rec} index={index} />
        ))}
      </div>
    </div>
  );
}

// Masonry-style grid with varying sizes
interface BookMasonryProps {
  recommendations: ExplainedRecommendation[];
  className?: string;
}

export function BookMasonry({ recommendations, className }: BookMasonryProps) {
  if (recommendations.length === 0) return null;

  // Split recommendations for masonry layout
  const featured = recommendations[0];
  const regular = recommendations.slice(1);

  return (
    <div className={cn("space-y-6", className)}>
      {/* Featured book at top */}
      {featured && (
        <BookCardFeatured recommendation={featured} className="mb-8" />
      )}

      {/* Regular grid */}
      <BookGrid recommendations={regular} />
    </div>
  );
}
