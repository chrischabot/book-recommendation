import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

// Singleton pool instance
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      min: Number(process.env.PGPOOL_MIN ?? 2),
      max: Number(process.env.PGPOOL_MAX ?? 20),
      // Add connection timeout and idle timeout
      connectionTimeoutMillis: 30000, // 30s to get a connection
      idleTimeoutMillis: 30000, // Close idle connections after 30s
    });

    // Handle pool errors
    pool.on("error", (err) => {
      console.error("Unexpected error on idle client", err);
    });
  }
  return pool;
}

/**
 * Sleep helper for retry logic
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get a client with retry logic for connection exhaustion
 */
async function getClientWithRetry(maxRetries = 3): Promise<PoolClient> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await getPool().connect();
    } catch (error) {
      lastError = error as Error;
      const errMsg = String(error);
      // Retry on "too many clients" or timeout errors
      if (errMsg.includes("too many clients") || errMsg.includes("timeout")) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff, max 5s
        console.warn(`Connection pool exhausted, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("Failed to get database connection after retries");
}

export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClientWithRetry();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClientWithRetry();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Typed query helpers
export interface Work {
  id: number;
  ol_work_key: string | null;
  title: string;
  subtitle: string | null;
  description: string | null;
  first_publish_year: number | null;
  language: string | null;
  series: string | null;
  page_count_median: number | null;
  embedding: number[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface Edition {
  id: number;
  work_id: number;
  ol_edition_key: string | null;
  isbn10: string | null;
  isbn13: string | null;
  publisher: string | null;
  pub_date: Date | null;
  page_count: number | null;
  cover_id: string | null;
  created_at: Date;
}

export interface Author {
  id: number;
  ol_author_key: string | null;
  name: string;
  bio: string | null;
  created_at: Date;
}

export interface UserEvent {
  user_id: string;
  work_id: number;
  shelf: string | null;
  rating: number | null;
  finished_at: Date | null;
  source: string;
  notes: string | null;
  created_at: Date;
}

export interface UserProfile {
  user_id: string;
  profile_vec: number[] | null;
  anchors: { work_id: number; title: string; weight: number }[];
  updated_at: Date;
}
