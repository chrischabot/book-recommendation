import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

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
}

function QualityBadge({ quality, confidence, className, ...props }: QualityBadgeProps) {
  const variant = qualityVariantMap[quality];

  return (
    <Badge
      variant={variant}
      className={cn("tracking-wide", className)}
      title={confidence ? `Match confidence: ${(confidence * 100).toFixed(0)}%` : undefined}
      {...props}
    >
      {quality}
    </Badge>
  );
}

export { Badge, badgeVariants, QualityBadge };
