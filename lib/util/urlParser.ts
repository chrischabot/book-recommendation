/**
 * URL Parser for extracting external book IDs
 * Handles Amazon, Goodreads, Royal Road, and Google Books URLs
 */

export interface ExternalIds {
  asin?: string;
  goodreadsId?: string;
  royalRoadId?: string;
  googleVolumeId?: string;
}

/**
 * Extract external IDs from a book-related URL
 *
 * Supported URL formats:
 * - Amazon: amazon.com/dp/B0FBLBD55Q, amazon.com/gp/product/B0CPTN7SF4
 * - Goodreads: goodreads.com/book/show/222753184-book-title
 * - Royal Road: royalroad.com/fiction/77020/story-name
 * - Google Books: books.google.com/books?id=VolumeId
 */
export function parseExternalIdsFromUrl(url: string): ExternalIds {
  try {
    const o = new URL(url);
    const host = o.hostname.replace(/^www\./, "").toLowerCase();
    const path = o.pathname;
    const ids: ExternalIds = {};

    // Amazon: /dp/B0FBLBD55Q, /gp/product/B0CPTN7SF4, /kindle-dbs/detail?asin=B0XXX
    if (host === "amazon.com" || host.endsWith(".amazon.com")) {
      // Standard product pages
      const dpMatch = path.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      if (dpMatch) {
        ids.asin = dpMatch[1].toUpperCase();
      } else {
        // Kindle detail pages with query param
        const asinParam = o.searchParams.get("asin");
        if (asinParam && /^[A-Z0-9]{10}$/i.test(asinParam)) {
          ids.asin = asinParam.toUpperCase();
        }
      }
    }

    // Goodreads: /book/show/222753184-... or /book/show/222753184
    if (host === "goodreads.com") {
      const grMatch = path.match(/\/book\/show\/(\d+)/);
      if (grMatch) {
        ids.goodreadsId = grMatch[1];
      }
    }

    // Royal Road: /fiction/77020/resistance-above-magic
    if (host === "royalroad.com") {
      const rrMatch = path.match(/\/fiction\/(\d+)/);
      if (rrMatch) {
        ids.royalRoadId = rrMatch[1];
      }
    }

    // Google Books: books.google.com/books?id=XXX or /books/about/Title?id=XXX
    if (host.includes("google.com") && (path.includes("/books") || host.startsWith("books."))) {
      const volumeId = o.searchParams.get("id");
      if (volumeId) {
        ids.googleVolumeId = volumeId;
      }
    }

    return ids;
  } catch {
    // Invalid URL
    return {};
  }
}

/**
 * Check if a string looks like an ASIN (10-character alphanumeric, starts with B for Kindle)
 */
export function isValidAsin(value: string): boolean {
  return /^[A-Z0-9]{10}$/i.test(value);
}

/**
 * Check if a string looks like a Kindle ASIN (starts with B)
 */
export function isKindleAsin(value: string): boolean {
  return /^B[A-Z0-9]{9}$/i.test(value);
}

/**
 * Extract ASIN from various Amazon URL formats
 */
export function extractAsinFromAmazonUrl(url: string): string | null {
  const ids = parseExternalIdsFromUrl(url);
  return ids.asin ?? null;
}

/**
 * Build Amazon product URL from ASIN
 */
export function buildAmazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin.toUpperCase()}`;
}

/**
 * Build Goodreads book URL from ID
 */
export function buildGoodreadsUrl(goodreadsId: string): string {
  return `https://www.goodreads.com/book/show/${goodreadsId}`;
}

/**
 * Build Royal Road fiction URL from ID
 */
export function buildRoyalRoadUrl(fictionId: string): string {
  return `https://www.royalroad.com/fiction/${fictionId}`;
}

/**
 * Build Google Books URL from volume ID
 */
export function buildGoogleBooksUrl(volumeId: string): string {
  return `https://books.google.com/books?id=${encodeURIComponent(volumeId)}`;
}

/**
 * Try to extract any external ID from a URL
 * Returns the first found ID with its type
 */
export function extractFirstExternalId(url: string): { type: keyof ExternalIds; value: string } | null {
  const ids = parseExternalIdsFromUrl(url);

  if (ids.asin) return { type: "asin", value: ids.asin };
  if (ids.goodreadsId) return { type: "goodreadsId", value: ids.goodreadsId };
  if (ids.royalRoadId) return { type: "royalRoadId", value: ids.royalRoadId };
  if (ids.googleVolumeId) return { type: "googleVolumeId", value: ids.googleVolumeId };

  return null;
}
