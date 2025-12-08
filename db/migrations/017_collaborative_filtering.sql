-- Collaborative filtering tables
-- Precomputed item-item similarity for "users who read X also read Y"

-- Work co-occurrence with Jaccard similarity
CREATE TABLE IF NOT EXISTS "WorkCooccurrence" (
  work_key_a TEXT NOT NULL,
  work_key_b TEXT NOT NULL,
  overlap INT NOT NULL,
  jaccard NUMERIC(6,5) NOT NULL,
  readers_a INT,
  readers_b INT,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (work_key_a, work_key_b)
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS cooccurrence_a_jaccard_idx
  ON "WorkCooccurrence"(work_key_a, jaccard DESC);
CREATE INDEX IF NOT EXISTS cooccurrence_b_jaccard_idx
  ON "WorkCooccurrence"(work_key_b, jaccard DESC);
CREATE INDEX IF NOT EXISTS cooccurrence_overlap_idx
  ON "WorkCooccurrence"(overlap DESC);

-- Add community_id to Work table for book clustering
ALTER TABLE "Work" ADD COLUMN IF NOT EXISTS community_id INT;
CREATE INDEX IF NOT EXISTS work_community_idx ON "Work"(community_id);

-- Book communities table (metadata about detected communities)
CREATE TABLE IF NOT EXISTS "BookCommunity" (
  id SERIAL PRIMARY KEY,
  name TEXT,
  description TEXT,
  member_count INT DEFAULT 0,
  top_subjects TEXT[],
  top_authors TEXT[],
  created_at TIMESTAMP DEFAULT NOW()
);
