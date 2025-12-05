-- Add GIN trigram index on Work.title for fast similarity searches
-- This enables efficient duplicate detection during book resolution
--
-- Note: This index takes a while to build on large tables (~18M rows)
-- Run during off-peak hours or with CONCURRENTLY option

-- Ensure pg_trgm extension is loaded
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create GIN trigram index for similarity() queries
-- Using CONCURRENTLY to avoid locking the table during creation
CREATE INDEX CONCURRENTLY IF NOT EXISTS work_title_trgm_idx
ON "Work" USING gin (LOWER(title) gin_trgm_ops);

-- After this index is created, re-enable checkAndMergeDuplicates in:
-- lib/ingest/resolverV2.ts (line ~247)
