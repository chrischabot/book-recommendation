/**
 * Type definitions for Resolver V2
 * Multi-source book resolution with confidence scoring
 */

/**
 * Input for work resolution - any subset of identifiers/metadata
 */
export interface ResolveInput {
  // Hard identifiers (unique keys)
  isbn13?: string;
  isbn10?: string;
  asin?: string;
  googleVolumeId?: string;
  royalRoadId?: string;
  goodreadsId?: string;
  audibleAsin?: string;

  // Soft identifiers (for fuzzy matching)
  title?: string;
  author?: string;
  publishedDate?: string;

  // Optional enrichment data
  description?: string;
  coverUrl?: string;
  categories?: string[];
  pageCount?: number;
  averageRating?: number;
  ratingsCount?: number;
}

/**
 * Result of work resolution
 */
export interface ResolveResult {
  workId: number;
  editionId: number;
  confidence: number;
  created: boolean;
  path: ResolutionPath;
  source: WorkSource;
}

/**
 * Resolution paths in priority order
 */
export type ResolutionPath =
  | "isbn_ol"      // ISBN → Open Library hit (highest confidence)
  | "isbn_gb"      // ISBN → OL miss → Google Books enrichment
  | "isbn_local"   // ISBN → OL miss → no GB → local only
  | "gbid"         // Google Books Volume ID direct lookup
  | "title_gb"     // Title+Author → Google Books search
  | "asin"         // ASIN only (Kindle)
  | "royalroad"    // Royal Road fiction ID
  | "goodreads"    // Goodreads book ID (ID only, no data fetch)
  | "manual";      // Manual fallback (title+author only)

/**
 * Work provenance source
 */
export type WorkSource =
  | "openlibrary"
  | "googlebooks"
  | "amazon"
  | "royalroad"
  | "goodreads"
  | "manual";

/**
 * Confidence levels for different resolution paths
 */
export const CONFIDENCE: Record<ResolutionPath, number> = {
  isbn_ol: 0.98,      // Best case - canonical OL work
  isbn_gb: 0.85,      // Create local with GB enrichment
  isbn_local: 0.75,   // Create local ISBN-only
  gbid: 0.82,         // Direct GB volume lookup
  title_gb: 0.80,     // GB match with strong similarity
  asin: 0.65,         // Kindle-only, may merge later
  royalroad: 0.60,    // Web serial, manual enrichment
  goodreads: 0.55,    // Can't fetch data, ID only
  manual: 0.40,       // Title+author only
};

/**
 * Threshold below which a Work is marked as a stub
 */
export const STUB_THRESHOLD = 0.70;

/**
 * Data extracted from Google Books for enrichment
 */
export interface GoogleBooksData {
  volumeId: string;
  isbn13?: string;
  isbn10?: string;
  title: string;
  authors: string[];
  description?: string;
  categories: string[];
  publishedDate?: string;
  pageCount?: number;
  coverUrl?: string;
  averageRating?: number;
  ratingsCount?: number;
}

/**
 * Options for upsert operations
 */
export interface UpsertOptions {
  confidence: number;
  path: ResolutionPath;
  source: WorkSource;
}

/**
 * Result of upsert operation
 */
export interface UpsertResult {
  workId: number;
  editionId: number;
  created: boolean;
  workCreated: boolean;
  editionCreated: boolean;
}

/**
 * Merge operation details
 */
export interface MergeInfo {
  fromWorkId: number;
  toWorkId: number;
  reason: string;
  editionsMoved: number;
}

/**
 * Resolver cache entry
 */
export interface ResolverCacheEntry {
  workId: number;
  editionId: number;
  confidence: number;
  path: ResolutionPath;
  source: WorkSource;
}

/**
 * Log entry for resolution tracking
 */
export interface ResolverLogEntry {
  inputKey: string;
  inputData: ResolveInput;
  pathTaken: ResolutionPath;
  workId: number;
  editionId: number;
  confidence: number;
  created: boolean;
}
