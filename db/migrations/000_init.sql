-- Core schema for book recommender
-- Extensions are already loaded via docker init scripts
--
-- IMPORTANT: ON CONFLICT Usage
-- When using ON CONFLICT in application code, always specify explicit constraint columns:
--   ON CONFLICT (col1, col2) DO NOTHING     -- Good
--   ON CONFLICT DO NOTHING                  -- Bad - PostgreSQL may not infer constraint
--
-- Primary keys for ON CONFLICT reference:
--   WorkAuthor:  (work_id, author_id, role)
--   WorkSubject: (work_id, subject)
--   Subject:     (subject)
--   Rating:      (work_id, source)
--   UserEvent:   (user_id, work_id, source)
--   KindleOwnership:      (user_id, asin, right_type)
--   UserCompletionEvent:  (user_id, asin, method, completed_at)
--   UserReadingSession:   (user_id, asin, start_at, source)
--   UserReadingDay:       (user_id, day, source)
--   UserReadingAggregate: (user_id, asin)

-- Works table (normalized representation of a book)
CREATE TABLE IF NOT EXISTS "Work" (
  id                BIGSERIAL PRIMARY KEY,
  ol_work_key       TEXT UNIQUE,
  title             TEXT NOT NULL,
  subtitle          TEXT,
  description       TEXT,
  first_publish_year INT,
  language          TEXT,
  series            TEXT,
  page_count_median INT,
  embedding         VECTOR(3072), -- text-embedding-3-large dimension
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW()
);

-- Editions table (physical manifestations of works)
CREATE TABLE IF NOT EXISTS "Edition" (
  id            BIGSERIAL PRIMARY KEY,
  work_id       BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  ol_edition_key TEXT UNIQUE,
  isbn10        TEXT,
  isbn13        TEXT UNIQUE,
  publisher     TEXT,
  pub_date      DATE,
  page_count    INT,
  cover_id      TEXT,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Authors table
CREATE TABLE IF NOT EXISTS "Author" (
  id            BIGSERIAL PRIMARY KEY,
  ol_author_key TEXT UNIQUE,
  name          TEXT NOT NULL,
  bio           TEXT,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Work-Author junction table
CREATE TABLE IF NOT EXISTS "WorkAuthor" (
  work_id   BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  author_id BIGINT REFERENCES "Author"(id) ON DELETE CASCADE,
  role      TEXT DEFAULT 'author',
  PRIMARY KEY (work_id, author_id, role)
);

-- Subjects table
CREATE TABLE IF NOT EXISTS "Subject" (
  subject TEXT PRIMARY KEY,
  typ     TEXT -- e.g., 'subject', 'place', 'person', 'time'
);

-- Work-Subject junction table
CREATE TABLE IF NOT EXISTS "WorkSubject" (
  work_id  BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  subject  TEXT REFERENCES "Subject"(subject) ON DELETE CASCADE,
  PRIMARY KEY (work_id, subject)
);

-- Ratings from various sources
CREATE TABLE IF NOT EXISTS "Rating" (
  work_id      BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  source       TEXT NOT NULL, -- 'openlibrary' | 'googlebooks'
  avg          NUMERIC(3,2),
  count        INT,
  last_updated TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (work_id, source)
);

-- User events (reading history from imports)
CREATE TABLE IF NOT EXISTS "UserEvent" (
  user_id     TEXT NOT NULL,
  work_id     BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  shelf       TEXT,        -- read | to-read | currently-reading | dnf
  rating      NUMERIC(2,1),
  finished_at DATE,
  source      TEXT NOT NULL, -- goodreads | kindle
  notes       TEXT,
  created_at  TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, work_id, source)
);

-- Blocked works/authors per user
CREATE TABLE IF NOT EXISTS "Block" (
  id        BIGSERIAL PRIMARY KEY,
  user_id   TEXT NOT NULL,
  work_id   BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  author_id BIGINT REFERENCES "Author"(id) ON DELETE CASCADE,
  reason    TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Unique indexes for Block table (one per block type)
CREATE UNIQUE INDEX IF NOT EXISTS block_user_work_idx ON "Block"(user_id, work_id) WHERE work_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS block_user_author_idx ON "Block"(user_id, author_id) WHERE author_id IS NOT NULL;

-- Vector index for similarity search
-- Using IVFFlat instead of HNSW because HNSW has 2000 dimension limit
-- and text-embedding-3-large uses 3072 dimensions
-- Note: IVFFlat requires data to be present before index is useful
-- CREATE INDEX IF NOT EXISTS work_embedding_ivfflat
-- ON "Work" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Useful relational indexes
CREATE INDEX IF NOT EXISTS edition_isbn13_idx ON "Edition"(isbn13);
CREATE INDEX IF NOT EXISTS edition_isbn10_idx ON "Edition"(isbn10);
CREATE INDEX IF NOT EXISTS edition_work_id_idx ON "Edition"(work_id);
CREATE INDEX IF NOT EXISTS user_event_user_idx ON "UserEvent"(user_id);
CREATE INDEX IF NOT EXISTS user_event_work_idx ON "UserEvent"(work_id);
CREATE INDEX IF NOT EXISTS user_event_user_work_idx ON "UserEvent"(user_id, work_id);
CREATE INDEX IF NOT EXISTS work_author_author_idx ON "WorkAuthor"(author_id);
CREATE INDEX IF NOT EXISTS work_subject_subject_idx ON "WorkSubject"(subject);
CREATE INDEX IF NOT EXISTS work_title_idx ON "Work"(title);
CREATE INDEX IF NOT EXISTS work_first_publish_year_idx ON "Work"(first_publish_year);
