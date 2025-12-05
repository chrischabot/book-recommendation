import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

export interface CategoryConfig {
  include: string[];
  exclude?: string[];
  years?: string;
  description?: string;
}

export interface CategoryConstraints {
  subjects: string[];
  excludeSubjects: string[];
  yearMin?: number;
  yearMax?: number;
  description?: string;
}

let categoriesCache: Map<string, CategoryConfig> | null = null;

/**
 * Load categories from YAML file
 */
export function loadCategories(): Map<string, CategoryConfig> {
  if (categoriesCache) return categoriesCache;

  const filePath = join(process.cwd(), "lib/config/categories.yaml");
  const content = readFileSync(filePath, "utf-8");
  const data = yaml.load(content) as Record<string, CategoryConfig>;

  categoriesCache = new Map(Object.entries(data));
  return categoriesCache;
}

/**
 * Parse year constraint string (e.g., "1980-", "-2020", "1950-2000")
 */
function parseYearConstraint(yearStr: string): { min?: number; max?: number } {
  const match = yearStr.match(/^(\d+)?-(\d+)?$/);
  if (!match) return {};

  return {
    min: match[1] ? parseInt(match[1], 10) : undefined,
    max: match[2] ? parseInt(match[2], 10) : undefined,
  };
}

/**
 * Get constraints for a category slug
 */
export function getCategoryConstraints(slug: string): CategoryConstraints | null {
  const categories = loadCategories();
  const config = categories.get(slug);

  if (!config) return null;

  const yearConstraints = config.years
    ? parseYearConstraint(config.years)
    : {};

  return {
    subjects: config.include,
    excludeSubjects: config.exclude ?? [],
    yearMin: yearConstraints.min,
    yearMax: yearConstraints.max,
    description: config.description,
  };
}

/**
 * Get all available category slugs
 */
export function getCategorySlugs(): string[] {
  return Array.from(loadCategories().keys());
}

/**
 * Get category metadata for UI display
 */
export function getCategoryMetadata(): Array<{
  slug: string;
  description?: string;
}> {
  const categories = loadCategories();
  return Array.from(categories.entries()).map(([slug, config]) => ({
    slug,
    description: config.description,
  }));
}
