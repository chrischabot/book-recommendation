-- User profile vectors and metadata
CREATE TABLE IF NOT EXISTS "UserProfile" (
  user_id      TEXT PRIMARY KEY,
  profile_vec  VECTOR(3072), -- aggregated taste vector
  anchors      JSONB,        -- top books that define this user's taste
  updated_at   TIMESTAMP DEFAULT NOW()
);

-- Index for potential multi-user scenarios
CREATE INDEX IF NOT EXISTS user_profile_updated_idx ON "UserProfile"(updated_at);
