-- Long-tail book resolution: external identifiers and provenance tracking
-- Enables resolution of Kindle-only, Royal Road, and self-published titles

-- Edition: external identifiers for non-ISBN sources
ALTER TABLE "Edition"
  ADD COLUMN IF NOT EXISTS asin TEXT,
  ADD COLUMN IF NOT EXISTS google_volume_id TEXT,
  ADD COLUMN IF NOT EXISTS audible_asin TEXT,
  ADD COLUMN IF NOT EXISTS royalroad_fiction_id BIGINT,
  ADD COLUMN IF NOT EXISTS goodreads_book_id BIGINT,
  ADD COLUMN IF NOT EXISTS cover_url TEXT;

-- Unique indexes (partial - only where not null to allow multiple NULLs)
CREATE UNIQUE INDEX IF NOT EXISTS edition_asin_uidx
  ON "Edition"(asin) WHERE asin IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS edition_gb_uidx
  ON "Edition"(google_volume_id) WHERE google_volume_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS edition_audible_uidx
  ON "Edition"(audible_asin) WHERE audible_asin IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS edition_rr_uidx
  ON "Edition"(royalroad_fiction_id) WHERE royalroad_fiction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS edition_gr_uidx
  ON "Edition"(goodreads_book_id) WHERE goodreads_book_id IS NOT NULL;

-- Work: provenance tracking
ALTER TABLE "Work"
  ADD COLUMN IF NOT EXISTS source TEXT,              -- 'openlibrary' | 'googlebooks' | 'amazon' | 'royalroad' | 'manual'
  ADD COLUMN IF NOT EXISTS is_stub BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stub_reason TEXT;         -- why it couldn't be fully resolved

-- Index for finding stubs that need enrichment
CREATE INDEX IF NOT EXISTS work_stub_idx ON "Work"(is_stub) WHERE is_stub = TRUE;

-- Extended resolver log (supplements existing ResolverCache for audit/debugging)
CREATE TABLE IF NOT EXISTS "ResolverLog" (
  id BIGSERIAL PRIMARY KEY,
  input_key TEXT NOT NULL,           -- normalized lookup key
  input_data JSONB,                  -- what we received
  path_taken TEXT,                   -- 'isbn_ol' | 'isbn_gb' | 'title_gb' | 'asin' | 'royalroad' | 'manual'
  work_id BIGINT REFERENCES "Work"(id) ON DELETE SET NULL,
  edition_id BIGINT REFERENCES "Edition"(id) ON DELETE SET NULL,
  confidence NUMERIC(3,2),
  created BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS resolver_log_work_idx ON "ResolverLog"(work_id);
CREATE INDEX IF NOT EXISTS resolver_log_confidence_idx ON "ResolverLog"(confidence);
CREATE INDEX IF NOT EXISTS resolver_log_path_idx ON "ResolverLog"(path_taken);
CREATE INDEX IF NOT EXISTS resolver_log_created_at_idx ON "ResolverLog"(created_at);

-- Merge audit log for tracking work deduplication
CREATE TABLE IF NOT EXISTS "WorkMergeLog" (
  id BIGSERIAL PRIMARY KEY,
  work_id_from BIGINT NOT NULL,      -- the duplicate that was merged away
  work_id_to BIGINT NOT NULL,        -- the canonical work that remains
  reason TEXT,                       -- why the merge happened
  editions_moved INT,                -- how many editions were moved
  merged_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS work_merge_log_to_idx ON "WorkMergeLog"(work_id_to);
CREATE INDEX IF NOT EXISTS work_merge_log_at_idx ON "WorkMergeLog"(merged_at);
