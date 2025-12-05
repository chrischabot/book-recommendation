"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Clock, BookOpen, ChevronDown, Sparkles } from "lucide-react";
import { cn, formatCount, formatHours } from "@/lib/utils";
import { QualityBadge } from "@/components/ui/badge";
import { InlineRating } from "@/components/ui/star-rating";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MarkdownDescription } from "@/components/ui/markdown-description";
import { BookCoverPlaceholder } from "@/components/ui/book-cover-placeholder";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

type SuggestionQuality = "A+" | "A" | "A-" | "B+" | "B" | "B-";

interface BookCardProps {
  recommendation: ExplainedRecommendation;
  priority?: boolean;
  showDescription?: boolean;
  index?: number;
}

export function BookCard({
  recommendation,
  priority = false,
  showDescription = true,
  index = 0,
}: BookCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const {
    workId,
    title,
    authors,
    year,
    avgRating,
    ratingCount,
    suggestionQuality,
    confidence,
    reasons,
    description,
    coverUrl,
    totalMs,
    lastReadAt,
    popularity,
  } = recommendation;

  const hasCover = coverUrl && !imageError;
  const hoursRead = totalMs ? totalMs / 3_600_000 : 0;
  const authorString = authors.length > 0 ? authors.join(", ") : undefined;
  const lastReadLabel = lastReadAt
    ? new Date(lastReadAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.5,
        delay: index * 0.05,
        ease: [0.25, 0.46, 0.45, 0.94],
      }}
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
      className="group relative"
    >
      <div
        className={cn(
          "relative overflow-hidden rounded-xl bg-card",
          "border border-border/50",
          "shadow-card transition-all duration-300 ease-book",
          "hover:shadow-book-hover hover:-translate-y-2",
          "hover:border-primary/20"
        )}
      >
        {/* Book spine accent on hover */}
        <motion.div
          className="absolute left-0 inset-y-0 w-1 bg-gradient-to-b from-primary via-primary to-primary/60 z-10"
          initial={{ scaleX: 0, originX: 0 }}
          animate={{ scaleX: isHovered ? 1 : 0 }}
          transition={{ duration: 0.3 }}
        />

        {/* Cover Image */}
        <Link
          href={`/book/${workId}`}
          className="block relative overflow-hidden"
        >
          <div className="aspect-[2/3] relative bg-muted">
            {hasCover ? (
              <Image
                src={coverUrl}
                alt={`Cover of ${title}`}
                fill
                className={cn(
                  "object-cover transition-transform duration-500",
                  isHovered && "scale-105"
                )}
                onError={() => setImageError(true)}
                onLoad={(e) => {
                  // OL returns 1x1 transparent pixel for missing covers
                  const img = e.currentTarget as HTMLImageElement;
                  if (img.naturalWidth <= 1 || img.naturalHeight <= 1) {
                    setImageError(true);
                  }
                }}
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                priority={priority}
              />
            ) : (
              <BookCoverPlaceholder title={title} author={authorString} />
            )}

            {/* Page edge effect */}
            <div className="absolute inset-y-0 right-0 w-[3px] bg-gradient-to-l from-black/10 to-transparent z-10" />

            {/* Hover gradient overlay */}
            <motion.div
              className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-white/5"
              initial={{ opacity: 0 }}
              animate={{ opacity: isHovered ? 1 : 0 }}
              transition={{ duration: 0.3 }}
            />

            {/* Quality Badge */}
            <div className="absolute top-3 right-3 z-20">
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.2 + index * 0.05 }}
              >
                <QualityBadge
                  quality={suggestionQuality as SuggestionQuality}
                  confidence={confidence}
                  className="shadow-lg backdrop-blur-sm"
                />
              </motion.div>
            </div>

            {/* Reading time badge - shown if user has engagement data */}
            {hoursRead > 0 && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="absolute bottom-3 left-3 z-20">
                      <motion.div
                        initial={{ y: 10, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        transition={{ delay: 0.3 + index * 0.05 }}
                        className={cn(
                          "flex items-center gap-1.5 rounded-full px-2.5 py-1",
                          "bg-card/90 backdrop-blur-sm shadow-sm",
                          "text-xs font-medium text-foreground"
                        )}
                      >
                        <Clock className="h-3 w-3 text-primary" />
                        {formatHours(hoursRead)}
                      </motion.div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p>
                      {formatHours(hoursRead)} reading time
                      {lastReadLabel && ` (last: ${lastReadLabel})`}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </Link>

        {/* Content */}
        <div className="p-4 space-y-3">
          {/* Title */}
          <Link href={`/book/${workId}`} className="block group/title">
            <h3
              className={cn(
                "font-display text-base font-semibold leading-tight",
                "text-foreground line-clamp-2",
                "group-hover/title:text-primary transition-colors duration-200"
              )}
            >
              {title}
            </h3>
          </Link>

          {/* Authors */}
          <p className="text-sm text-foreground-muted line-clamp-1 font-medium">
            {authors.length > 0 ? authors.join(", ") : "Unknown Author"}
          </p>

          {/* Metadata row */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            {year && (
              <span className="text-foreground-subtle tabular-nums">{year}</span>
            )}

            {avgRating !== undefined && avgRating !== null && (
              <InlineRating rating={avgRating} count={ratingCount ?? undefined} />
            )}

            {popularity && popularity.readCount > 0 && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 text-foreground-subtle">
                      <BookOpen className="h-3 w-3 text-secondary" />
                      {formatCount(popularity.readCount)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{formatCount(popularity.readCount)} readers</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {/* Reasons */}
          <div className="space-y-1.5 pt-1">
            {reasons.slice(0, 2).map((reason, i) => (
              <p
                key={i}
                className={cn(
                  "text-xs leading-relaxed text-foreground-muted",
                  "flex items-start gap-2"
                )}
              >
                <Sparkles className="h-3 w-3 mt-0.5 flex-shrink-0 text-primary/60" />
                <span className="line-clamp-2">{reason}</span>
              </p>
            ))}
          </div>

          {/* Expandable description */}
          {showDescription && description && (
            <div className="pt-2">
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className={cn(
                  "flex items-center gap-1 text-xs font-medium",
                  "text-primary hover:text-primary-hover transition-colors"
                )}
              >
                {isExpanded ? "Show less" : "Show more"}
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform duration-200",
                    isExpanded && "rotate-180"
                  )}
                />
              </button>

              <motion.div
                initial={false}
                animate={{
                  height: isExpanded ? "auto" : 0,
                  opacity: isExpanded ? 1 : 0,
                }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                <div className="pt-2">
                  <MarkdownDescription size="sm" lineClamp={4}>
                    {description}
                  </MarkdownDescription>
                </div>
              </motion.div>
            </div>
          )}
        </div>

        {/* Bottom accent line on hover */}
        <motion.div
          className="absolute bottom-0 inset-x-0 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: isHovered ? 1 : 0 }}
          transition={{ duration: 0.3 }}
        />
      </div>
    </motion.article>
  );
}

// Compact card variant for horizontal rows and sidebars
export function BookCardCompact({
  recommendation,
  index = 0,
}: {
  recommendation: ExplainedRecommendation;
  index?: number;
}) {
  const [imageError, setImageError] = useState(false);
  const { workId, title, authors, avgRating, suggestionQuality, coverUrl } =
    recommendation;

  const hasCover = coverUrl && !imageError;
  const authorString = authors.length > 0 ? authors.join(", ") : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05, duration: 0.4 }}
    >
      <Link
        href={`/book/${workId}`}
        className={cn(
          "flex gap-3 rounded-lg p-2.5",
          "transition-all duration-200",
          "hover:bg-muted/50 group"
        )}
      >
        {/* Mini cover */}
        <div className="relative h-20 w-14 flex-shrink-0 overflow-hidden rounded-md bg-muted shadow-sm">
          {hasCover ? (
            <Image
              src={coverUrl}
              alt={title}
              fill
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              onError={() => setImageError(true)}
              onLoad={(e) => {
                const img = e.currentTarget as HTMLImageElement;
                if (img.naturalWidth <= 1 || img.naturalHeight <= 1) {
                  setImageError(true);
                }
              }}
              sizes="56px"
            />
          ) : (
            <BookCoverPlaceholder title={title} author={authorString} />
          )}
          {/* Page edge */}
          <div className="absolute inset-y-0 right-0 w-[2px] bg-gradient-to-l from-black/10 to-transparent" />
        </div>

        {/* Info */}
        <div className="flex-1 overflow-hidden py-0.5">
          <h4 className="font-display font-semibold text-sm text-foreground truncate group-hover:text-primary transition-colors">
            {title}
          </h4>
          <p className="text-xs text-foreground-muted truncate mt-0.5">
            {authors.join(", ")}
          </p>
          <div className="flex items-center gap-2 mt-2">
            <QualityBadge
              quality={suggestionQuality as SuggestionQuality}
              className="text-[10px] px-2 py-0.5"
            />
            {avgRating !== undefined && avgRating !== null && (
              <InlineRating rating={avgRating} className="text-xs" />
            )}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

// Featured book card for hero sections
export function BookCardFeatured({
  recommendation,
  className,
}: {
  recommendation: ExplainedRecommendation;
  className?: string;
}) {
  const [imageError, setImageError] = useState(false);
  const {
    workId,
    title,
    authors,
    year,
    avgRating,
    ratingCount,
    suggestionQuality,
    reasons,
    description,
    coverUrl,
  } = recommendation;

  const hasCover = coverUrl && !imageError;
  const authorString = authors.length > 0 ? authors.join(", ") : undefined;

  return (
    <motion.article
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}
      className={cn(
        "group relative overflow-hidden rounded-2xl",
        "bg-card border border-border/50 shadow-book",
        "hover:shadow-book-hover transition-shadow duration-500",
        className
      )}
    >
      <div className="grid md:grid-cols-2 gap-0">
        {/* Cover side */}
        <Link
          href={`/book/${workId}`}
          className="relative aspect-[3/4] md:aspect-auto overflow-hidden"
        >
          {hasCover ? (
            <Image
              src={coverUrl}
              alt={`Cover of ${title}`}
              fill
              className="object-cover transition-transform duration-700 group-hover:scale-105"
              onError={() => setImageError(true)}
              onLoad={(e) => {
                const img = e.currentTarget as HTMLImageElement;
                if (img.naturalWidth <= 1 || img.naturalHeight <= 1) {
                  setImageError(true);
                }
              }}
              sizes="(max-width: 768px) 100vw, 50vw"
              priority
            />
          ) : (
            <BookCoverPlaceholder title={title} author={authorString} />
          )}
          {/* Gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent md:bg-gradient-to-r" />

          {/* Quality badge */}
          <div className="absolute top-4 right-4">
            <QualityBadge
              quality={suggestionQuality as SuggestionQuality}
              className="text-sm px-3 py-1 shadow-lg"
            />
          </div>
        </Link>

        {/* Content side */}
        <div className="p-6 md:p-8 lg:p-10 flex flex-col justify-center">
          <div className="space-y-4">
            <div>
              {year && (
                <span className="text-sm text-foreground-subtle font-medium">
                  {year}
                </span>
              )}
              <Link href={`/book/${workId}`}>
                <h2 className="font-display text-2xl md:text-3xl lg:text-4xl font-bold text-foreground mt-1 hover:text-primary transition-colors">
                  {title}
                </h2>
              </Link>
              <p className="text-lg text-foreground-muted mt-2 font-serif italic">
                by {authors.length > 0 ? authors.join(", ") : "Unknown Author"}
              </p>
            </div>

            {avgRating !== undefined && avgRating !== null && (
              <InlineRating
                rating={avgRating}
                count={ratingCount ?? undefined}
                className="text-base"
              />
            )}

            {description && (
              <MarkdownDescription lineClamp={3}>
                {description}
              </MarkdownDescription>
            )}

            {reasons.length > 0 && (
              <div className="space-y-2 pt-2">
                {reasons.slice(0, 2).map((reason, i) => (
                  <p
                    key={i}
                    className="flex items-start gap-2 text-sm text-foreground-muted"
                  >
                    <Sparkles className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary" />
                    <span>{reason}</span>
                  </p>
                ))}
              </div>
            )}

            <Link
              href={`/book/${workId}`}
              className={cn(
                "inline-flex items-center gap-2 mt-4",
                "text-primary font-medium hover:text-primary-hover",
                "transition-colors group/link"
              )}
            >
              View details
              <motion.span
                className="inline-block"
                initial={{ x: 0 }}
                whileHover={{ x: 4 }}
              >
                &rarr;
              </motion.span>
            </Link>
          </div>
        </div>
      </div>
    </motion.article>
  );
}
