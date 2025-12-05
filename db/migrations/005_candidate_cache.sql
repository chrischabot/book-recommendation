-- Cache for recommendation candidate lists
CREATE TABLE IF NOT EXISTS "CandidateCache" (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  mode         TEXT NOT NULL,    -- 'general' | 'by-book' | 'by-category'
  cache_key    TEXT NOT NULL,    -- e.g., work_id for by-book, slug for by-category
  work_ids     BIGINT[] NOT NULL,
  scores       NUMERIC(6,4)[],
  created_at   TIMESTAMP DEFAULT NOW(),
  expires_at   TIMESTAMP DEFAULT (NOW() + INTERVAL '24 hours'),
  UNIQUE (user_id, mode, cache_key)
);

CREATE INDEX IF NOT EXISTS candidate_cache_user_mode_idx ON "CandidateCache"(user_id, mode);
CREATE INDEX IF NOT EXISTS candidate_cache_expires_idx ON "CandidateCache"(expires_at);
