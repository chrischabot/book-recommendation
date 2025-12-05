import { cn } from "@/lib/utils";
import { Star } from "lucide-react";

interface StarRatingProps {
  rating: number;
  maxRating?: number;
  size?: "sm" | "md" | "lg";
  showValue?: boolean;
  count?: number;
  className?: string;
}

const sizeClasses = {
  sm: "h-3 w-3",
  md: "h-4 w-4",
  lg: "h-5 w-5",
};

const textSizeClasses = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

export function StarRating({
  rating,
  maxRating = 5,
  size = "sm",
  showValue = true,
  count,
  className,
}: StarRatingProps) {
  const fullStars = Math.floor(rating);
  const partialStar = rating - fullStars;
  const emptyStars = maxRating - Math.ceil(rating);

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <div className="flex items-center">
        {/* Full stars */}
        {Array.from({ length: fullStars }).map((_, i) => (
          <Star
            key={`full-${i}`}
            className={cn(sizeClasses[size], "fill-star text-star")}
          />
        ))}

        {/* Partial star */}
        {partialStar > 0 && (
          <div className="relative">
            <Star className={cn(sizeClasses[size], "text-muted")} />
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ width: `${partialStar * 100}%` }}
            >
              <Star
                className={cn(sizeClasses[size], "fill-star text-star")}
              />
            </div>
          </div>
        )}

        {/* Empty stars */}
        {Array.from({ length: emptyStars }).map((_, i) => (
          <Star
            key={`empty-${i}`}
            className={cn(sizeClasses[size], "text-muted")}
          />
        ))}
      </div>

      {showValue && (
        <span className={cn(textSizeClasses[size], "text-foreground-muted")}>
          {rating.toFixed(1)}
        </span>
      )}

      {count !== undefined && (
        <span className={cn(textSizeClasses[size], "text-foreground-subtle")}>
          ({formatRatingCount(count)})
        </span>
      )}
    </div>
  );
}

function formatRatingCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toLocaleString();
}

// Simple inline star with rating number
export function InlineRating({
  rating,
  count,
  className,
}: {
  rating: number;
  count?: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm", className)}>
      <Star className="h-3.5 w-3.5 fill-star text-star" />
      <span className="font-medium text-foreground">{rating.toFixed(1)}</span>
      {count !== undefined && (
        <span className="text-foreground-subtle">
          ({formatRatingCount(count)})
        </span>
      )}
    </span>
  );
}
