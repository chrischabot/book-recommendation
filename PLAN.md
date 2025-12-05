
# PLAN.md — Personal Book Recommender
**TypeScript‑first • Next.js App Router • PostgreSQL 16 + pgvector + Apache AGE (Postgres‑native graph) • OpenAI (embeddings + explanations) • No ORM (direct Postgres)**

A comprehensive, buildable plan for a *personal* book recommender that:
1) ingests a modern book catalog (normalized to **works**) and enriches ratings,
2) imports your history (**Goodreads CSV** + **Amazon/Kindle export**),
3) models your taste with **vectors** and **graph features** (Postgres‑native via **Apache AGE**),
4) returns **100 de‑duplicated, diverse, high‑confidence recommendations**,
5) serves **general**, **by‑book**, and **by‑category** recommendations (paginated),
6) renders a **beautiful Next.js UI**: cover, title, author, publish year, rating, **suggestion quality & reason**, and description,
7) uses **caching** aggressively across ingestion, features, API, and UI for speed,
8) uses **direct Postgres** (no Prisma) for full control of pgvector & AGE queries.

> This file is designed for you **and** a code‑generation agent. It includes human steps, scripts, and dependencies.


---

## 0) North Star

- **Input:** your reading history + a target (general | a specific book | a category).  
- **Output:** **Top‑100** recommendations (or paginated lists) that are: new‑to‑you, high‑quality, diverse, and include “because you liked …” reasons and confidence/quality indicators.


---

## 1) Tech Stack

- **Framework:** **Next.js (App Router)** on **Node 20+** with **pnpm**.
- **Database:** **PostgreSQL 16** with **pgvector** (vector similarity).  
- **Graph (Postgres‑native):** **Apache AGE** extension (openCypher inside Postgres). We maintain a property graph `books` with nodes `Work`, `Author`, `Subject`, `Series` and edges `WROTE`, `HAS_SUBJECT`, `IN_SERIES`.  
- **DB access:** **direct Postgres** via `pg` (node-postgres). Optional helpers: `postgres` (porsager/postgres) or `pgtyped` (for typed SQL). No ORM.  
- **Embeddings & LLM:** **OpenAI** (Node SDK):  
  - Embeddings: `text-embedding-3-large` (or current recommended).  
  - Explanations/Reasons: `gpt-5-mini` by default (fast/cost‑efficient), escalate to `gpt-5` for higher‑touch copy.  
- **Styling/UI:** Tailwind CSS + shadcn/ui components.  
- **Caching:** multi‑layer (§8): Redis (optional), Postgres materialized views, Next.js `unstable_cache` & `revalidateTag`, ETL disk cache.  
- **Rate limiting:** bottleneck.  
- **Testing:** Vitest + Playwright.


---

## 2) Repository Layout

```
book-recommender/
  ├─ README.md
  ├─ PLAN.md                         # this file
  ├─ .env.example
  ├─ docker/
  │   ├─ docker-compose.yml          # postgres+AGE, (optional) redis
  │   └─ init/
  │       ├─ 00-init.sql             # CREATE EXTENSION vector, age; graph bootstrap
  │       └─ 01-age-bootstrap.sql    # create graph, labels, indexes
  ├─ db/
  │   ├─ migrations/                 # raw SQL migrations (ordered 000_*.sql)
  │   ├─ migrate.ts                  # simple runner that applies new .sql files
  │   └─ seed/                       # optional seed data
  ├─ app/                            # Next.js App Router
  │   ├─ api/
  │   │   └─ recommendations/
  │   │       ├─ general/route.ts    # GET general recs (paginated)
  │   │       ├─ by-book/route.ts    # GET recs from a seed book
  │   │       └─ by-category/route.ts# GET recs for a category (paginated)
  │   ├─ (routes)/
  │   │   ├─ recommendations/page.tsx
  │   │   ├─ book/[workId]/page.tsx
  │   │   └─ category/[slug]/page.tsx
  │   └─ layout.tsx
  ├─ lib/
  │   ├─ config/
  │   │   ├─ env.ts
  │   │   └─ categories.yaml
  │   ├─ db/
  │   │   ├─ pool.ts                 # pg Pool, prepared statements
  │   │   ├─ sql.ts                  # helpers for vector/graph queries
  │   │   └─ vector.ts               # helpers to encode number[] → vector literal
  │   ├─ ingest/
  │   │   ├─ openlibrary.ts
  │   │   ├─ googlebooks.ts
  │   │   ├─ goodreads.ts
  │   │   ├─ kindle.ts
  │   │   └─ resolve.ts
  │   ├─ features/
  │   │   ├─ embeddings.ts
  │   │   ├─ ratings.ts
  │   │   ├─ userProfile.ts
  │   │   ├─ graph.ts                # AGE graph loaders & features
  │   │   └─ cache.ts
  │   ├─ recs/
  │   │   ├─ candidates.ts
  │   │   ├─ rerank.ts
  │   │   └─ explain.ts
  │   ├─ ui/
  │   │   ├─ RecommendationCard.tsx
  │   │   ├─ Grid.tsx
  │   │   └─ Pagination.tsx
  │   └─ util/
  │       ├─ covers.ts
  │       ├─ text.ts
  │       └─ logger.ts
  ├─ scripts/                        # ETL CLIs (tsx)
  │   ├─ ingest-openlibrary.ts
  │   ├─ enrich-googlebooks.ts
  │   ├─ import-goodreads.ts
  │   ├─ import-kindle.ts
  │   ├─ build-embeddings.ts
  │   ├─ build-user-profile.ts
  │   ├─ build-graph.ts
  │   └─ refresh-all.ts
  ├─ package.json
  ├─ pnpm-lock.yaml
  ├─ tailwind.config.ts
  ├─ postcss.config.js
  ├─ tsconfig.json
  └─ Makefile
```


