"use client";

import { useState } from "react";
import Link from "next/link";
import { Dna, ChevronRight } from "lucide-react";
import { BookGrid, FeaturedBookSection } from "@/components/book-grid";
import { BookListView } from "@/components/book-list";
import { ViewToggle, type ViewMode } from "@/components/view-toggle";
import { Pagination, PageInfo } from "@/components/pagination";
import type { ExplainedRecommendation } from "@/lib/recs/explain";
import { cn } from "@/lib/utils";

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
      {/* Profile Link (first page only) */}
      {page === 1 && (
        <Link
          href="/profile"
          className={cn(
            "flex items-center gap-3 p-4 rounded-xl",
            "bg-card/50 border border-border/50",
            "hover:bg-card hover:border-border transition-colors",
            "animate-fade-in group"
          )}
        >
          <div className="p-2.5 rounded-lg bg-primary/10">
            <Dna className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-foreground group-hover:text-primary transition-colors">
              Your Reading DNA
            </h3>
            <p className="text-sm text-foreground-muted">
              View and manage the books that shape your recommendations
            </p>
          </div>
          <ChevronRight className="h-5 w-5 text-foreground-muted group-hover:text-primary transition-colors" />
        </Link>
      )}

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
