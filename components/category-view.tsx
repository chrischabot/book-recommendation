"use client";

import { useState } from "react";
import { BookGrid } from "@/components/book-grid";
import { BookListView } from "@/components/book-list";
import { ViewToggle, type ViewMode } from "@/components/view-toggle";
import { Pagination, PageInfo } from "@/components/pagination";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

interface CategoryViewProps {
  recommendations: ExplainedRecommendation[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function CategoryView({
  recommendations,
  page,
  pageSize,
  total,
  totalPages,
}: CategoryViewProps) {
  const [view, setView] = useState<ViewMode>("list");

  return (
    <div className="space-y-8">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <PageInfo
          currentPage={page}
          pageSize={pageSize}
          totalItems={total}
        />
        <ViewToggle view={view} onViewChange={setView} />
      </div>

      {/* Books display */}
      {view === "grid" ? (
        <BookGrid recommendations={recommendations} />
      ) : (
        <BookListView recommendations={recommendations} />
      )}

      {/* Pagination */}
      <div className="pt-6 border-t border-border">
        <Pagination currentPage={page} totalPages={totalPages} />
      </div>
    </div>
  );
}