---

## 3) Environment & Config

`.env.example`
```bash
# Postgres (AGE + pgvector)
DATABASE_URL="postgresql://books:books@localhost:5432/books?sslmode=disable"
PGPOOL_MIN=2
PGPOOL_MAX=20

# Optional Redis for response caching
REDIS_URL="redis://localhost:6379"

# OpenAI
OPENAI_API_KEY="sk-..."
OPENAI_EMBED_MODEL="text-embedding-3-large"
OPENAI_REASONING_MODEL="gpt-5-mini"   # default; set to 'gpt-5' to escalate

# Google Books
GOOGLE_BOOKS_API_KEY="..."

# Paths (ingestion)
OPENLIBRARY_DUMPS_DIR="./data/openlibrary"
GOODREADS_EXPORT_CSV="./data/goodreads/export.csv"
KINDLE_EXPORT_DIR="./data/kindle"
```

`lib/config/categories.yaml` (seed mapping)
```yaml
science-fiction:
  include: ["science_fiction"]
  exclude: ["juvenile_fiction"]
  years: "1950-"
hard-sci-fi:
  include: ["science_fiction", "hard_science_fiction"]
  years: "1980-"
high-fantasy:
  include: ["fantasy", "high_fantasy"]
biography-20th:
  include: ["biography", "twentieth_century"]
business-narrative:
  include: ["business", "nonfiction", "economics"]
```


---

## 4) Databases & Data Model

### 4.1 Schema (raw SQL; migrations in `db/migrations`)

Core tables (work/edition/author/subject/ratings/user events/blocks) + `embedding vector` and helper indexes.

`db/migrations/000_init.sql` (excerpt)
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SELECT * FROM create_graph('books');

CREATE TABLE "Work" (
  id                BIGSERIAL PRIMARY KEY,
  ol_work_key       TEXT UNIQUE,
  title             TEXT,
  subtitle          TEXT,
  description       TEXT,
  first_publish_year INT,
  language          TEXT,
  series            TEXT,
  page_count_median INT,
  embedding         VECTOR,         -- dimension set on index (3072 for text-embedding-3-large)
  ol_data           JSONB,          -- raw JSON from Open Library dump
  ol_revision       INT,            -- revision number from dump
  ol_last_modified  DATE            -- last_modified from dump
);

CREATE TABLE "Edition" (
  id             BIGSERIAL PRIMARY KEY,
  work_id        BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  ol_edition_key TEXT UNIQUE,
  isbn10         TEXT,
  isbn13         TEXT UNIQUE,
  publisher      TEXT,
  pub_date       DATE,
  page_count     INT,
  cover_id       TEXT,
  ol_data        JSONB,          -- raw JSON from Open Library dump
  ol_revision    INT,
  ol_last_modified DATE
);

