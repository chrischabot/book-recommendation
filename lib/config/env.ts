import { z } from "zod";
import { config } from "dotenv";

// Load .env file for CLI scripts (Next.js handles this automatically for the app)
config();

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),
  PGPOOL_MIN: z.coerce.number().int().positive().default(2),
  PGPOOL_MAX: z.coerce.number().int().positive().default(20),

  // Redis (optional)
  REDIS_URL: z.string().url().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_EMBED_MODEL: z.string().default("text-embedding-3-large"),
  // Dimension reduction: text-embedding-3-large supports 256-3072
  // Using 1536 for good quality while enabling vector index (max 2000)
  OPENAI_EMBED_DIMENSIONS: z.coerce.number().int().min(256).max(2000).default(1536),
  OPENAI_REASONING_MODEL: z.string().default("gpt-5-mini"),

  // Google Books
  GOOGLE_BOOKS_API_KEY: z.string().optional(),

  // Data paths
  OPENLIBRARY_DUMPS_DIR: z.string().default("./data/openlibrary"),
  GOODREADS_EXPORT_CSV: z.string().default("./data/goodreads/export.csv"),
  KINDLE_EXPORT_DIR: z.string().default("./data/kindle"),

  // App settings
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DEFAULT_USER_ID: z.string().default("me"),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error("Invalid environment variables:");
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

/**
 * Get environment variable with type safety
 * Use this for optional access without full validation
 */
export function env<K extends keyof Env>(key: K): Env[K] | undefined {
  try {
    return getEnv()[key];
  } catch {
    return undefined;
  }
}

/**
 * Check if we're in production
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Check if we're in development
 */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}

/**
 * Check if Redis is configured
 */
export function hasRedis(): boolean {
  return !!process.env.REDIS_URL;
}

/**
 * Check if Google Books API is configured
 */
export function hasGoogleBooks(): boolean {
  return !!process.env.GOOGLE_BOOKS_API_KEY;
}
