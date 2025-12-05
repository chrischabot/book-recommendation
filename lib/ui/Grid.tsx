"use client";

import type { ExplainedRecommendation } from "@/lib/recs/explain";
import { RecommendationCard } from "./RecommendationCard";

interface GridProps {
  recommendations: ExplainedRecommendation[];
  loading?: boolean;
  showDescriptions?: boolean;
}

export function RecommendationGrid({
  recommendations,
  loading = false,
  showDescriptions = true,
}: GridProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (recommendations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <BookIcon className="h-12 w-12 text-gray-300" />
        <h3 className="mt-4 text-lg font-medium text-gray-900">No recommendations</h3>
        <p className="mt-2 text-sm text-gray-600">
          Import your reading history to get personalized recommendations.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {recommendations.map((rec) => (
        <RecommendationCard
          key={rec.workId}
          recommendation={rec}
          showDescription={showDescriptions}
        />
      ))}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="animate-pulse overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="aspect-[2/3] bg-gray-200" />
      <div className="p-4">
        <div className="h-4 w-3/4 rounded bg-gray-200" />
        <div className="mt-2 h-3 w-1/2 rounded bg-gray-200" />
        <div className="mt-3 space-y-2">
          <div className="h-2 rounded bg-gray-200" />
          <div className="h-2 w-5/6 rounded bg-gray-200" />
        </div>
      </div>
    </div>
  );
}

function BookIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
      />
    </svg>
  );
}

// Horizontal scroll variant for "More like this" sections
export function RecommendationRow({
  recommendations,
  title,
  seeAllHref,
}: {
  recommendations: ExplainedRecommendation[];
  title: string;
  seeAllHref?: string;
}) {
  return (
    <section className="py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {seeAllHref && (
          <a
            href={seeAllHref}
            className="text-sm font-medium text-blue-600 hover:text-blue-800"
          >
            See all
          </a>
        )}
      </div>
      <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-thin scrollbar-track-gray-100 scrollbar-thumb-gray-300">
        {recommendations.map((rec) => (
          <div key={rec.workId} className="w-40 flex-shrink-0">
            <RecommendationCard recommendation={rec} showDescription={false} />
          </div>
        ))}
      </div>
    </section>
  );
}
