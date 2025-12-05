"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { ExplainedRecommendation } from "@/lib/recs/explain";
import { BookCoverPlaceholder } from "@/components/ui/book-cover-placeholder";

type SuggestionQuality = "A+" | "A" | "A-" | "B+" | "B" | "B-";

const qualityColors: Record<SuggestionQuality, string> = {
  "A+": "bg-emerald-500 text-white",
  "A": "bg-emerald-400 text-white",
  "A-": "bg-green-400 text-white",
  "B+": "bg-blue-400 text-white",
  "B": "bg-blue-300 text-gray-800",
  "B-": "bg-gray-300 text-gray-800",
};

interface RecommendationCardProps {
  recommendation: ExplainedRecommendation;
  showDescription?: boolean;
}

export function RecommendationCard({
  recommendation,
  showDescription = true,
}: RecommendationCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [imageError, setImageError] = useState(false);

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
  } = recommendation;

  const hasCover = coverUrl && !imageError;
  const authorString = authors.length > 0 ? authors.join(", ") : undefined;
  const hoursRead = totalMs ? totalMs / 3_600_000 : 0;
  const lastReadLabel = lastReadAt ? new Date(lastReadAt).toISOString().slice(0, 10) : null;

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      {/* Cover Image */}
      <Link href={`/book/${workId}`} className="relative aspect-[2/3] w-full overflow-hidden bg-gray-100">
        {hasCover ? (
          <Image
            src={coverUrl}
            alt={`Cover of ${title}`}
            fill
            className="object-cover transition-transform group-hover:scale-105"
            onError={() => setImageError(true)}
            onLoad={(e) => {
              const img = e.currentTarget as HTMLImageElement;
              if (img.naturalWidth <= 1 || img.naturalHeight <= 1) {
                setImageError(true);
              }
            }}
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
          />
        ) : (
          <BookCoverPlaceholder title={title} author={authorString} />
        )}

        {/* Quality Badge */}
        <div
          className={`absolute right-2 top-2 rounded-full px-2 py-0.5 text-xs font-semibold ${qualityColors[suggestionQuality]}`}
          title={`Match confidence: ${(confidence * 100).toFixed(0)}%`}
        >
          {suggestionQuality}
        </div>
      </Link>

      {/* Content */}
      <div className="flex flex-1 flex-col p-4">
        {/* Title */}
        <Link href={`/book/${workId}`}>
          <h3 className="line-clamp-2 text-sm font-semibold text-gray-900 hover:text-blue-600">
            {title}
          </h3>
        </Link>

        {/* Authors */}
        <p className="mt-1 line-clamp-1 text-xs text-gray-600">
          {authors.length > 0 ? authors.join(", ") : "Unknown Author"}
        </p>

        {/* Year, Rating, and Popularity */}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          {year && <span>{year}</span>}
          {avgRating && (
            <span className="flex items-center gap-1">
              <StarIcon className="h-3 w-3 text-yellow-400" />
              {avgRating.toFixed(1)}
              {ratingCount && (
                <span className="text-gray-400">
                  ({formatCount(ratingCount)})
                </span>
              )}
            </span>
          )}
          {hoursRead > 0 && (
            <span
              className="flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700"
              title={lastReadLabel ? `Last read on ${lastReadLabel}` : "Recent Kindle reading time"}
            >
              <ClockIcon className="h-3 w-3" />
              {formatHours(hoursRead)}
            </span>
          )}
          {recommendation.popularity && recommendation.popularity.readCount > 0 && (
            <span
              className="flex items-center gap-1"
              title={`${formatCount(recommendation.popularity.readCount)} readers`}
            >
              <BookIcon className="h-3 w-3 text-green-500" />
              {formatCount(recommendation.popularity.readCount)}
            </span>
          )}
        </div>

        {/* Reasons */}
        <ul className="mt-3 space-y-1">
          {reasons.slice(0, 2).map((reason, index) => (
            <li key={index} className="text-xs text-gray-600">
              <span className="mr-1 text-blue-500">•</span>
              {reason}
            </li>
          ))}
        </ul>

        {/* Description (Expandable) */}
        {showDescription && description && (
          <div className="mt-3">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs font-medium text-blue-600 hover:text-blue-800"
            >
              {isExpanded ? "Show less" : "Show more"}
            </button>
            {isExpanded && (
              <p className="mt-2 text-xs text-gray-600 line-clamp-4">
                {description}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

function formatHours(hours: number): string {
  if (hours >= 10) return `${hours.toFixed(0)}h`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.max(hours * 60, 1).toFixed(0)}m`;
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="currentColor"
      viewBox="0 0 20 20"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
    </svg>
  );
}

function BookIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
      />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

// Compact card variant for sidebar/list views
export function RecommendationCardCompact({
  recommendation,
}: {
  recommendation: ExplainedRecommendation;
}) {
  const { workId, title, authors, avgRating, suggestionQuality, coverUrl } = recommendation;
  const [imageError, setImageError] = useState(false);

  const hasCover = coverUrl && !imageError;
  const authorString = authors.length > 0 ? authors.join(", ") : undefined;

  return (
    <Link
      href={`/book/${workId}`}
      className="flex gap-3 rounded-lg p-2 transition-colors hover:bg-gray-50"
    >
      <div className="relative h-16 w-11 flex-shrink-0 overflow-hidden rounded bg-gray-100">
        {hasCover ? (
          <Image
            src={coverUrl}
            alt={title}
            fill
            className="object-cover"
            onError={() => setImageError(true)}
            onLoad={(e) => {
              const img = e.currentTarget as HTMLImageElement;
              if (img.naturalWidth <= 1 || img.naturalHeight <= 1) {
                setImageError(true);
              }
            }}
            sizes="44px"
          />
        ) : (
          <BookCoverPlaceholder title={title} author={authorString} />
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        <h4 className="truncate text-sm font-medium text-gray-900">{title}</h4>
        <p className="truncate text-xs text-gray-600">{authors.join(", ")}</p>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${qualityColors[suggestionQuality]}`}
          >
            {suggestionQuality}
          </span>
          {avgRating && (
            <span className="flex items-center gap-0.5 text-xs text-gray-500">
              <StarIcon className="h-3 w-3 text-yellow-400" />
              {avgRating.toFixed(1)}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
