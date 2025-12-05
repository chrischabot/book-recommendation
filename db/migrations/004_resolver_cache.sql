-- Cache for ISBN/title resolution lookups
CREATE TABLE IF NOT EXISTS "ResolverCache" (
  lookup_key   TEXT PRIMARY KEY,  -- e.g., 'isbn:9780123456789' or 'title:The Hobbit|author:Tolkien'
  work_id      BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  confidence   NUMERIC(3,2),
  created_at   TIMESTAMP DEFAULT NOW(),
  expires_at   TIMESTAMP DEFAULT (NOW() + INTERVAL '90 days')
);

CREATE INDEX IF NOT EXISTS resolver_cache_work_idx ON "ResolverCache"(work_id);
CREATE INDEX IF NOT EXISTS resolver_cache_expires_idx ON "ResolverCache"(expires_at);
