-- Graph-derived features for works (computed via Apache AGE)
CREATE TABLE IF NOT EXISTS "WorkGraphFeatures" (
  work_id         BIGINT PRIMARY KEY REFERENCES "Work"(id) ON DELETE CASCADE,
  author_affinity NUMERIC(5,4),  -- strength of author connection to user's favorites
  subject_overlap NUMERIC(5,4),  -- overlap with user's preferred subjects
  same_series     BOOLEAN DEFAULT FALSE,
  community_id    INT,           -- label propagation community
  prox_score      NUMERIC(5,4),  -- graph proximity score
  updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS work_graph_features_community_idx ON "WorkGraphFeatures"(community_id);
CREATE INDEX IF NOT EXISTS work_graph_features_prox_idx ON "WorkGraphFeatures"(prox_score DESC);
