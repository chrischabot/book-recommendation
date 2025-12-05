/**
 * Text processing utilities
 */

/**
 * Truncate text to a maximum character length
 */
export function truncate(text: string, maxLength: number, suffix = "..."): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length).trim() + suffix;
}

/**
 * Clean and normalize text for comparison or embedding
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build embedding input text from work metadata
 * Combines title, subtitle, description, authors, and subjects
 */
export function buildEmbeddingText(work: {
  title: string;
  subtitle?: string | null;
  description?: string | null;
  authors?: string[];
  subjects?: string[];
}): string {
  const parts: string[] = [];

  // Title and subtitle
  if (work.title) {
    parts.push(work.title);
  }
  if (work.subtitle) {
    parts.push(work.subtitle);
  }

  // Authors
  if (work.authors && work.authors.length > 0) {
    parts.push(`By ${work.authors.join(", ")}`);
  }

  // Description (truncated)
  if (work.description) {
    parts.push(truncate(work.description, 2000));
  }

  // Subjects (top ones)
  if (work.subjects && work.subjects.length > 0) {
    const topSubjects = work.subjects.slice(0, 10).join(", ");
    parts.push(`Topics: ${topSubjects}`);
  }

  return parts.join(". ");
}

/**
 * Extract year from various date formats
 */
export function extractYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;

  // Try to extract 4-digit year
  const match = dateStr.match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

/**
 * Normalize ISBN (remove hyphens, validate length)
 */
export function normalizeIsbn(isbn: string): { isbn10?: string; isbn13?: string } {
  const cleaned = isbn.replace(/[-\s]/g, "");

  if (cleaned.length === 10) {
    return { isbn10: cleaned };
  } else if (cleaned.length === 13) {
    return { isbn13: cleaned };
  }

  return {};
}

/**
 * Convert ISBN-10 to ISBN-13
 */
export function isbn10ToIsbn13(isbn10: string): string {
  const base = "978" + isbn10.slice(0, 9);
  let sum = 0;

  for (let i = 0; i < 12; i++) {
    sum += parseInt(base[i], 10) * (i % 2 === 0 ? 1 : 3);
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return base + checkDigit;
}

/**
 * Slugify a string for URLs
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Calculate simple string similarity (Dice coefficient)
 */
export function stringSimilarity(a: string, b: string): number {
  const aNorm = normalizeText(a);
  const bNorm = normalizeText(b);

  if (aNorm === bNorm) return 1;
  if (aNorm.length < 2 || bNorm.length < 2) return 0;

  const getBigrams = (s: string) => {
    const bigrams = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.add(s.slice(i, i + 2));
    }
    return bigrams;
  };

  const aBigrams = getBigrams(aNorm);
  const bBigrams = getBigrams(bNorm);

  let intersection = 0;
  for (const bigram of aBigrams) {
    if (bBigrams.has(bigram)) intersection++;
  }

  return (2 * intersection) / (aBigrams.size + bBigrams.size);
}

/**
 * Parse author string handling various formats
 * e.g., "Last, First" -> "First Last"
 */
export function normalizeAuthorName(name: string): string {
  const trimmed = name.trim();

  // Handle "Last, First" format
  if (trimmed.includes(",")) {
    const [last, first] = trimmed.split(",").map((s) => s.trim());
    if (first && last) {
      return `${first} ${last}`;
    }
  }

  return trimmed;
}
