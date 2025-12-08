"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, AnimatePresence } from "motion/react";
import {
  Star,
  RefreshCw,
  Flame,
  Clock,
  Heart,
  Zap,
  DollarSign,
  AlertCircle,
  RefreshCcw,
  Trash2,
  Plus,
  BookOpen,
  User,
  Tag,
  Loader2,
  Dna,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import type { Anchor, EngagementSignals } from "@/lib/features/userProfile";

interface TasteProfileData {
  userId: string;
  anchors: Anchor[];
  summary: {
    topAuthors: string[];
    topSubjects: string[];
    readCount: number;
    avgRating: number | null;
  };
}

type ProfileError = {
  type: "not_found" | "server_error" | "network_error";
  message: string;
  details?: string;
};

const signalConfig: Record<
  keyof EngagementSignals,
  { icon: typeof Star; label: string; color: string; bgColor: string; description: string }
> = {
  fiveStar: {
    icon: Star,
    label: "5-Star",
    color: "text-yellow-500",
    bgColor: "bg-yellow-500/10",
    description: "You gave this a 5-star rating",
  },
  reread: {
    icon: RefreshCw,
    label: "Re-read",
    color: "text-purple-500",
    bgColor: "bg-purple-500/10",
    description: "You've read this multiple times",
  },
  binge: {
    icon: Flame,
    label: "Binge",
    color: "text-orange-500",
    bgColor: "bg-orange-500/10",
    description: "4+ hour reading session (couldn't put it down)",
  },
  sessionQuality: {
    icon: Clock,
    label: "Deep Read",
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
    description: "Long average reading sessions",
  },
  authorLoyalty: {
    icon: Heart,
    label: "Fave Author",
    color: "text-pink-500",
    bgColor: "bg-pink-500/10",
    description: "You've read 3+ books by this author",
  },
  seriesVelocity: {
    icon: Zap,
    label: "Series Binge",
    color: "text-cyan-500",
    bgColor: "bg-cyan-500/10",
    description: "Finished within 3 days of previous book",
  },
  purchased: {
    icon: DollarSign,
    label: "Purchased",
    color: "text-green-500",
    bgColor: "bg-green-500/10",
    description: "You bought this (not KU)",
  },
};

function SignalBadge({
  signalKey,
  size = "sm",
}: {
  signalKey: keyof EngagementSignals;
  size?: "sm" | "md";
}) {
  const config = signalConfig[signalKey];
  const Icon = config.icon;

  const sizeClasses = size === "md" ? "w-7 h-7" : "w-5 h-5";
  const iconClasses = size === "md" ? "w-4 h-4" : "w-3 h-3";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full",
            "border border-border/50",
            sizeClasses,
            config.bgColor,
            config.color
          )}
        >
          <Icon className={iconClasses} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="font-medium">{config.label}</p>
        <p className="text-xs text-muted-foreground">{config.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function AnchorCard({
  anchor,
  index,
  onRemove,
  isRemoving,
}: {
  anchor: Anchor;
  index: number;
  onRemove?: (workId: number) => void;
  isRemoving?: boolean;
}) {
  const activeSignals = anchor.signals
    ? (Object.entries(anchor.signals) as [keyof EngagementSignals, boolean][])
        .filter(([, active]) => active)
        .map(([key]) => key)
    : [];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ delay: index * 0.03 }}
      className={cn(
        "group relative flex items-start gap-4 p-4 rounded-xl",
        "bg-card border border-border/50",
        "hover:border-border hover:shadow-sm transition-all"
      )}
    >
      {/* Rank badge */}
      <div
        className={cn(
          "absolute -top-2 -left-2 w-6 h-6 rounded-full",
          "flex items-center justify-center text-xs font-bold",
          index < 3
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground-muted"
        )}
      >
        {index + 1}
      </div>

      {/* Book cover placeholder */}
      <div className="w-12 h-16 rounded bg-muted flex-shrink-0 flex items-center justify-center">
        <BookOpen className="w-5 h-5 text-foreground-muted" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pt-1">
        <Link
          href={`/book/${anchor.workId}`}
          className="font-medium text-foreground hover:text-primary transition-colors line-clamp-2"
        >
          {anchor.title}
        </Link>

        {/* Signals */}
        <div className="flex items-center gap-1.5 mt-2">
          {activeSignals.map((key) => (
            <SignalBadge key={key} signalKey={key} />
          ))}
          {activeSignals.length === 0 && (
            <span className="text-xs text-foreground-subtle">
              High read frequency
            </span>
          )}
        </div>

        {/* Weight indicator */}
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary/60 rounded-full"
                style={{ width: `${Math.min(100, anchor.weight * 100)}%` }}
              />
            </div>
            <span className="text-xs text-foreground-muted">
              {(anchor.weight * 100).toFixed(0)}%
            </span>
          </div>
        </div>
      </div>

      {/* Remove button */}
      {onRemove && (
        <button
          onClick={() => onRemove(anchor.workId)}
          disabled={isRemoving}
          className={cn(
            "absolute top-2 right-2 p-1.5 rounded-lg",
            "opacity-0 group-hover:opacity-100",
            "text-foreground-muted hover:text-red-500",
            "hover:bg-red-50 dark:hover:bg-red-950/30",
            "transition-all",
            isRemoving && "opacity-50 cursor-not-allowed"
          )}
          aria-label="Remove from favorites"
        >
          {isRemoving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
        </button>
      )}
    </motion.div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  items,
}: {
  icon: typeof BookOpen;
  label: string;
  value?: string | number;
  items?: string[];
}) {
  return (
    <div className="p-4 rounded-xl bg-card border border-border/50">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-primary" />
        <span className="text-sm font-medium text-foreground-muted">{label}</span>
      </div>
      {value !== undefined && (
        <p className="text-2xl font-bold text-foreground">{value}</p>
      )}
      {items && items.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {items.slice(0, 5).map((item) => (
            <span
              key={item}
              className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary"
            >
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function TasteProfileFull({ userId = "me" }: { userId?: string }) {
  const [data, setData] = useState<TasteProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProfileError | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/profile?user_id=${userId}`);

      if (res.status === 404) {
        setError({
          type: "not_found",
          message: "No reading profile found",
        });
        setData(null);
        return;
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        setError({
          type: "server_error",
          message: "Failed to load profile",
          details: errorData.details || errorData.error,
        });
        setData(null);
        return;
      }

      const profile = await res.json();
      setData(profile);
      setError(null);
    } catch (err) {
      setError({
        type: "network_error",
        message: "Connection failed",
        details: String(err),
      });
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const handleRemoveFavorite = async (workId: number) => {
    setRemovingId(workId);
    try {
      const res = await fetch(`/api/profile/favorites`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workId, userId }),
      });

      if (res.ok) {
        // Optimistically remove from UI
        setData((prev) =>
          prev
            ? {
                ...prev,
                anchors: prev.anchors.filter((a) => a.workId !== workId),
              }
            : null
        );
      }
    } catch (err) {
      console.error("Failed to remove favorite:", err);
    } finally {
      setRemovingId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse bg-card/30 rounded-xl p-6 h-32" />
        <div className="animate-pulse bg-card/30 rounded-xl p-6 h-64" />
      </div>
    );
  }

  if (error && error.type !== "not_found") {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20 p-6">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-foreground">{error.message}</h3>
            {error.details && process.env.NODE_ENV === "development" && (
              <p className="text-xs text-foreground-muted mt-1 font-mono">
                {error.details}
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={fetchProfile}>
            <RefreshCcw className="h-4 w-4 mr-1" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!data || data.anchors.length === 0) {
    return (
      <div className="text-center py-16 bg-muted/30 rounded-2xl">
        <Dna className="h-12 w-12 mx-auto text-foreground-muted mb-4" />
        <h2 className="font-display text-xl font-semibold text-foreground">
          No Reading Profile Yet
        </h2>
        <p className="mt-2 text-foreground-muted max-w-md mx-auto">
          Import your reading history from Kindle or Goodreads to build your
          taste profile and get personalized recommendations.
        </p>
        <Button asChild className="mt-6">
          <Link href="/recommendations">Browse Recommendations</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={BookOpen}
          label="Books Read"
          value={data.summary.readCount}
        />
        <StatCard
          icon={Star}
          label="Avg Rating"
          value={
            data.summary.avgRating
              ? data.summary.avgRating.toFixed(1)
              : "N/A"
          }
        />
        <StatCard
          icon={User}
          label="Top Authors"
          items={data.summary.topAuthors}
        />
        <StatCard
          icon={Tag}
          label="Top Genres"
          items={data.summary.topSubjects}
        />
      </div>

      {/* Signal Legend */}
      <div className="p-4 rounded-xl bg-card border border-border/50">
        <h3 className="text-sm font-medium text-foreground mb-3">
          What the signals mean
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(signalConfig).map(([key, config]) => {
            const Icon = config.icon;
            return (
              <div key={key} className="flex items-center gap-2">
                <span
                  className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center",
                    config.bgColor,
                    config.color
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                </span>
                <div>
                  <p className="text-xs font-medium text-foreground">
                    {config.label}
                  </p>
                  <p className="text-xs text-foreground-muted line-clamp-1">
                    {config.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Anchor Books */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-display text-xl font-semibold text-foreground">
              Your Anchor Books
            </h2>
            <p className="text-sm text-foreground-muted">
              Books with the strongest influence on your recommendations
            </p>
          </div>
          <Button variant="outline" size="sm" disabled>
            <Plus className="h-4 w-4 mr-1" />
            Add Book
          </Button>
        </div>

        <AnimatePresence mode="popLayout">
          <div className="grid gap-3">
            {data.anchors.map((anchor, i) => (
              <AnchorCard
                key={anchor.workId}
                anchor={anchor}
                index={i}
                onRemove={handleRemoveFavorite}
                isRemoving={removingId === anchor.workId}
              />
            ))}
          </div>
        </AnimatePresence>
      </div>
    </div>
  );
}
