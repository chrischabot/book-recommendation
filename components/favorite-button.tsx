"use client";

import { useState, useEffect } from "react";
import { Heart, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FavoriteButtonProps {
  workId: number;
  userId?: string;
  className?: string;
}

export function FavoriteButton({
  workId,
  userId = "me",
  className,
}: FavoriteButtonProps) {
  const [isFavorite, setIsFavorite] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);

  // Check initial favorite status
  useEffect(() => {
    async function checkStatus() {
      try {
        const res = await fetch(
          `/api/profile/favorites?work_id=${workId}&user_id=${userId}`
        );
        if (res.ok) {
          const data = await res.json();
          setIsFavorite(data.isFavorite);
        }
      } catch (err) {
        console.error("Failed to check favorite status:", err);
      } finally {
        setIsLoading(false);
      }
    }
    checkStatus();
  }, [workId, userId]);

  const toggleFavorite = async () => {
    if (isUpdating || isFavorite === null) return;

    setIsUpdating(true);
    const newState = !isFavorite;

    try {
      const method = newState ? "POST" : "DELETE";
      const res = await fetch("/api/profile/favorites", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workId, userId }),
      });

      if (res.ok) {
        setIsFavorite(newState);
      }
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
    } finally {
      setIsUpdating(false);
    }
  };

  if (isLoading) {
    return (
      <Button variant="outline" size="sm" disabled className={className}>
        <Loader2 className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  // Only show for books in user's history
  if (isFavorite === null) {
    return null;
  }

  return (
    <Button
      variant={isFavorite ? "default" : "outline"}
      size="sm"
      onClick={toggleFavorite}
      disabled={isUpdating}
      className={cn(
        "transition-all",
        isFavorite && "bg-pink-500 hover:bg-pink-600 border-pink-500",
        className
      )}
    >
      {isUpdating ? (
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
      ) : (
        <Heart
          className={cn(
            "h-4 w-4 mr-2",
            isFavorite && "fill-current"
          )}
        />
      )}
      {isFavorite ? "In Your DNA" : "Add to DNA"}
    </Button>
  );
}