-- Multi-ISBN lookup table (editions can have multiple ISBNs)
CREATE TABLE "EditionISBN" (
  edition_id   BIGINT REFERENCES "Edition"(id) ON DELETE CASCADE,
  isbn         TEXT NOT NULL,
  isbn_type    TEXT NOT NULL,   -- 'isbn10' | 'isbn13'
  PRIMARY KEY (edition_id, isbn)
);
CREATE INDEX edition_isbn_lookup_idx ON "EditionISBN"(isbn);

CREATE TABLE "Author" (
  id            BIGSERIAL PRIMARY KEY,
  ol_author_key TEXT UNIQUE,
  name          TEXT NOT NULL,
  bio           TEXT,
  ol_data       JSONB,
  ol_revision   INT,
  ol_last_modified DATE
);

CREATE TABLE "WorkAuthor" (
  work_id   BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  author_id BIGINT REFERENCES "Author"(id) ON DELETE CASCADE,
  role      TEXT DEFAULT 'author',
  PRIMARY KEY (work_id, author_id, role)
);

CREATE TABLE "Subject" (
  subject TEXT PRIMARY KEY,
  typ     TEXT
);

CREATE TABLE "WorkSubject" (
  work_id  BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  subject  TEXT REFERENCES "Subject"(subject),
  PRIMARY KEY (work_id, subject)
);

CREATE TABLE "Rating" (
  work_id      BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  source       TEXT, -- 'openlibrary' | 'googlebooks'
  avg          NUMERIC,
  count        INT,
  last_updated TIMESTAMP,
  PRIMARY KEY (work_id, source)
);

CREATE TABLE "UserEvent" (
  user_id     TEXT,
  work_id     BIGINT REFERENCES "Work"(id) ON DELETE CASCADE,
  shelf       TEXT,        -- read | to-read | dnf | etc
  rating      NUMERIC,
  finished_at DATE,
  source      TEXT,        -- goodreads | kindle
  PRIMARY KEY (user_id, work_id, source)
);

CREATE TABLE "Block" (
  user_id   TEXT,
  work_id   BIGINT,
  author_id BIGINT,
  PRIMARY KEY (user_id, work_id, author_id)
);

-- Vector indexes (cosine distance; HNSW for fast ANN)
CREATE INDEX IF NOT EXISTS work_embedding_hnsw
ON "Work" USING hnsw (embedding vector_cosine_ops);

-- Useful relational indexes
CREATE INDEX IF NOT EXISTS edition_isbn13_idx ON "Edition"(isbn13);
CREATE INDEX IF NOT EXISTS user_event_user_work_idx ON "UserEvent"(user_id, work_id);
```

> **Why direct Postgres?** You get full control of vector operators (`<=>` cosine, `<->` L2), ANN indexes (HNSW/IVFFlat), and AGE’s `cypher()` calls—no ORM impedance.

### 4.2 Extended Open Library Schema (`db/migrations/008_openlibrary_extended.sql`)

Tables for storing additional Open Library dump data:

```sql
-- Reading logs for collaborative filtering
CREATE TABLE "OLReadingLog" (
  id            BIGSERIAL PRIMARY KEY,
  work_key      TEXT NOT NULL,
  edition_key   TEXT,
  ol_user_key   TEXT NOT NULL,
  status        TEXT NOT NULL, -- 'want-to-read' | 'currently-reading' | 'already-read'
  logged_at     TIMESTAMP,
  UNIQUE(work_key, ol_user_key, status)
);
CREATE INDEX idx_ol_reading_log_work ON "OLReadingLog"(work_key);
CREATE INDEX idx_ol_reading_log_user ON "OLReadingLog"(ol_user_key);

-- Individual user ratings (complements aggregated Rating table)
CREATE TABLE "OLRating" (
  id           BIGSERIAL PRIMARY KEY,
  work_key     TEXT NOT NULL,
  edition_key  TEXT,
  ol_user_key  TEXT NOT NULL,
  rating       SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  rated_at     TIMESTAMP,
  UNIQUE(work_key, ol_user_key)
);

-- User-created lists (for "books in same list" signals)
CREATE TABLE "OLList" (
  id           BIGSERIAL PRIMARY KEY,
  ol_list_key  TEXT UNIQUE NOT NULL,
  ol_user_key  TEXT,
  name         TEXT,
  description  TEXT,
  seed_count   INT DEFAULT 0,
  created_at   TIMESTAMP,
  updated_at   TIMESTAMP
);

