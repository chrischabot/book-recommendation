"use client";

import Image from "next/image";
import { useState } from "react";
import { BookCoverPlaceholder } from "./book-cover-placeholder";

interface BookCoverImageProps {
  coverUrl: string | null;
  title: string;
  author?: string;
  priority?: boolean;
  sizes?: string;
}

/**
 * Book cover image with fallback to placeholder.
 * Handles both load errors and Open Library's 1x1 pixel placeholder images.
 */
export function BookCoverImage({
  coverUrl,
  title,
  author,
  priority = false,
  sizes = "(max-width: 1024px) 280px, 350px",
}: BookCoverImageProps) {
  const [imageError, setImageError] = useState(false);

  const hasCover = coverUrl && !imageError;

  if (!hasCover) {
    return <BookCoverPlaceholder title={title} author={author} />;
  }

  return (
    <Image
      src={coverUrl}
      alt={`Cover of ${title}`}
      fill
      className="object-cover"
      priority={priority}
      sizes={sizes}
      onError={() => setImageError(true)}
      onLoad={(e) => {
        // Open Library returns 1x1 transparent pixel for missing covers
        const img = e.currentTarget as HTMLImageElement;
        if (img.naturalWidth <= 1 || img.naturalHeight <= 1) {
          setImageError(true);
        }
      }}
    />
  );
}
