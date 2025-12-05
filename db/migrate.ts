import "dotenv/config";
import { Pool, type PoolClient } from "pg";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function ensureMigrationsTable(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_migrations" (
      id          SERIAL PRIMARY KEY,
      filename    TEXT UNIQUE NOT NULL,
      applied_at  TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrations(client: PoolClient): Promise<Set<string>> {
  const result = await client.query<{ filename: string }>(`SELECT filename FROM "_migrations" ORDER BY filename`);
  return new Set(result.rows.map((row) => row.filename));
}

async function applyMigration(
  client: PoolClient,
  filename: string,
  sql: string
) {
  console.log(`Applying migration: ${filename}`);
  await client.query(sql);
  await client.query(`INSERT INTO "_migrations" (filename) VALUES ($1)`, [filename]);
  console.log(`  ✓ Applied ${filename}`);
}

async function applyMigrationStatements(
  client: PoolClient,
  filename: string,
  sql: string
) {
  console.log(`Applying migration (no transaction): ${filename}`);
  const statements = sql
    .split(";")
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);

  for (const stmt of statements) {
    await client.query(stmt);
  }

  await client.query(`INSERT INTO "_migrations" (filename) VALUES ($1)`, [filename]);
  console.log(`  ✓ Applied ${filename}`);
}

async function main() {
  const migrationsDir = join(import.meta.dirname, "migrations");
  const files = await readdir(migrationsDir);
  const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();

  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    let appliedCount = 0;
    for (const filename of sqlFiles) {
      if (applied.has(filename)) {
        console.log(`Skipping (already applied): ${filename}`);
        continue;
      }

      const filePath = join(migrationsDir, filename);
      const sql = await readFile(filePath, "utf-8");
      const needsNoTransaction = /CONCURRENTLY/i.test(sql);

      if (needsNoTransaction) {
        try {
          await applyMigrationStatements(client, filename, sql);
          appliedCount++;
        } catch (error) {
          console.error(`Failed to apply ${filename}:`, error);
          throw error;
        }
      } else {
        await client.query("BEGIN");
        try {
          await applyMigration(client, filename, sql);
          await client.query("COMMIT");
          appliedCount++;
        } catch (error) {
          await client.query("ROLLBACK");
          console.error(`Failed to apply ${filename}:`, error);
          throw error;
        }
      }
    }

    console.log(`\nMigration complete. Applied ${appliedCount} new migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