CREATE TABLE "OLListSeed" (
  id        BIGSERIAL PRIMARY KEY,
  list_id   BIGINT REFERENCES "OLList"(id) ON DELETE CASCADE,
  seed_key  TEXT NOT NULL, -- e.g., "/works/OL123W"
  seed_type TEXT NOT NULL, -- 'work' | 'edition' | 'author' | 'subject'
  UNIQUE(list_id, seed_key)
);
CREATE INDEX idx_ol_list_seed_key ON "OLListSeed"(seed_key);

-- Cover metadata
CREATE TABLE "OLCover" (
  id         BIGINT PRIMARY KEY, -- Open Library cover ID
  width      INT,
  height     INT,
  source_url TEXT,
  created_at TIMESTAMP
);

-- Wikidata links for enrichment
CREATE TABLE "OLWikidata" (
  ol_key       TEXT PRIMARY KEY, -- Work or Author key
  wikidata_id  TEXT NOT NULL,
  ol_type      TEXT NOT NULL -- 'work' | 'author'
);

-- Redirects for resolving merged/moved entities
CREATE TABLE "OLRedirect" (
  from_key TEXT PRIMARY KEY,
  to_key   TEXT NOT NULL,
  ol_type  TEXT NOT NULL -- 'work' | 'edition' | 'author'
);

-- Helper function to resolve redirected keys
CREATE OR REPLACE FUNCTION resolve_ol_key(p_key TEXT)
RETURNS TEXT AS $$
  -- Follows redirect chain up to 10 levels, returns final key
$$;

-- Helper function to find edition by any ISBN (10 or 13)
CREATE OR REPLACE FUNCTION find_edition_by_isbn(p_isbn TEXT)
RETURNS SETOF "Edition" AS $$
  -- Returns all editions matching the given ISBN
$$;

-- Materialized view for work popularity (from reading logs)
CREATE MATERIALIZED VIEW "WorkPopularity" AS
SELECT
  work_key,
  COUNT(*) FILTER (WHERE status = 'already-read') as read_count,
  COUNT(*) FILTER (WHERE status = 'currently-reading') as reading_count,
  COUNT(*) FILTER (WHERE status = 'want-to-read') as want_count,
  COUNT(DISTINCT ol_user_key) as unique_users,
  COUNT(*) as total_logs
FROM "OLReadingLog"
GROUP BY work_key;

CREATE UNIQUE INDEX idx_work_popularity_key ON "WorkPopularity"(work_key);
```

### 4.3 Apache AGE bootstrap

`db/migrations/010_age_schema.sql` (excerpt)
```sql
-- Labels & indexes inside AGE graph
SELECT * FROM cypher('books', $$
  CREATE INDEX ON :Work(id);
  CREATE INDEX ON :Author(id);
  CREATE INDEX ON :Subject(subject);
  CREATE INDEX ON :Series(series)
$$) AS (v agtype);
```

**Graph features (AGE):**
- Load nodes/edges from relational tables; keep IDs aligned.  
- Compute 1–2 hop proximities, author affinity, subject overlap, and simple label‑prop communities.  
- Persist features into relational table `work_graph_features(work_id, author_affinity, subject_overlap, same_series, community_id, prox_score, updated_at)` for fast joins.


---

## 5) Packages & Dependencies

### Runtime
```
pnpm add next react react-dom
pnpm add pg                            # node-postgres (pooled)
pnpm add openai                        # embeddings + explanations
pnpm add csv-parse bottleneck undici fast-fuzzy
pnpm add js-yaml zod
pnpm add ioredis                       # optional Redis cache
```

### Dev
```
pnpm add -D typescript tsx vitest playwright @types/node
```

### Scripts (`package.json` excerpt)
```jsonc
{
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "migrate": "tsx db/migrate.ts",
    "download:ol": "tsx scripts/download-openlibrary.ts",
    "ingest:ol": "tsx scripts/ingest-openlibrary.ts",
    "enrich:gb": "tsx scripts/enrich-googlebooks.ts",
    "import:goodreads": "tsx scripts/import-goodreads.ts",
    "import:kindle": "tsx scripts/import-kindle.ts",
    "features:embed": "tsx scripts/build-embeddings.ts",
    "profile:build": "tsx scripts/build-user-profile.ts",
    "graph:build": "tsx scripts/build-graph.ts",
    "refresh:all": "tsx scripts/refresh-all.ts",
    "update": "tsx scripts/update.ts",  // Full pipeline
    "test": "vitest run"
  }
}
```

### Full Update Pipeline

The `pnpm update` command runs all import/ingestion steps in order:

```bash
pnpm update                      # Full pipeline
pnpm update -- --quick           # Skip download/ingest, refresh features only
pnpm update -- --skip-download   # Use existing OL files
pnpm update -- --user jane       # Different user ID
```

Pipeline steps:
1. Download Open Library data
2. Ingest Open Library catalog
3. Enrich with Google Books API
4. Import Goodreads history (if file exists)
5. Import Kindle history (if directory exists)
6. Build work embeddings
7. Build user profile
8. Compute graph features


---

## 6) Docker Compose

`docker/docker-compose.yml` (excerpt)
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: books
      POSTGRES_PASSWORD: books
      POSTGRES_DB: books
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U books -d books"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7-alpine
    profiles: ["cache"]
    ports: ["6379:6379"]

volumes:
  pgdata: {}
```


