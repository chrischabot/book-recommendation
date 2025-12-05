/**
 * Cover image URL utilities
 */

type CoverSize = "S" | "M" | "L";

/**
 * Get Open Library cover URL by cover ID
 */
export function getOpenLibraryCoverUrl(
  coverId: string | number,
  size: CoverSize = "M"
): string {
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
}

/**
 * Get Open Library cover URL by ISBN
 */
export function getOpenLibraryCoverByIsbn(
  isbn: string,
  size: CoverSize = "M"
): string {
  return `https://covers.openlibrary.org/b/isbn/${isbn}-${size}.jpg`;
}

/**
 * Get Open Library cover URL by OLID (edition key)
 */
export function getOpenLibraryCoverByOlid(
  olid: string,
  size: CoverSize = "M"
): string {
  return `https://covers.openlibrary.org/b/olid/${olid}-${size}.jpg`;
}

/**
 * Get Open Library cover URL by work key (OL work ID)
 * Works have covers too: https://covers.openlibrary.org/w/olid/OL123W-M.jpg
 */
export function getOpenLibraryCoverByWorkKey(
  workKey: string,
  size: CoverSize = "M"
): string {
  // Strip /works/ prefix if present
  const key = workKey.replace("/works/", "");
  return `https://covers.openlibrary.org/w/olid/${key}-${size}.jpg`;
}

/**
 * Get Google Books thumbnail URL
 */
export function getGoogleBooksThumbnail(
  googleBooksId: string,
  zoom: 0 | 1 | 2 | 3 = 1
): string {
  return `https://books.google.com/books/content?id=${googleBooksId}&printsec=frontcover&img=1&zoom=${zoom}`;
}

/**
 * Build cover URL with fallbacks
 * Returns the first available cover URL
 */
export function getCoverUrl(options: {
  coverId?: string | number | null;
  isbn13?: string | null;
  isbn10?: string | null;
  olEditionKey?: string | null;
  olWorkKey?: string | null;
  googleBooksId?: string | null;
  size?: CoverSize;
}): string | null {
  const { coverId, isbn13, isbn10, olEditionKey, olWorkKey, googleBooksId, size = "M" } = options;

  // Prefer Open Library cover ID (most reliable)
  if (coverId) {
    return getOpenLibraryCoverUrl(coverId, size);
  }

  // Try ISBN13
  if (isbn13) {
    return getOpenLibraryCoverByIsbn(isbn13, size);
  }

  // Try ISBN10
  if (isbn10) {
    return getOpenLibraryCoverByIsbn(isbn10, size);
  }

  // Try edition key
  if (olEditionKey) {
    return getOpenLibraryCoverByOlid(olEditionKey, size);
  }

  // Try work key (OL works also have covers)
  if (olWorkKey) {
    return getOpenLibraryCoverByWorkKey(olWorkKey, size);
  }

  // Fallback to Google Books
  if (googleBooksId) {
    const zoom = size === "S" ? 0 : size === "M" ? 1 : 2;
    return getGoogleBooksThumbnail(googleBooksId, zoom);
  }

  return null;
}

/**
 * Placeholder image URL for books without covers
 */
export function getPlaceholderCover(): string {
  return "/images/book-placeholder.svg";
}

/**
 * Check if a cover URL is likely valid (not a placeholder/error)
 * This is a client-side check based on URL patterns
 */
export function isValidCoverUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.includes("placeholder")) return false;
  return true;
}
