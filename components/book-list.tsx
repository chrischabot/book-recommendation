"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Clock, BookOpen } from "lucide-react";
import { cn, formatHours } from "@/lib/utils";
import { MarkdownDescription } from "@/components/ui/markdown-description";
import { BookCoverPlaceholder } from "@/components/ui/book-cover-placeholder";
import { QualityBadge } from "@/components/ui/badge";
import { StarRating } from "@/components/ui/star-rating";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

interface BookListItemProps {
  recommendation: ExplainedRecommendation;
  className?: string;
}

export function BookListItem({ recommendation, className }: BookListItemProps) {
  const [imageError, setImageError] = useState(false);

  const {
    workId,
    title,
    authors,
    year,
    description,
    coverUrl,
    avgRating,
    ratingCount,
    reasons,
    suggestionQuality,
    totalMs,
  } = recommendation;

  const hasCover = coverUrl && !imageError;
  const displayAuthors = authors?.join(", ") || "Unknown Author";
  const hoursRead = totalMs ? totalMs / 3_600_000 : 0;

  return (
    <Link
      href={`/book/${workId}`}
      className={cn(
        "group flex gap-4 sm:gap-6 p-4 rounded-xl",
        "bg-card border border-border/50",
        "transition-all duration-300",
        "hover:shadow-card hover:border-primary/20 hover:bg-card-hover",
        className
      )}
    >
      {/* Cover Image */}
      <div className="relative shrink-0 w-20 sm:w-28 md:w-32">
        <div
          className={cn(
            "relative aspect-[2/3] overflow-hidden rounded-lg",
            "bg-muted shadow-book",
            "transition-transform duration-300 group-hover:scale-[1.02]"
          )}
        >
          {hasCover ? (
            <Image
              src={coverUrl}
              alt={`Cover of ${title}`}
              fill
              className="object-cover"
              sizes="(max-width: 640px) 80px, (max-width: 768px) 112px, 128px"
              onError={() => setImageError(true)}
              onLoad={(e) => {
                const img = e.currentTarget as HTMLImageElement;
                if (img.naturalWidth <= 1 || img.naturalHeight <= 1) {
                  setImageError(true);
                }
              }}
            />
          ) : (
            <BookCoverPlaceholder title={title} author={displayAuthors} />
          )}
          {/* Page edge effect */}
          <div className="absolute inset-y-0 right-0 w-[3px] bg-gradient-to-l from-black/15 to-transparent" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Title */}
            <h3 className="font-display text-lg sm:text-xl font-semibold text-foreground leading-tight group-hover:text-primary transition-colors line-clamp-2">
              {title}
            </h3>

            {/* Author and Year */}
            <p className="mt-1 text-sm text-foreground-muted line-clamp-1">
              by <span className="text-foreground">{displayAuthors}</span>
              {year && <span className="text-foreground-subtle"> ({year})</span>}
            </p>
          </div>

          {/* Quality Badge */}
          {suggestionQuality && (
            <QualityBadge quality={suggestionQuality} className="shrink-0" />
          )}
        </div>

        {/* Rating and Reading Time */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {avgRating !== undefined && avgRating !== null && (
            <StarRating
              rating={avgRating}
              size="sm"
              count={ratingCount ?? undefined}
            />
          )}
          {hoursRead > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-foreground-muted">
              <Clock className="h-3.5 w-3.5" />
              <span>{formatHours(hoursRead)} read</span>
            </div>
          )}
        </div>

        {/* Description */}
        {description && (
          <div className="mt-3">
            <MarkdownDescription size="sm" lineClamp={3}>
              {description}
            </MarkdownDescription>
          </div>
        )}

        {/* Reasons */}
        {reasons && reasons.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {reasons.slice(0, 2).map((reason, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 text-xs text-primary bg-primary/10 rounded-full px-2.5 py-1"
              >
                <BookOpen className="h-3 w-3" />
                <span className="line-clamp-1">{reason}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

interface BookListViewProps {
  recommendations: ExplainedRecommendation[];
  className?: string;
}

export function BookListView({ recommendations, className }: BookListViewProps) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {recommendations.map((rec, index) => (
        <div
          key={rec.workId}
          className="animate-fade-up"
          style={{ animationDelay: `${index * 50}ms` }}
        >
          <BookListItem recommendation={rec} />
        </div>
      ))}
    </div>
  );
}