---

## 7) Where to get the data (Human steps)

### 7.1 Open Library Data Dumps

Open Library provides comprehensive monthly data dumps at https://openlibrary.org/developers/dumps.

**Available dump files:**

| File | Size (compressed) | Description |
|------|-------------------|-------------|
| `works` | ~3.6 GB | All works (books as abstract entities) |
| `editions` | ~11 GB | All editions (physical/digital versions with ISBNs) |
| `authors` | ~700 MB | All authors |
| `ratings` | ~6 MB | User ratings (1-5 stars) with work key, edition key, date |
| `reading-log` | ~100 MB | User reading logs (want-to-read, currently-reading, already-read) |
| `redirects` | ~64 MB | Redirects for merged/moved works and editions |
| `covers-metadata` | ~70 MB | Cover image metadata (id, width, height, created) |
| `wikidata` | ~700 MB | Links to Wikidata entities for enriched metadata |
| `lists` | ~43 MB | User-created book lists |

**File format:** All dumps are gzip-compressed, tab-separated with 5 columns:
```
type    key    revision    last_modified    json_data
```

Example line from works dump:
```
/type/work	/works/OL45804W	14	2023-12-01T12:34:56.789012	{"title":"Moby Dick","authors":[{"author":{"key":"/authors/OL7950691A"}}],"subjects":["Whaling","Sea stories"],...}
```

**TypeScript interface for dump metadata (parsed from TSV columns):**
```typescript
interface DumpMetadata {
  type: string;        // e.g., "/type/work"
  key: string;         // e.g., "/works/OL45804W"
  revision: number | null;
  lastModified: string | null;  // ISO datetime
}
```

**JSON data structures by file type:**

Works (`data` column):
```typescript
interface OLWorkData {
  title: string;
  subtitle?: string;
  description?: string | { type: string; value: string };
  first_publish_date?: string;
  authors?: Array<{ author: { key: string } }>;
  subjects?: string[];
  subject_places?: string[];
  subject_people?: string[];
  subject_times?: string[];
  covers?: number[];  // Cover IDs
  links?: Array<{ url: string; title: string }>;
}
```

Editions (`data` column):
```typescript
interface OLEditionData {
  title: string;
  publishers?: string[];
  publish_date?: string;
  isbn_10?: string[];
  isbn_13?: string[];
  works?: Array<{ key: string }>;
  authors?: Array<{ key: string }>;
  covers?: number[];
  number_of_pages?: number;
  languages?: Array<{ key: string }>;
  physical_format?: string;
}
```

Authors (`data` column):
```typescript
interface OLAuthorData {
  name: string;
  personal_name?: string;
  birth_date?: string;
  death_date?: string;
  bio?: string | { type: string; value: string };
  links?: Array<{ url: string; title: string }>;
  remote_ids?: { wikidata?: string; viaf?: string; isni?: string };
}
```

Ratings (`TSV format`, no JSON):
```
work_key    edition_key    rating(1-5)    date
/works/OL45804W	/books/OL123M	5	2023-01-15
```

Reading-log (`TSV format`, no JSON):
```
work_key    edition_key    date    user_key    status
/works/OL45804W	/books/OL123M	2023-01-15	/people/john_doe	already-read
```
Status values: `want-to-read`, `currently-reading`, `already-read`

**Important notes about downloads:**
- The `openlibrary.org/data/*_latest.txt.gz` URLs redirect to Archive.org
- The "latest" dump may be **incomplete** (e.g., 2025-11-30 only had works, authors, redirects)
- Use `--dump-date` to specify a known complete dump (e.g., `2025-11-06`)
- Our download script automatically falls back to a complete dump when "latest" returns 404

