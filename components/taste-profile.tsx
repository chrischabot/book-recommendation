"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  Star,
  RefreshCw,
  Flame,
  Clock,
  Heart,
  Zap,
  DollarSign,
  ChevronDown,
  AlertCircle,
  RefreshCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  { icon: typeof Star; label: string; color: string; description: string }
> = {
  fiveStar: {
    icon: Star,
    label: "5-Star",
    color: "text-yellow-500",
    description: "You gave this a 5-star rating",
  },
  reread: {
    icon: RefreshCw,
    label: "Re-read",
    color: "text-purple-500",
    description: "You've read this multiple times",
  },
  binge: {
    icon: Flame,
    label: "Binge",
    color: "text-orange-500",
    description: "4+ hour reading session (couldn't put it down)",
  },
  sessionQuality: {
    icon: Clock,
    label: "Deep Read",
    color: "text-blue-500",
    description: "Long average reading sessions",
  },
  authorLoyalty: {
    icon: Heart,
    label: "Fave Author",
    color: "text-pink-500",
    description: "You've read 3+ books by this author",
  },
  seriesVelocity: {
    icon: Zap,
    label: "Series Binge",
    color: "text-cyan-500",
    description: "Finished within 3 days of previous book",
  },
  purchased: {
    icon: DollarSign,
    label: "Purchased",
    color: "text-green-500",
    description: "You bought this (not KU)",
  },
};

function SignalBadge({ signalKey }: { signalKey: keyof EngagementSignals }) {
  const config = signalConfig[signalKey];
  const Icon = config.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center justify-center w-5 h-5 rounded-full",
            "bg-background/50 border border-border/50",
            config.color
          )}
        >
          <Icon className="w-3 h-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="font-medium">{config.label}</p>
        <p className="text-xs text-muted-foreground">{config.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function AnchorCard({ anchor, index }: { anchor: Anchor; index: number }) {
  const activeSignals = anchor.signals
    ? (Object.entries(anchor.signals) as [keyof EngagementSignals, boolean][])
        .filter(([, active]) => active)
        .map(([key]) => key)
    : [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg",
        "bg-card/50 border border-border/30",
        "hover:bg-card hover:border-border/50 transition-colors"
      )}
    >
      <span className="text-sm font-medium text-foreground-subtle w-5 text-center">
        {index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <Link
          href={`/book/${anchor.workId}`}
          className="text-sm font-medium text-foreground hover:text-primary truncate block"
        >
          {anchor.title}
        </Link>
        <div className="flex items-center gap-1.5 mt-1">
          {activeSignals.map((key) => (
            <SignalBadge key={key} signalKey={key} />
          ))}
          {activeSignals.length === 0 && (
            <span className="text-xs text-foreground-subtle">No special signals</span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

export function TasteProfile({ userId = "me" }: { userId?: string }) {
  const [data, setData] = useState<TasteProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProfileError | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchProfile = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/profile?user_id=${userId}`);

      if (res.status === 404) {
        // Profile not found - user hasn't imported reading history yet
        setError({
          type: "not_found",
          message: "No reading profile found",
        });
        setData(null);
        return;
      }

      if (!res.ok) {
        // Server error - try to get details if available
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
  };

  useEffect(() => {
    fetchProfile();
  }, [userId]);

  if (loading) {
    return (
      <div className="animate-pulse bg-card/30 rounded-xl p-6 h-48" />
    );
  }

  // Show error state for server/network errors (but not 404)
  if (error && error.type !== "not_found") {
    return (
      <motion.section
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn(
          "rounded-xl border border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20",
          "overflow-hidden p-4"
        )}
      >
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-foreground">{error.message}</h3>
            {error.details && process.env.NODE_ENV === "development" && (
              <p className="text-xs text-foreground-muted mt-1 font-mono truncate">
                {error.details}
              </p>
            )}
          </div>
          <button
            onClick={fetchProfile}
            className={cn(
              "p-2 rounded-lg",
              "text-foreground-muted hover:text-foreground",
              "hover:bg-red-100 dark:hover:bg-red-900/30",
              "transition-colors"
            )}
            aria-label="Retry"
          >
            <RefreshCcw className="h-4 w-4" />
          </button>
        </div>
      </motion.section>
    );
  }

  // Don't show anything if profile not found (user hasn't set up yet)
  if (!data || data.anchors.length === 0) {
    return null;
  }

  const displayAnchors = expanded ? data.anchors : data.anchors.slice(0, 5);

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm",
        "overflow-hidden"
      )}
    >
      <div className="p-4 border-b border-border/30">
        <h2 className="font-display text-lg font-semibold text-foreground">
          Your Reading DNA
        </h2>
        <p className="text-sm text-foreground-muted mt-1">
          Books that define your taste profile
        </p>
      </div>

      <div className="p-4 space-y-2">
        {displayAnchors.map((anchor, i) => (
          <AnchorCard key={anchor.workId} anchor={anchor} index={i} />
        ))}
      </div>

      {data.anchors.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "w-full py-3 flex items-center justify-center gap-2",
            "text-sm font-medium text-foreground-muted",
            "hover:text-foreground hover:bg-card/50 transition-colors",
            "border-t border-border/30"
          )}
        >
          {expanded ? "Show less" : `Show ${data.anchors.length - 5} more`}
          <ChevronDown
            className={cn(
              "w-4 h-4 transition-transform",
              expanded && "rotate-180"
            )}
          />
        </button>
      )}

      {/* Signal Legend */}
      <div className="px-4 pb-4">
        <div className="flex flex-wrap gap-3 text-xs text-foreground-subtle">
          {Object.entries(signalConfig).map(([key, config]) => {
            const Icon = config.icon;
            return (
              <span key={key} className="flex items-center gap-1">
                <Icon className={cn("w-3 h-3", config.color)} />
                {config.label}
              </span>
            );
          })}
        </div>
      </div>
    </motion.section>
  );
}
