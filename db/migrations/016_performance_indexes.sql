-- Performance indexes for common query patterns
-- Migration: 016_performance_indexes.sql

-- WorkQuality is frequently joined but only has pkey on work_id
-- Add indexes for sorting columns
CREATE INDEX CONCURRENTLY IF NOT EXISTS work_quality_work_id_idx
  ON "WorkQuality" (work_id);

-- Work.source is used for filtering in many queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS work_source_idx
  ON "Work" (source)
  WHERE source IS NOT NULL;

-- Composite index for finding user works that need enrichment
CREATE INDEX CONCURRENTLY IF NOT EXISTS work_stub_source_idx
  ON "Work" (is_stub, source)
  WHERE is_stub = true;

-- Index for description enrichment queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS work_no_description_idx
  ON "Work" (id)
  WHERE description IS NULL;

-- Edition cover lookups - prioritize by cover availability
CREATE INDEX CONCURRENTLY IF NOT EXISTS edition_work_cover_idx
  ON "Edition" (work_id, cover_url NULLS LAST, cover_id NULLS LAST);

-- UserEvent lookups for recommendations (exclude already-read)
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_event_user_shelf_idx
  ON "UserEvent" (user_id, shelf);

-- Author name lookups for fuzzy matching
CREATE INDEX CONCURRENTLY IF NOT EXISTS author_name_lower_idx
  ON "Author" (LOWER(name));

-- Trigram index for fuzzy author name matching (requires pg_trgm)
CREATE INDEX CONCURRENTLY IF NOT EXISTS author_name_trgm_idx
  ON "Author" USING gin (name gin_trgm_ops);

-- Trigram index for fuzzy work title matching
CREATE INDEX CONCURRENTLY IF NOT EXISTS work_title_trgm_idx
  ON "Work" USING gin (title gin_trgm_ops);