**Download commands:**
```bash
# Download all files (full preset, ~15GB compressed)
pnpm download:ol

# Download specific preset
pnpm download:ol -- --preset minimal   # works, authors only (~4GB)
pnpm download:ol -- --preset core      # works, editions, authors (~15GB)
pnpm download:ol -- --preset full      # everything (~16GB)

# Download specific files
pnpm download:ol -- --files works,ratings,reading-log

# Use specific dump date (when latest is incomplete)
pnpm download:ol -- --dump-date 2025-11-06

# Force re-download (skips files < 5 days old by default)
pnpm download:ol -- --force
```

### 7.2 Goodreads Export

- Goodreads → *Account* → *Import/Export* → **Export Library**
- Save as `GOODREADS_EXPORT_CSV` (e.g., `./data/goodreads/export.csv`)

### 7.3 Amazon/Kindle Export

- Amazon Help → *Request your data*; when delivered, extract to `KINDLE_EXPORT_DIR`
- *(Optional)* Add `My Clippings.txt` for highlight‑based taste signals

### 7.4 Google Books API

- Create API key; set `GOOGLE_BOOKS_API_KEY` for ratings enrichment


---

## 8) Caching Strategy (multi‑layer)

| Layer | What we cache | How | TTL / Busting |
|------|----------------|-----|---------------|
| **ETL I/O** | Open Library & Google Books responses | Disk cache + ETag/Last‑Modified | ~30 days; manual refresh scripts |
| **Resolver** | ISBN→Work, Title/Author→Work | In‑process LRU + `resolver_cache` table | 90 days |
| **Embeddings** | Work vectors | Persist in `Work.embedding`; delta compute only | Bust when text fields change |
| **Graph** | AGE features (communities, proximities) | `work_graph_features` table | Nightly job; bust on new catalog |
| **Ratings blend** | `work_quality` (Bayes + Wilson) | Materialized view/table | Weekly or post‑enrichment |
| **User profile** | `user_profile` vectors & anchors | Table `user_profile` | Bust when user events change |
| **Candidate pools** | Per‑mode/Key lists (IDs + metadata) | `candidate_cache` table | Bust on profile/catalog change |
| **API responses** | JSON result sets | Redis (optional) + Next.js `unstable_cache` with tags | Bust via `revalidateTag` on imports |
| **UI media** | Covers, descriptions | Next.js `fetch` cache + `revalidate` | 7 days; bust on edition update |

**Next.js**: wrap server functions with `unstable_cache(fn, [key], { revalidate, tags })`. On import/profile update, call `revalidateTag('recommendations:<user>:*')`.


---

## 9) Ingestion & Identity Resolution

- **Open Library → Postgres**: stream JSONL (works, editions, authors, subjects, ratings), upsert; compute `page_count_median`.  
- **Google Books**: fetch `averageRating`, `ratingsCount`, categories; disk cache by ISBN13.  
- **Goodreads CSV**: parse core fields, map to Work via resolver, insert `UserEvent`.  
- **Kindle export**: parse archive; optional `My Clippings.txt`; resolve & insert `UserEvent` (shelf=`read` when confident).  
- **Resolver**: `resolveByIsbn` (edition→work), `resolveByTitleAuthor` (OL search + fuzzy). Caches (`resolver_cache` table + LRU).


---

## 10) Features

### 10.1 Embeddings (OpenAI)
- Build work text: `title + subtitle + description + authors + subjects` (truncate ~4k chars).  
- Model: `OPENAI_EMBED_MODEL` (default: `text-embedding-3-large`).  
- Normalize vectors client‑side to unit length; store in `Work.embedding`.  
- **Vector index**: HNSW with cosine ops:  
  ```sql
  CREATE INDEX IF NOT EXISTS work_embedding_hnsw
  ON "Work" USING hnsw (embedding vector_cosine_ops);
  ```

### 10.2 Ratings blend
- Sources: Open Library + Google Books.  
- Compute **Bayesian average** (source priors) + **Wilson lower bound**; store in `work_quality(work_id, blended_avg, blended_wilson, total_ratings)`.  
- Materialize & refresh on schedule.

