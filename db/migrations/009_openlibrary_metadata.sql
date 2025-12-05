-- Add Open Library dump metadata columns (matching openlibrary-search pattern)
-- These track revision and last_modified from the 5-column TSV format:
-- type \t key \t revision \t last_modified \t json_data

-- Add revision and last_modified to core tables
ALTER TABLE "Work" ADD COLUMN IF NOT EXISTS ol_revision INT;
ALTER TABLE "Work" ADD COLUMN IF NOT EXISTS ol_last_modified DATE;

ALTER TABLE "Edition" ADD COLUMN IF NOT EXISTS ol_revision INT;
ALTER TABLE "Edition" ADD COLUMN IF NOT EXISTS ol_last_modified DATE;

ALTER TABLE "Author" ADD COLUMN IF NOT EXISTS ol_revision INT;
ALTER TABLE "Author" ADD COLUMN IF NOT EXISTS ol_last_modified DATE;

-- EditionISBN junction table for multi-ISBN lookup
-- An edition can have multiple ISBN-10 and ISBN-13 values
-- This follows the pattern from openlibrary-search/db_scripts/tbl_edition_isbns.sql
CREATE TABLE IF NOT EXISTS "EditionISBN" (
  edition_id   BIGINT REFERENCES "Edition"(id) ON DELETE CASCADE,
  isbn         TEXT NOT NULL,
  isbn_type    TEXT NOT NULL, -- 'isbn10' | 'isbn13'
  PRIMARY KEY (edition_id, isbn)
);

CREATE INDEX IF NOT EXISTS edition_isbn_lookup_idx ON "EditionISBN"(isbn);
CREATE INDEX IF NOT EXISTS edition_isbn_type_idx ON "EditionISBN"(isbn_type);

-- Function to populate EditionISBN from existing ol_data JSONB
-- Run this after ingesting editions to extract all ISBNs
CREATE OR REPLACE FUNCTION populate_edition_isbns()
RETURNS VOID AS $$
BEGIN
  -- Insert ISBN-13s
  INSERT INTO "EditionISBN" (edition_id, isbn, isbn_type)
  SELECT DISTINCT e.id, isbn, 'isbn13'
  FROM "Edition" e,
       jsonb_array_elements_text(e.ol_data->'isbn_13') AS isbn
  WHERE e.ol_data IS NOT NULL
    AND jsonb_typeof(e.ol_data->'isbn_13') = 'array'
    AND jsonb_array_length(e.ol_data->'isbn_13') > 0
  ON CONFLICT DO NOTHING;

  -- Insert ISBN-10s
  INSERT INTO "EditionISBN" (edition_id, isbn, isbn_type)
  SELECT DISTINCT e.id, isbn, 'isbn10'
  FROM "Edition" e,
       jsonb_array_elements_text(e.ol_data->'isbn_10') AS isbn
  WHERE e.ol_data IS NOT NULL
    AND jsonb_typeof(e.ol_data->'isbn_10') = 'array'
    AND jsonb_array_length(e.ol_data->'isbn_10') > 0
  ON CONFLICT DO NOTHING;

  -- Also handle legacy 'isbn' array if present
  INSERT INTO "EditionISBN" (edition_id, isbn, isbn_type)
  SELECT DISTINCT e.id, isbn,
         CASE WHEN length(isbn) = 13 THEN 'isbn13' ELSE 'isbn10' END
  FROM "Edition" e,
       jsonb_array_elements_text(e.ol_data->'isbn') AS isbn
  WHERE e.ol_data IS NOT NULL
    AND jsonb_typeof(e.ol_data->'isbn') = 'array'
    AND jsonb_array_length(e.ol_data->'isbn') > 0
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Function to find edition by any ISBN (10 or 13)
CREATE OR REPLACE FUNCTION find_edition_by_isbn(p_isbn TEXT)
RETURNS SETOF "Edition" AS $$
BEGIN
  RETURN QUERY
  SELECT e.*
  FROM "Edition" e
  JOIN "EditionISBN" ei ON ei.edition_id = e.id
  WHERE ei.isbn = p_isbn;
END;
$$ LANGUAGE plpgsql STABLE;

-- Index for last_modified to efficiently find recent updates
CREATE INDEX IF NOT EXISTS work_ol_last_modified_idx ON "Work"(ol_last_modified);
CREATE INDEX IF NOT EXISTS edition_ol_last_modified_idx ON "Edition"(ol_last_modified);
CREATE INDEX IF NOT EXISTS author_ol_last_modified_idx ON "Author"(ol_last_modified);
