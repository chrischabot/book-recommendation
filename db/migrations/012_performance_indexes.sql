-- Performance optimization indexes and materialized views
-- Addresses critical database slowdowns identified in performance analysis

-- =============================================================================
-- 1. CRITICAL: Vector dimension reduction and index for similarity search
-- pgvector has 2000 dimension limit for HNSW and IVFFlat indexes.
-- We use OpenAI's dimension reduction (text-embedding-3-large supports 256-3072)
-- to reduce from 3072 to 1536 dimensions, enabling efficient vector indexing.
-- =============================================================================

-- Step 1: Clear existing embeddings (they're 3072-dim, need to regenerate at 1536)
UPDATE "Work" SET embedding = NULL WHERE embedding IS NOT NULL;
UPDATE "UserProfile" SET profile_vec = NULL WHERE profile_vec IS NOT NULL;

-- Step 2: Alter columns to new dimension (1536)
ALTER TABLE "Work" ALTER COLUMN embedding TYPE VECTOR(1536);
ALTER TABLE "UserProfile" ALTER COLUMN profile_vec TYPE VECTOR(1536);

-- Step 3: Create IVFFlat index for fast similarity search
-- lists = 500 is good for datasets up to 1M rows
-- For larger datasets, increase to sqrt(rows) / 10
DROP INDEX IF EXISTS work_embedding_ivfflat;
CREATE INDEX work_embedding_ivfflat
ON "Work" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 500);

-- =============================================================================
-- 2. Missing indexes on junction tables for JOIN performance
-- =============================================================================

-- WorkAuthor: Add index on work_id (only author_id was indexed)
CREATE INDEX IF NOT EXISTS work_author_work_id_idx ON "WorkAuthor"(work_id);

-- WorkSubject: Add index on work_id (only subject was indexed)
CREATE INDEX IF NOT EXISTS work_subject_work_id_idx ON "WorkSubject"(work_id);

-- =============================================================================
-- 3. Composite index for OLReadingLog queries with sorting
-- =============================================================================

CREATE INDEX IF NOT EXISTS ol_reading_log_work_status_date_idx
ON "OLReadingLog"(work_key, status, logged_date DESC);

-- =============================================================================
-- 4. Remove unused GIN indexes on JSONB columns
-- These are never queried but add significant write overhead
-- =============================================================================

DROP INDEX IF EXISTS work_ol_data_gin;
DROP INDEX IF EXISTS edition_ol_data_gin;
DROP INDEX IF EXISTS author_ol_data_gin;

-- =============================================================================
-- 5. Materialized view for pre-aggregated author names
-- Speeds up reranking which needs author names for every recommendation
-- =============================================================================

DROP MATERIALIZED VIEW IF EXISTS work_authors_agg;

CREATE MATERIALIZED VIEW work_authors_agg AS
SELECT
  wa.work_id,
  array_agg(a.id ORDER BY wa.role, a.name) AS author_ids,
  string_agg(a.name, ', ' ORDER BY wa.role, a.name) AS author_names,
  COUNT(*) AS author_count
FROM "WorkAuthor" wa
JOIN "Author" a ON wa.author_id = a.id
GROUP BY wa.work_id;

CREATE UNIQUE INDEX work_authors_agg_work_id_idx ON work_authors_agg(work_id);

-- =============================================================================
-- 6. Materialized view for pre-aggregated subject names
-- Speeds up candidate generation and explanation queries
-- =============================================================================

DROP MATERIALIZED VIEW IF EXISTS work_subjects_agg;

CREATE MATERIALIZED VIEW work_subjects_agg AS
SELECT
  ws.work_id,
  array_agg(ws.subject ORDER BY ws.subject) AS subjects,
  COUNT(*) AS subject_count
FROM "WorkSubject" ws
GROUP BY ws.work_id;

CREATE UNIQUE INDEX work_subjects_agg_work_id_idx ON work_subjects_agg(work_id);

-- =============================================================================
-- 7. Index for OLListSeed to support efficient list mate lookups
-- Extracts work key for direct matching instead of LIKE patterns
-- =============================================================================

-- Add column to store normalized work key for efficient lookups
ALTER TABLE "OLListSeed" ADD COLUMN IF NOT EXISTS seed_work_key TEXT;

-- Populate the column (extract work key from seed_key)
UPDATE "OLListSeed"
SET seed_work_key = CASE
  WHEN seed_key LIKE '%/works/%' THEN substring(seed_key from '/works/([^/]+)$')
  ELSE NULL
END
WHERE seed_work_key IS NULL;

-- Create index on the extracted work key
CREATE INDEX IF NOT EXISTS ol_list_seed_work_key_idx ON "OLListSeed"(seed_work_key)
WHERE seed_work_key IS NOT NULL;

-- =============================================================================
-- 8. Helper function to refresh all performance materialized views
-- =============================================================================

CREATE OR REPLACE FUNCTION refresh_performance_views()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY work_authors_agg;
  REFRESH MATERIALIZED VIEW CONCURRENTLY work_subjects_agg;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 9. Cache tables already have indexes on expires_at from their migrations
-- No additional indexes needed - the existing indexes are sufficient for
-- cleanup queries like: DELETE FROM cache WHERE expires_at < NOW()
-- =============================================================================
