-- Cache for generated explanations
CREATE TABLE IF NOT EXISTS "ExplanationCache" (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  work_id      BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  anchors_hash TEXT NOT NULL,    -- hash of anchor books used for explanation
  reasons      TEXT[] NOT NULL,
  quality      TEXT NOT NULL,    -- 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-'
  confidence   NUMERIC(4,3),
  created_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, work_id, anchors_hash)
);

CREATE INDEX IF NOT EXISTS explanation_cache_user_work_idx ON "ExplanationCache"(user_id, work_id);
