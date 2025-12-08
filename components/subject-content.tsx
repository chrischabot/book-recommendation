"use client";

import { useState } from "react";
import Link from "next/link";
import { Library } from "lucide-react";
import { BookGrid } from "@/components/book-grid";
import { BookListView } from "@/components/book-list";
import { ViewToggle, type ViewMode } from "@/components/view-toggle";
import { Pagination, PageInfo } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import type { ExplainedRecommendation } from "@/lib/recs/explain";

interface SubjectContentClientProps {
  recommendations: ExplainedRecommendation[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function SubjectContentClient({
  recommendations,
  page,
  pageSize,
  total,
  totalPages,
}: SubjectContentClientProps) {
  // Default to list view as requested
  const [view, setView] = useState<ViewMode>("list");

  if (recommendations.length === 0) {
    return (
      <div className="text-center py-16 bg-muted/30 rounded-2xl">
        <Library className="h-12 w-12 mx-auto text-foreground-muted mb-4" />
        <h2 className="font-display text-xl font-semibold text-foreground">
          No Books Found
        </h2>
        <p className="mt-2 text-foreground-muted max-w-md mx-auto">
          We don't have any books with this subject yet.
        </p>
        <Button asChild className="mt-6">
          <Link href="/recommendations">Browse Recommendations</Link>
        </Button>
      </div>
    );
  }

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
      {totalPages > 1 && (
        <div className="pt-6 border-t border-border">
          <Pagination currentPage={page} totalPages={totalPages} />
        </div>
      )}
    </div>
  );
}
