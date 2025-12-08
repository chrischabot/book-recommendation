import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { BookOpen, Globe, ShoppingCart, Pen, FileQuestion, AlertTriangle } from "lucide-react";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-sm",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        accent:
          "border-transparent bg-accent text-accent-foreground",
        outline:
          "border-border text-foreground",
        muted:
          "border-transparent bg-muted text-muted-foreground",
        // Quality badges
        "quality-aplus":
          "border-transparent bg-emerald-500 text-white shadow-[0_0_12px_hsl(152_60%_40%/0.4)]",
        "quality-a":
          "border-transparent bg-emerald-400 text-white",
        "quality-aminus":
          "border-transparent bg-green-400 text-white",
        "quality-bplus":
          "border-transparent bg-sky-400 text-white",
        "quality-b":
          "border-transparent bg-sky-300 text-gray-800",
        "quality-bminus":
          "border-transparent bg-gray-300 text-gray-700",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

// Quality badge helper
type SuggestionQuality = "A+" | "A" | "A-" | "B+" | "B" | "B-";

const qualityVariantMap: Record<SuggestionQuality, BadgeProps["variant"]> = {
  "A+": "quality-aplus",
  "A": "quality-a",
  "A-": "quality-aminus",
  "B+": "quality-bplus",
  "B": "quality-b",
  "B-": "quality-bminus",
};

interface QualityBadgeProps extends Omit<BadgeProps, "variant"> {
  quality: SuggestionQuality;
  confidence?: number;
  showConfidence?: boolean;
}

function QualityBadge({ quality, confidence, showConfidence = false, className, ...props }: QualityBadgeProps) {
  const variant = qualityVariantMap[quality];
  const confidencePercent = confidence ? Math.round(confidence * 100) : null;

  // Low confidence warning (below 70%)
  const isLowConfidence = confidence !== undefined && confidence < 0.7;

  return (
    <Badge
      variant={variant}
      className={cn(
        "tracking-wide gap-1",
        isLowConfidence && "ring-1 ring-amber-400/50",
        className
      )}
      title={confidencePercent ? `Match confidence: ${confidencePercent}%` : undefined}
      {...props}
    >
      {quality}
      {showConfidence && confidencePercent !== null && (
        <span className="opacity-75 text-[10px] font-normal ml-0.5">
          {confidencePercent}%
        </span>
      )}
    </Badge>
  );
}

// Source badge to show where book data came from
type BookSource = "openlibrary" | "googlebooks" | "amazon" | "royalroad" | "goodreads" | "manual";

const sourceConfig: Record<BookSource, { icon: typeof BookOpen; label: string; color: string }> = {
  openlibrary: { icon: BookOpen, label: "Open Library", color: "text-emerald-600" },
  googlebooks: { icon: Globe, label: "Google Books", color: "text-blue-600" },
  amazon: { icon: ShoppingCart, label: "Amazon/Kindle", color: "text-orange-600" },
  royalroad: { icon: Pen, label: "Royal Road", color: "text-purple-600" },
  goodreads: { icon: BookOpen, label: "Goodreads", color: "text-amber-700" },
  manual: { icon: FileQuestion, label: "Manual Entry", color: "text-gray-500" },
};

interface SourceBadgeProps {
  source: BookSource;
  className?: string;
  showLabel?: boolean;
}

function SourceBadge({ source, className, showLabel = false }: SourceBadgeProps) {
  const config = sourceConfig[source];
  if (!config) return null;

  const Icon = config.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        config.color,
        className
      )}
      title={config.label}
    >
      <Icon className="h-3 w-3" />
      {showLabel && <span>{config.label}</span>}
    </span>
  );
}

// Stub warning for low-confidence books
interface StubWarningProps {
  isStub?: boolean;
  stubReason?: string;
  confidence?: number;
  className?: string;
}

function StubWarning({ isStub, stubReason, confidence, className }: StubWarningProps) {
  // Show warning if explicitly marked as stub OR confidence is very low
  const showWarning = isStub || (confidence !== undefined && confidence < 0.5);

  if (!showWarning) return null;

  const message = stubReason || (confidence !== undefined && confidence < 0.5
    ? "Low confidence match"
    : "Incomplete book data");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs text-amber-600",
        className
      )}
      title={message}
    >
      <AlertTriangle className="h-3 w-3" />
      <span className="sr-only">{message}</span>
    </span>
  );
}

export { Badge, badgeVariants, QualityBadge, SourceBadge, StubWarning };
export type { BookSource };
