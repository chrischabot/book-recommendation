-- Materialized view / table for blended quality scores
CREATE TABLE IF NOT EXISTS "WorkQuality" (
  work_id        BIGINT PRIMARY KEY REFERENCES "Work"(id) ON DELETE CASCADE,
  blended_avg    NUMERIC(4,3),
  blended_wilson NUMERIC(4,3),
  total_ratings  INT,
  updated_at     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS work_quality_blended_avg_idx ON "WorkQuality"(blended_avg DESC);
CREATE INDEX IF NOT EXISTS work_quality_total_ratings_idx ON "WorkQuality"(total_ratings DESC);
