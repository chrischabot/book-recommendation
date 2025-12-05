/**
 * Vector utilities for pgvector operations
 */

/**
 * Convert a number array to pgvector literal format
 * e.g., [1, 2, 3] -> '[1.000000,2.000000,3.000000]'
 */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => Number(x).toFixed(6)).join(",")}]`;
}

/**
 * Parse a pgvector string back to number array
 * e.g., '[1,2,3]' -> [1, 2, 3]
 */
export function parseVector(vectorStr: string): number[] {
  if (!vectorStr) return [];
  const inner = vectorStr.replace(/^\[/, "").replace(/\]$/, "");
  if (!inner) return [];
  return inner.split(",").map((s) => parseFloat(s.trim()));
}

/**
 * Normalize a vector to unit length (L2 normalization)
 */
export function normalizeVector(v: number[]): number[] {
  const magnitude = Math.sqrt(v.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) return v;
  return v.map((val) => val / magnitude);
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same dimension");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Add two vectors element-wise
 */
export function addVectors(a: number[], b: number[]): number[] {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same dimension");
  }
  return a.map((val, i) => val + b[i]);
}

/**
 * Scale a vector by a scalar
 */
export function scaleVector(v: number[], scalar: number): number[] {
  return v.map((val) => val * scalar);
}

/**
 * Compute weighted average of vectors
 */
export function weightedAverageVectors(
  vectors: number[][],
  weights: number[]
): number[] {
  if (vectors.length === 0) return [];
  if (vectors.length !== weights.length) {
    throw new Error("Vectors and weights must have the same length");
  }

  const dim = vectors[0].length;
  const result = new Array(dim).fill(0);

  let totalWeight = 0;
  for (let i = 0; i < vectors.length; i++) {
    const weight = weights[i];
    totalWeight += weight;
    for (let j = 0; j < dim; j++) {
      result[j] += vectors[i][j] * weight;
    }
  }

  if (totalWeight === 0) return result;
  return result.map((val) => val / totalWeight);
}