### 10.3 User profile vector
- Positive core: high ratings & recent `UserEvent`; negatives from `dnf`/low ratings.  
- `u = normalize(Σ w_i * v_i)`; store in `user_profile`.  
- Anchors (top contributors) saved for explanations.

### 10.4 Graph features (Apache AGE)
- Load nodes/edges from relational tables into AGE graph `books`.  
- Compute features: author affinity, subject overlap, series continuation, **2‑hop proximity**, **community_id** (label propagation).  
- Persist to `work_graph_features` for joins in ranking.


---

## 11) Candidate Generation & Re‑ranking

### 11.1 Candidates (`lib/recs/candidates.ts`)
1) **Subject filter** (category → OL subjects; year/language bounds).
2) **Vector ANN**: KNN from **user_profile**; seed with KNN of top 5 favorites in category.
3) **Graph expansion**: 1–2 hops via AGE (`cypher`) to pull close, not‑yet‑read works.
4) **Collaborative filtering** (from Open Library reading logs & lists):
   - **"Also read"**: Query `OLReadingLog` for users who read book X also read Y
   - **"List mates"**: Query `OLListSeed` for books appearing in same curated lists
   - Score boosting: books found by multiple methods get score bonuses
5) **Filters (critical)**:
   - **Exclude already read** with `NOT EXISTS` on `UserEvent`.
   - Apply blocks; language & year constraints.
6) Cache candidate IDs in `candidate_cache` keyed by (user, mode, key).

**Collaborative filtering queries:**
```sql
-- Users who read X also read (from OLReadingLog)
WITH readers AS (
  SELECT DISTINCT ol_user_key FROM "OLReadingLog"
  WHERE work_key = $1 AND status = 'already-read'
)
SELECT r2.work_key, COUNT(DISTINCT r2.ol_user_key) as overlap
FROM readers JOIN "OLReadingLog" r2 ON r2.ol_user_key = readers.ol_user_key
WHERE r2.work_key != $1 AND r2.status = 'already-read'
GROUP BY r2.work_key HAVING COUNT(*) >= 2
ORDER BY overlap DESC LIMIT 50;

-- Books in same lists (from OLListSeed)
WITH containing_lists AS (
  SELECT list_id FROM "OLListSeed" WHERE seed_key LIKE '%' || $1
)
SELECT s2.seed_key, COUNT(DISTINCT s2.list_id) as shared_lists
FROM containing_lists JOIN "OLListSeed" s2 ON s2.list_id = containing_lists.list_id
WHERE s2.seed_type = 'work' AND s2.seed_key NOT LIKE '%' || $1
GROUP BY s2.seed_key ORDER BY shared_lists DESC LIMIT 30;
```

### 11.2 Re‑rank (`lib/recs/rerank.ts`)
- **Relevance** = w₁·cos(u, v_work) + w₂·graphProx + w₃·authorAffinity + w₄·subjectOverlap.  
- **Quality prior** = f(blended_avg, blended_wilson, total_ratings).  
- **Novelty** = sigmoid(recentness vs history) + mild penalty for over‑similarity.  
- **Diversity** = greedy **MMR** across authors & sub‑subjects (target ILD@100 ≥ 0.6).  
- **Suggestion quality** = letter grade + confidence from final score.  
- Return **exactly 100** (or paginated view). Cache results.


---

## 12) Next.js API (App Router)

All endpoints **exclude books already read**.

- `GET /api/recommendations/general?user_id=me&page=1&page_size=24`  
  Paginated general picks (diversified).

- `GET /api/recommendations/by-book?user_id=me&work_id=12345&k=100`  
  Seeded by a specific book; hybrid ANN + graph + MMR.

- `GET /api/recommendations/by-category?user_id=me&slug=hard-sci-fi&page=1&page_size=24`
  Candidates constrained to category; hybrid ranking.

**Note:** Reading history imports (Goodreads, Kindle) are CLI-only via `pnpm import:goodreads` and `pnpm import:kindle`. These files are typically too large for browser uploads.

**Pagination:** cursor (score, work_id) preferred; fallback to page/page_size.


---

## 13) Next.js UI (beautiful cards)

**`lib/ui/RecommendationCard.tsx`**
```ts
type Rec = {
  workId: number
  coverUrl?: string
  title: string
  authors: string[]
  year?: number
  avgRating?: number
  ratingCount?: number
  suggestionQuality: "A+"|"A"|"A-"|"B+"|"B"|"B-"
  reasons: string[]
  description?: string
}

export function RecommendationCard(props: Rec) {
  // Next/Image cover, title, authors, year
  // Rating (avg + count)
  // Badge for suggestionQuality + tooltip with numeric confidence
  // Reasons as bullet list
  // Collapsible description
}
```

