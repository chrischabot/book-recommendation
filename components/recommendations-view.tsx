"use client";

import { useState } from "react";
import { BookGrid, FeaturedBookSection } from "@/components/book-grid";
import { BookListView } from "@/components/book-list";
import { ViewToggle, type ViewMode } from "@/components/view-toggle";
import { Pagination, PageInfo } from "@/components/pagination";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

interface RecommendationsViewProps {
  recommendations: ExplainedRecommendation[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function RecommendationsView({
  recommendations,
  page,
  pageSize,
  total,
  totalPages,
}: RecommendationsViewProps) {
  const [view, setView] = useState<ViewMode>("list");

  const featured = page === 1 ? recommendations[0] : null;
  const regularRecs = page === 1 ? recommendations.slice(1) : recommendations;

  return (
    <div className="space-y-8">
      {/* Controls */}
      <div className="flex items-center justify-between animate-fade-in">
        <PageInfo
          currentPage={page}
          pageSize={pageSize}
          totalItems={total}
        />
        <ViewToggle view={view} onViewChange={setView} />
      </div>

      {/* Featured book (first page only, grid view only) */}
      {featured && view === "grid" && (
        <div className="animate-fade-up">
          <FeaturedBookSection
            recommendation={featured}
            title="Top Pick For You"
          />
        </div>
      )}

      {/* Divider (grid view with featured) */}
      {featured && view === "grid" && (
        <div className="relative py-4">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background px-4 text-sm text-foreground-muted">
              More Recommendations
            </span>
          </div>
        </div>
      )}

      {/* Books display */}
      {view === "grid" ? (
        <BookGrid recommendations={regularRecs} />
      ) : (
        <BookListView
          recommendations={page === 1 ? recommendations : regularRecs}
        />
      )}

      {/* Pagination */}
      <div className="pt-8 border-t border-border">
        <Pagination currentPage={page} totalPages={totalPages} />
      </div>
    </div>
  );
}
