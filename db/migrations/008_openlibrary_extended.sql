-- Extended Open Library data tables
-- Adds support for reading-log, redirects, covers, wikidata, and lists

-- Enable pg_trgm for text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add raw JSONB columns to existing tables for full data access
ALTER TABLE "Work" ADD COLUMN IF NOT EXISTS ol_data JSONB;
ALTER TABLE "Edition" ADD COLUMN IF NOT EXISTS ol_data JSONB;
ALTER TABLE "Author" ADD COLUMN IF NOT EXISTS ol_data JSONB;

-- GIN indexes for JSONB querying
CREATE INDEX IF NOT EXISTS work_ol_data_gin ON "Work" USING gin (ol_data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS edition_ol_data_gin ON "Edition" USING gin (ol_data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS author_ol_data_gin ON "Author" USING gin (ol_data jsonb_path_ops);

-- Open Library Reading Log (community reading activity)
-- Format: work_key, edition_key, date, user_key, status
CREATE TABLE IF NOT EXISTS "OLReadingLog" (
  id            BIGSERIAL PRIMARY KEY,
  work_key      TEXT NOT NULL,
  edition_key   TEXT,
  ol_user_key   TEXT NOT NULL,
  status        TEXT NOT NULL, -- 'want-to-read' | 'currently-reading' | 'already-read'
  logged_date   DATE,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ol_reading_log_work_idx ON "OLReadingLog"(work_key);
CREATE INDEX IF NOT EXISTS ol_reading_log_user_idx ON "OLReadingLog"(ol_user_key);
CREATE INDEX IF NOT EXISTS ol_reading_log_status_idx ON "OLReadingLog"(status);
CREATE INDEX IF NOT EXISTS ol_reading_log_work_status_idx ON "OLReadingLog"(work_key, status);

-- Open Library Ratings (aggregated from individual user ratings)
-- We keep our Rating table for aggregated ratings, this stores individual OL ratings
CREATE TABLE IF NOT EXISTS "OLRating" (
  id            BIGSERIAL PRIMARY KEY,
  work_key      TEXT NOT NULL,
  edition_key   TEXT,
  ol_user_key   TEXT NOT NULL,
  rating        SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  rated_date    DATE,
  created_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE (work_key, ol_user_key)
);

CREATE INDEX IF NOT EXISTS ol_rating_work_idx ON "OLRating"(work_key);
CREATE INDEX IF NOT EXISTS ol_rating_user_idx ON "OLRating"(ol_user_key);

-- Redirects for merged/moved entities
CREATE TABLE IF NOT EXISTS "OLRedirect" (
  old_key       TEXT PRIMARY KEY,
  new_key       TEXT NOT NULL,
  entity_type   TEXT NOT NULL, -- 'work' | 'edition' | 'author'
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ol_redirect_new_key_idx ON "OLRedirect"(new_key);
CREATE INDEX IF NOT EXISTS ol_redirect_type_idx ON "OLRedirect"(entity_type);

-- Cover metadata
CREATE TABLE IF NOT EXISTS "OLCover" (
  cover_id      TEXT PRIMARY KEY,
  archive_id    TEXT,
  edition_key   TEXT,
  author_key    TEXT,
  width         INT,
  height        INT,
  size_small    TEXT, -- URL suffix for small size
  size_medium   TEXT, -- URL suffix for medium size
  size_large    TEXT, -- URL suffix for large size
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ol_cover_edition_idx ON "OLCover"(edition_key);
CREATE INDEX IF NOT EXISTS ol_cover_author_idx ON "OLCover"(author_key);

-- Wikidata links for enriched metadata
CREATE TABLE IF NOT EXISTS "OLWikidata" (
  ol_key        TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL, -- 'work' | 'edition' | 'author'
  wikidata_id   TEXT NOT NULL, -- e.g., 'Q12345'
  data          JSONB,         -- Additional Wikidata properties
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ol_wikidata_id_idx ON "OLWikidata"(wikidata_id);
CREATE INDEX IF NOT EXISTS ol_wikidata_type_idx ON "OLWikidata"(entity_type);

-- User-created book lists
CREATE TABLE IF NOT EXISTS "OLList" (
  id            BIGSERIAL PRIMARY KEY,
  list_key      TEXT UNIQUE NOT NULL, -- e.g., '/people/user/lists/OL123L'
  ol_user_key   TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  seed_count    INT DEFAULT 0,
  data          JSONB,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ol_list_user_idx ON "OLList"(ol_user_key);
CREATE INDEX IF NOT EXISTS ol_list_name_idx ON "OLList" USING gin (name gin_trgm_ops);

-- List seeds (works/editions in lists)
CREATE TABLE IF NOT EXISTS "OLListSeed" (
  list_id       BIGINT REFERENCES "OLList"(id) ON DELETE CASCADE,
  seed_key      TEXT NOT NULL, -- work or edition key
  seed_type     TEXT NOT NULL, -- 'work' | 'edition'
  position      INT,
  PRIMARY KEY (list_id, seed_key)
);

CREATE INDEX IF NOT EXISTS ol_list_seed_key_idx ON "OLListSeed"(seed_key);

-- Materialized view for work popularity based on reading activity
CREATE MATERIALIZED VIEW IF NOT EXISTS "WorkPopularity" AS
SELECT
  work_key,
  COUNT(*) FILTER (WHERE status = 'already-read') as read_count,
  COUNT(*) FILTER (WHERE status = 'currently-reading') as reading_count,
  COUNT(*) FILTER (WHERE status = 'want-to-read') as want_count,
  COUNT(DISTINCT ol_user_key) as unique_users,
  COUNT(*) as total_logs
FROM "OLReadingLog"
GROUP BY work_key;

CREATE UNIQUE INDEX IF NOT EXISTS work_popularity_key_idx ON "WorkPopularity"(work_key);

-- Materialized view for aggregated OL ratings
CREATE MATERIALIZED VIEW IF NOT EXISTS "WorkOLRating" AS
SELECT
  work_key,
  AVG(rating)::NUMERIC(3,2) as avg_rating,
  COUNT(*) as rating_count,
  COUNT(*) FILTER (WHERE rating = 5) as five_star,
  COUNT(*) FILTER (WHERE rating = 4) as four_star,
  COUNT(*) FILTER (WHERE rating = 3) as three_star,
  COUNT(*) FILTER (WHERE rating = 2) as two_star,
  COUNT(*) FILTER (WHERE rating = 1) as one_star
FROM "OLRating"
GROUP BY work_key;

CREATE UNIQUE INDEX IF NOT EXISTS work_ol_rating_key_idx ON "WorkOLRating"(work_key);

-- Helper function to resolve redirected keys
CREATE OR REPLACE FUNCTION resolve_ol_key(p_key TEXT)
RETURNS TEXT AS $$
DECLARE
  resolved TEXT := p_key;
  redirect_key TEXT;
  max_depth INT := 10;
  depth INT := 0;
BEGIN
  LOOP
    SELECT new_key INTO redirect_key FROM "OLRedirect" WHERE old_key = resolved;
    IF redirect_key IS NULL THEN
      RETURN resolved;
    END IF;
    resolved := redirect_key;
    depth := depth + 1;
    IF depth >= max_depth THEN
      RETURN resolved; -- Prevent infinite loops
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql STABLE;
