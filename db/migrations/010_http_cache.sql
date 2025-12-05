-- HTTP response cache for external API calls
-- Reduces redundant network requests with configurable TTL

CREATE TABLE IF NOT EXISTS "HttpCache" (
  cache_key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  status INT NOT NULL,
  body TEXT NOT NULL,
  headers JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

-- Index for cache cleanup jobs
CREATE INDEX IF NOT EXISTS http_cache_expires_idx ON "HttpCache"(expires_at);

-- Index for debugging/inspecting cached URLs
CREATE INDEX IF NOT EXISTS http_cache_url_idx ON "HttpCache"(url);