**Pages**
- `/recommendations` → general grid (paginated).  
- `/book/[workId]` → “Because you liked *X*” grid.  
- `/category/[slug]` → category grid (paginated).

**Covers & description**
- Open Library covers by ISBN13 or OLID; fallback to Google Books thumbnails.  
- Description: OL Work.description else Google Books `volumeInfo.description`.


---

## 14) Direct Postgres: pool & vector queries

**`lib/db/pool.ts`**
```ts
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min: Number(process.env.PGPOOL_MIN ?? 2),
  max: Number(process.env.PGPOOL_MAX ?? 20)
});
```

**`lib/db/vector.ts`**
```ts
export const toVectorLiteral = (v: number[]) => `[${v.map(x => Number(x).toFixed(6)).join(",")}]`;
```

**KNN from a vector (cosine)**
```ts
import { pool } from "./pool";
import { toVectorLiteral } from "./vector";

export async function knnFromVector(vec: number[], limit=2000) {
  const client = await pool.connect();
  try {
    const v = toVectorLiteral(vec);
    const { rows } = await client.query(`
      SELECT id, 1 - (embedding <=> $1::vector) AS sim
      FROM "Work"
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `, [v, limit]);
    return rows as { id: number; sim: number }[];
  } finally {
    client.release();
  }
}
```

**Exclude already read (SQL fragment)**
```sql
AND NOT EXISTS (
  SELECT 1 FROM "UserEvent" ue
  WHERE ue.user_id = $user AND ue.work_id = w.id
);
```

**AGE 2‑hop neighbors for a seed book**
```sql
SELECT * FROM cypher('books', $$
  MATCH (w:Work {id: $workId})-[:HAS_SUBJECT|:IN_SERIES|:WROTE*1..2]-(n:Work)
  RETURN DISTINCT n.id AS id
$$) AS (id bigint);
```


---

## 15) OpenAI model choices (practical guidance)

- **Embeddings**: use `text-embedding-3-large` (strong general performance).  
- **Explanations (“because you liked…” lines)**:
  - Default to **`gpt-5-mini`** (fast & cost‑efficient, good for short copy at scale).  
  - Escalate to **`gpt-5`** when you want the best nuance, tone control, or long, editorial‑quality blurbs.  
  - **Why not `o4-mini`?** `o4-mini` is a small, fast reasoning model; however the GPT‑5 mini line supersedes it for many API tasks. Use `o4-mini` only if it benchmarks better for your exact prompt.

Switch per request based on list size and latency budget:
```ts
const model = listSize > 30 ? "gpt-5-mini" : "gpt-5";
```

> Tip: Batch explanation generation and **cache** them by `(userId, workId, anchorsHash)`; regenerate only when anchors change.


---

## 16) End‑to‑End Runbook

```bash
# Infra
docker compose -f docker/docker-compose.yml up -d

# Migrations (raw SQL)
pnpm migrate

# Ingest + Enrich
pnpm ingest:ol -- --dir "$OPENLIBRARY_DUMPS_DIR" --tables works,editions,authors,subjects,ratings
pnpm enrich:gb -- --max 20000

# Import history
pnpm import:goodreads -- --user me --csv "$GOODREADS_EXPORT_CSV"
pnpm import:kindle   -- --user me --dir "$KINDLE_EXPORT_DIR"

# Build features
pnpm features:embed
pnpm profile:build -- --user me
pnpm graph:build

# Start Next.js UI/API
pnpm dev
# Visit /recommendations, /book/<workId>, /category/<slug>
```


---

## 17) Quality Gates & Metrics

- **ILD@100 ≥ 0.60**, repeated authors ≤ 3 unless continuation desired.  
- **Novelty:** ≥ 80% items not in history.  
- **Quality floor:** ≥ 70% items with `ratingCount ≥ 100` (tunable).  
- Track acceptance/finish rates; micro‑survey for “satisfying?”


---

## 18) Compliance

- Use **Open Library** dumps/APIs and **Google Books** API only; no scraping of restricted sources.  
- Goodreads via **user CSV export**; Amazon via **Request Your Data**.  
- Personal data remains local; encrypt at rest if deploying remotely.
