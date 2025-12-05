# CLAUDE.md - Agent Guide for Book Recommender

This document provides comprehensive guidance for AI agents working on this codebase.

## Project Overview

A personal book recommendation system that combines:
- **Vector embeddings** (OpenAI) for semantic similarity
- **Graph features** (Apache AGE) for relationship-based recommendations
- **Collaborative filtering** from Open Library community data
- **Quality scoring** from multiple rating sources
- **Kindle intensity signals** (ownership, sessions, streaks) and targeted Google Books enrichment for missing metadata

## Recent operator notes
- New helper scripts: `pnpm embed:user-events` (embed all user-event works), `pnpm fetch:ol-isbns` (pull ISBNs for unknown OL works), `pnpm enrich:unknown-gb` (small, time-bounded Google Books enrichment for unknown-title works with ISBNs).
- Update pipeline (`scripts/update.ts`) includes Kindle aggregate/re-enrich/dedupe/fix-unknowns and user-event embeddings before profile build.
- Google Books enrichment: prefer repeated small runs of `enrich:unknown-gb` to avoid long stalls and 429/503s.

The system ingests book catalogs, imports user reading history, builds feature representations, and serves personalized recommendations through a Next.js UI.

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Next.js 16 (App Router) + React 19 |
| Language | TypeScript (strict) |
| Database | PostgreSQL 16 + pgvector (AGE planned for future) |
| Embeddings | OpenAI text-embedding-3-large (1536 dimensions via dimension reduction) |
| Explanations | OpenAI gpt-5-mini |
| Styling | Tailwind CSS |
| Linting | ESLint 9 (flat config) |
| Package Manager | pnpm |
| Runtime | Node.js 20+ |

---

## Directory Structure

```
book-recommender/
├── app/                          # Next.js App Router
│   ├── api/recommendations/      # API routes
│   │   ├── general/route.ts      # GET personalized recommendations
│   │   ├── by-book/route.ts      # GET "more like this"
│   │   └── by-category/route.ts  # GET category-filtered recs
│   ├── (routes)/                 # Pages
│   │   ├── recommendations/      # Main recommendations grid
│   │   ├── book/[workId]/        # Single book "because you liked X"
│   │   └── category/[slug]/      # Category browsing
│   ├── layout.tsx
│   └── page.tsx                  # Home page
│
├── lib/                          # Core library code
│   ├── config/
│   │   ├── env.ts                # Environment validation (Zod)
│   │   └── categories.ts         # Category definitions
│   ├── db/
│   │   ├── pool.ts               # PostgreSQL connection pool
│   │   ├── vector.ts             # Vector utilities (toVectorLiteral, normalize)
│   │   └── sql.ts                # SQL query helpers
│   ├── ingest/
│   │   ├── openlibrary.ts        # Open Library dump ingestion
│   │   ├── googlebooks.ts        # Google Books API enrichment
│   │   ├── goodreads.ts          # Goodreads CSV import
│   │   ├── kindle.ts             # Kindle data import
│   │   ├── resolve.ts            # Legacy ISBN/title resolution
│   │   ├── resolverV2.ts         # Multi-source book resolution
│   │   ├── resolverV2/           # Resolution subsystem
│   │   │   ├── types.ts          # TypeScript interfaces
│   │   │   ├── paths.ts          # Resolution path implementations
│   │   │   ├── upsert.ts         # Work+Edition atomic upsert
│   │   │   └── merge.ts          # Dedupe and merge logic
│   │   └── enrichWork.ts         # Stub enrichment pipeline
│   ├── features/
│   │   ├── embeddings.ts         # OpenAI embedding generation
│   │   ├── ratings.ts            # Quality score computation
│   │   ├── userProfile.ts        # User taste profile building
│   │   ├── graph.ts              # Apache AGE graph features
│   │   └── cache.ts              # Cache management
│   ├── recs/
│   │   ├── candidates.ts         # Candidate generation (vector + graph + CF)
│   │   ├── rerank.ts             # Re-ranking with MMR diversity
│   │   └── explain.ts            # "Because you liked..." generation
│   ├── ui/
│   │   └── RecommendationCard.tsx
│   └── util/
│       ├── logger.ts             # Structured logging
│       ├── text.ts               # Text processing
│       ├── covers.ts             # Cover image URLs
│       └── urlParser.ts          # Extract IDs from book URLs
│
├── scripts/                      # CLI tools (run with tsx)
│   ├── download-openlibrary.ts   # Download OL dumps
│   ├── ingest-openlibrary.ts     # Ingest OL data
│   ├── enrich-googlebooks.ts     # Google Books enrichment
│   ├── import-goodreads.ts       # Import Goodreads CSV
│   ├── import-kindle.ts          # Import Kindle data
│   ├── build-embeddings.ts       # Generate work embeddings
│   ├── build-user-profile.ts     # Build user taste profile
│   ├── build-graph.ts            # Compute graph features
│   ├── refresh-all.ts            # Refresh all features
│   └── update.ts                 # Full pipeline orchestrator
│
├── db/migrations/                # SQL migrations (ordered 000_*.sql)
├── docker/
│   ├── docker-compose.yml        # PostgreSQL + Redis
│   └── init/                     # DB initialization scripts
├── data/                         # Data directory (gitignored)
│   ├── openlibrary/              # Downloaded OL dumps
│   ├── goodreads/export.csv      # User's Goodreads export
│   └── kindle/                   # User's Kindle export
└── package.json
```

---

## Database Schema

### Core Tables

```sql
-- Books as abstract entities (not physical editions)
"Work" (
  id BIGSERIAL PRIMARY KEY,
  ol_work_key TEXT UNIQUE,        -- e.g., "OL123W"
  title TEXT NOT NULL,
  subtitle TEXT,
  description TEXT,
  first_publish_year INT,
  page_count_median INT,
  embedding VECTOR(1536),         -- OpenAI embedding (dimension-reduced for indexing)
  ol_data JSONB,                  -- Raw Open Library JSON
  ol_revision INT,
  ol_last_modified DATE,
  source TEXT,                    -- 'openlibrary' | 'googlebooks' | 'amazon' | 'royalroad' | 'manual'
  is_stub BOOLEAN,                -- True if low-confidence resolution
  stub_reason TEXT                -- Why resolution was incomplete
)

-- Physical/digital book editions
"Edition" (
  id BIGSERIAL PRIMARY KEY,
  work_id BIGINT REFERENCES "Work"(id),
  ol_edition_key TEXT UNIQUE,
  isbn10 TEXT,
  isbn13 TEXT UNIQUE,
  publisher TEXT,
  cover_id TEXT,
  ol_data JSONB,
  -- External identifiers for non-OL books
  asin TEXT UNIQUE,               -- Amazon Kindle
  google_volume_id TEXT UNIQUE,   -- Google Books
  audible_asin TEXT UNIQUE,       -- Audible audiobook
  royalroad_fiction_id BIGINT,    -- Royal Road web serial
  goodreads_book_id BIGINT,       -- Goodreads
  cover_url TEXT                  -- External cover URL
)

-- Multi-ISBN lookup (editions can have multiple ISBNs)
"EditionISBN" (
  edition_id BIGINT,
  isbn TEXT,
  isbn_type TEXT,  -- 'isbn10' | 'isbn13'
  PRIMARY KEY (edition_id, isbn)
)

-- Author information
"Author" (
  id BIGSERIAL PRIMARY KEY,
  ol_author_key TEXT UNIQUE,
  name TEXT NOT NULL,
  bio TEXT,
  ol_data JSONB
)

-- Work-Author relationship
"WorkAuthor" (work_id, author_id, role)

-- Subject/genre tags
"Subject" (subject TEXT PRIMARY KEY, typ TEXT)
"WorkSubject" (work_id, subject)

-- Aggregated ratings from multiple sources
"Rating" (
  work_id BIGINT,
  source TEXT,  -- 'openlibrary' | 'googlebooks'
  avg NUMERIC(3,2),
  count INT,
  PRIMARY KEY (work_id, source)
)

-- User reading history (from imports)
"UserEvent" (
  user_id TEXT,
  work_id BIGINT,
  shelf TEXT,     -- 'read' | 'to-read' | 'currently-reading' | 'dnf'
  rating NUMERIC(2,1),
  finished_at DATE,
  source TEXT,    -- 'goodreads' | 'kindle'
  PRIMARY KEY (user_id, work_id, source)
)

-- Kindle ownership + reading intensity
"KindleOwnership" (
  user_id TEXT,
  asin TEXT,
  product_name TEXT,
  origin_type TEXT,      -- Purchase | KindleUnlimited | Sample | PDocs | etc.
  right_type TEXT,       -- Download | Lending
  right_status TEXT,     -- Active | Revoked
  resource_type TEXT,    -- KindleEBook | KindleEBookSample | KindlePDoc
  acquired_at TIMESTAMP,
  last_updated_at TIMESTAMP,
  order_id TEXT,
  transaction_id TEXT,
  raw JSONB,
  PRIMARY KEY (user_id, asin, right_type)
)

"UserCompletionEvent" (
  user_id TEXT,
  asin TEXT,
  completed_at TIMESTAMP,
  method TEXT, -- auto_mark | insights_auto | insights_manual | whispersync_last_read
  PRIMARY KEY (user_id, asin, method, completed_at)
)

"UserReadingSession" (
  user_id TEXT,
  asin TEXT,
  start_at TIMESTAMP,
  end_at TIMESTAMP,
  duration_ms BIGINT,
  source TEXT, -- ri_adjusted | ereader_active | legacy_session
  device_family TEXT,
  PRIMARY KEY (user_id, asin, start_at, source)
)

"UserReadingDay" (
  user_id TEXT,
  day DATE,
  source TEXT, -- ri_day_units
  PRIMARY KEY (user_id, day, source)
)

"UserReadingAggregate" (
  user_id TEXT,
  asin TEXT,
  total_ms BIGINT,
  sessions INT,
  last_read_at TIMESTAMP,
  avg_session_ms NUMERIC(12,2),
  max_session_ms BIGINT,
  streak_days INT,
  last_30d_ms BIGINT,
  updated_at TIMESTAMP,
  PRIMARY KEY (user_id, asin)
)

-- User taste profile (computed)
"UserProfile" (
  user_id TEXT PRIMARY KEY,
  profile_vec VECTOR(1536),       -- Dimension-reduced to match Work.embedding
  anchors JSONB,  -- Top contributing books
  updated_at TIMESTAMP
)

-- Blocked works/authors
"Block" (user_id, work_id, author_id)

-- Resolution audit log
"ResolverLog" (
  id BIGSERIAL PRIMARY KEY,
  input_key TEXT NOT NULL,        -- Normalized lookup key
  input_data JSONB,               -- What we received
  path_taken TEXT,                -- 'isbn_ol' | 'isbn_gb' | 'title_gb' | 'asin' | etc.
  work_id BIGINT REFERENCES "Work"(id),
  confidence NUMERIC(3,2),
  created BOOLEAN,                -- Whether a new Work was created
  created_at TIMESTAMP
)

-- Work merge audit log
"WorkMergeLog" (
  id BIGSERIAL PRIMARY KEY,
  work_id_from BIGINT NOT NULL,
  work_id_to BIGINT NOT NULL,
  reason TEXT,
  merged_at TIMESTAMP
)
```

### Open Library Extended Tables

```sql
-- Community reading activity
"OLReadingLog" (work_key, ol_user_key, status, logged_date)
-- status: 'want-to-read' | 'currently-reading' | 'already-read'

-- Individual user ratings
"OLRating" (work_key, ol_user_key, rating 1-5)

-- User-created book lists
"OLList" (list_key, ol_user_key, name, seed_count, data JSONB)
"OLListSeed" (list_id, seed_key, seed_type, position)

-- Entity redirects (for merged/moved works)
"OLRedirect" (old_key, new_key, entity_type)

-- Cover image metadata
"OLCover" (cover_id, width, height, edition_key, author_key)

-- Wikidata links
"OLWikidata" (ol_key, entity_type, wikidata_id)
```

### Materialized Views

```sql
-- Aggregated popularity from reading logs
"WorkPopularity" (work_key, read_count, reading_count, want_count, unique_users)

-- Aggregated OL ratings
"WorkOLRating" (work_key, avg_rating, rating_count, five_star, ...)

-- Pre-aggregated author names (speeds up reranking)
work_authors_agg (work_id, author_ids, author_names, author_count)

-- Pre-aggregated subjects (speeds up candidate generation)
work_subjects_agg (work_id, subjects, subject_count)
```

### Key Indexes

```sql
-- Vector similarity search (IVFFlat for fast ANN)
-- Note: pgvector limits HNSW/IVFFlat to 2000 dimensions, hence dimension reduction
CREATE INDEX work_embedding_ivfflat ON "Work"
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 500);

-- ISBN lookups
CREATE INDEX edition_isbn_lookup_idx ON "EditionISBN"(isbn);

-- Junction table indexes for JOIN performance
CREATE INDEX work_author_work_id_idx ON "WorkAuthor"(work_id);
CREATE INDEX work_subject_work_id_idx ON "WorkSubject"(work_id);

-- Composite index for reading log queries
CREATE INDEX ol_reading_log_work_status_date_idx
  ON "OLReadingLog"(work_key, status, logged_date DESC);

-- List seed work key extraction for efficient lookups
CREATE INDEX ol_list_seed_work_key_idx ON "OLListSeed"(seed_work_key);
```

---

## Docker Setup

Docker containers are automatically started by most pnpm scripts. Manual control:

```bash
pnpm docker:up          # Start PostgreSQL (pgvector + AGE)
pnpm docker:up:cache    # Start PostgreSQL + Redis
pnpm docker:down        # Stop all containers
pnpm docker:logs        # View container logs
```

Or using docker compose directly:
```bash
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml --profile cache up -d
```

The PostgreSQL image is `apache/age:PG16_latest` which includes:
- PostgreSQL 16
- pgvector extension (vector similarity)
- Apache AGE extension (graph queries via Cypher)

Database credentials: `books:books@localhost:5432/books`

---

## Environment Variables

Required in `.env`:

```bash
# Database
DATABASE_URL="postgresql://books:books@localhost:5432/books?sslmode=disable"
PGPOOL_MIN=2
PGPOOL_MAX=20

# OpenAI (required for embeddings and explanations)
OPENAI_API_KEY="sk-..."
OPENAI_EMBED_MODEL="text-embedding-3-large"    # Supports 256-3072 dimensions
OPENAI_EMBED_DIMENSIONS=1536                   # Reduced from 3072 for vector indexing (max 2000)
OPENAI_REASONING_MODEL="gpt-5-mini"            # For explanations

# Google Books (optional, for rating enrichment)
GOOGLE_BOOKS_API_KEY="..."

# Redis (optional, for response caching)
REDIS_URL="redis://localhost:6379"

# Data paths
OPENLIBRARY_DUMPS_DIR="./data/openlibrary"
GOODREADS_EXPORT_CSV="./data/goodreads/export.csv"
KINDLE_EXPORT_DIR="./data/kindle"
```

Configuration is validated with Zod in `lib/config/env.ts`.

---

## CLI Scripts

**Note**: Most scripts automatically start Docker containers if not running.

### Full Pipeline

```bash
pnpm update                      # Run entire pipeline (starts Docker)
pnpm update -- --quick           # Skip download/ingest, refresh features only
pnpm update -- --skip-download   # Use existing downloaded files
pnpm update -- --user jane       # Different user ID
```

### Individual Scripts

```bash
pnpm download:ol                 # Download Open Library dumps (~16GB)
pnpm download:ol -- --preset minimal  # Just works + authors (~4GB)
pnpm download:ol -- --files works,ratings

pnpm ingest:ol                   # Ingest OL data into database
pnpm enrich:gb                   # Enrich with Google Books ratings

pnpm import:goodreads            # Import Goodreads CSV
pnpm import:kindle               # Import Kindle data

pnpm features:embed              # Generate OpenAI embeddings
pnpm profile:build -- --user me  # Build user taste profile
pnpm graph:build -- --user me    # Compute graph features

pnpm refresh:all -- --user me    # Refresh all computed features
```

---

## Data Pipeline

### 1. Open Library Data

**Download**: Open Library provides monthly dumps at `openlibrary.org/data/`:

| File | Contents |
|------|----------|
| `works` | Books as abstract entities |
| `editions` | Physical editions with ISBNs |
| `authors` | Author information |
| `ratings` | User ratings (1-5) |
| `reading-log` | Reading status (want/reading/read) |
| `lists` | User-created book lists |
| `redirects` | Merged entity mappings |

**Format**: Tab-separated with 5 columns:
```
type    key    revision    last_modified    json_data
```

**Fallback**: The "latest" dump may be incomplete. Script automatically falls back to known complete dump (2025-11-06) on 404.

### 2. User History Import

**Goodreads**: CSV export with columns:
- Book Id, Title, Author, ISBN, ISBN13
- My Rating, Average Rating
- Shelves (read, to-read, currently-reading)
- Date Read

**Kindle**: Amazon data export containing purchase history and reading activity.

### 3. Feature Building

**Embeddings**:
- Combines: title + subtitle + description + authors + subjects
- Model: text-embedding-3-large with dimension reduction (1536 dimensions)
- OpenAI's `dimensions` parameter reduces from 3072 to 1536 at generation time
- This enables IVFFlat vector indexing (pgvector max 2000 dims for indexed queries)
- Stored in `Work.embedding` as VECTOR(1536) type
- Rate limited via Bottleneck (10 req/sec)

**User Profile**:
- Weighted average of read book embeddings
- Higher weights for: recent reads, high ratings, finished
- Negative weights for: DNF, low ratings
- Anchors: top contributing books for explanations

**Graph Features** (Apache AGE):
- Author affinity scores
- Subject overlap
- 2-hop proximity via Cypher queries
- Community detection

---

## Book Resolution System (resolverV2)

The resolver handles book identification for titles that may not exist in Open Library, including Kindle-only, self-published, and web serial titles.

### Data Source Policy

**Allowed sources** (no scraping):
- Open Library API and data dumps
- Google Books API (`intitle:` + `inauthor:` queries)
- User exports: Goodreads CSV, Amazon "Request Your Data", Kindle clippings
- Manual input via admin/import flows

**Not allowed**: Scraping Amazon, Goodreads, or Royal Road pages.

### Resolution Paths & Confidence

| Priority | Path | Confidence | Description |
|----------|------|------------|-------------|
| 1 | ISBN → Open Library | 0.98 | Canonical OL work found |
| 2 | ISBN → Google Books | 0.85 | OL miss, GB enriched |
| 3 | ISBN → local only | 0.75 | ISBN-only, no enrichment |
| 4 | Google Volume ID | 0.82 | Direct GB lookup |
| 5 | Title+Author → GB | 0.80 | GB search match |
| 6 | ASIN only | 0.65 | Kindle-only title |
| 7 | Royal Road ID | 0.60 | Web serial |
| 8 | Goodreads ID | 0.55 | ID only, can't fetch data |
| 9 | Manual fallback | 0.40 | Title+author only |

### Identifier Priority (Deduplication)

When merging Works, higher-priority identifiers take precedence:
```
ISBN13 > ISBN10 > google_volume_id > ASIN > royalroad_fiction_id > goodreads_book_id
```

### Stub Works

Works with confidence < 0.70 are marked as **stubs** (`is_stub = true`) and queued for enrichment. The `stub_reason` field documents why resolution was incomplete.

### Enrichment Priority

| Data | Priority 1 | Priority 2 | Priority 3 |
|------|-----------|-----------|-----------|
| Cover | Open Library | Google Books `imageLinks` | User-supplied `cover_url` |
| Description | Open Library | Google Books `description` | User-supplied |
| Ratings | Open Library | Google Books `averageRating` | N/A |

### Merge Strategy

When a higher-priority key appears for an existing Work (e.g., ISBN found for ASIN-only Work):

1. Identify canonical Work (lowest `work_id`)
2. Move all Editions, WorkAuthor, WorkSubject edges
3. Update UserEvent and Rating references
4. Log merge to `WorkMergeLog`
5. Delete duplicate Work

### Key Files

| File | Purpose |
|------|---------|
| `lib/ingest/resolverV2.ts` | Main resolver orchestrator |
| `lib/ingest/resolverV2/paths.ts` | Individual resolution path implementations |
| `lib/ingest/resolverV2/upsert.ts` | Work+Edition+Author atomic upsert |
| `lib/ingest/resolverV2/merge.ts` | Dedupe and merge logic |
| `lib/ingest/resolverV2/types.ts` | TypeScript interfaces |
| `lib/ingest/enrichWork.ts` | Stub enrichment pipeline |
| `lib/util/urlParser.ts` | Extract IDs from Amazon/Goodreads/RR URLs |

### Usage

```typescript
import { resolveWork, resolveFromUrl } from "@/lib/ingest/resolverV2";

// Resolve by identifiers
const result = await resolveWork({
  title: "Some Book",
  author: "Author Name",
  isbn13: "9781234567890", // optional
  asin: "B0EXAMPLE", // optional
});

// Resolve from URL (Amazon, Goodreads, Royal Road, Google Books)
const result = await resolveFromUrl("https://amazon.com/dp/B0EXAMPLE", {
  title: "Some Book",
  author: "Author Name",
});

// Result contains: workId, editionId, confidence, created, path, source
```

---

## Recommendation Engine

### Candidate Generation (`lib/recs/candidates.ts`)

1. **Vector KNN**: Find similar works using pgvector
   ```sql
   SELECT id, 1 - (embedding <=> $user_vec) AS sim
   FROM "Work" WHERE embedding IS NOT NULL
   ORDER BY embedding <=> $user_vec LIMIT 2000
   ```

2. **Graph Expansion**: 1-2 hop traversal via AGE
   ```sql
   SELECT * FROM cypher('books', $$
     MATCH (w:Work {id: $id})-[:HAS_SUBJECT|:WROTE*1..2]-(n:Work)
     RETURN DISTINCT n.id
   $$) AS (id bigint)
   ```

3. **Collaborative Filtering**:
   - "Users who read X also read Y" from OLReadingLog
   - "Books in same lists" from OLListSeed

4. **Exclusion**: Always exclude books already in UserEvent

### Re-ranking (`lib/recs/rerank.ts`)

Scores combine:
- **Relevance**: cosine(user_profile, work_embedding)
- **Quality**: Bayesian-averaged rating + Wilson lower bound
- **Novelty**: Penalty for over-similarity to recent reads
- **Diversity**: MMR (Maximal Marginal Relevance) across authors/subjects

Target: ILD@100 >= 0.6 (intra-list diversity)

### Explanations (`lib/recs/explain.ts`)

Uses gpt-5-mini to generate "Because you liked..." reasons based on:
- User's anchor books
- Shared authors/subjects
- Similar themes detected

---

## API Routes

```
GET /api/recommendations/general?user_id=me&page=1&page_size=24
GET /api/recommendations/by-book?user_id=me&work_id=123&k=100
GET /api/recommendations/by-category?user_id=me&slug=science-fiction&page=1
```

All routes:
- Exclude already-read books
- Support pagination (cursor or page-based)
- Cache results with revalidation tags

---

## Frontend

### Pages

- `/` - Home with feature overview
- `/recommendations` - Personalized grid
- `/book/[workId]` - "More like this" from specific book
- `/category/[slug]` - Category-filtered recommendations

### Components

- `RecommendationCard` - Book card with cover, title, author, rating, quality badge, reasons
- Cover images from Open Library or Google Books API
- Tailwind CSS styling

---

## Key Patterns

### Next.js 16 Page Props

In Next.js 16, `params` and `searchParams` are Promises and must be awaited:

```typescript
// Dynamic route page (e.g., app/(routes)/book/[workId]/page.tsx)
export default async function BookPage(props: {
  params: Promise<{ workId: string }>;
}) {
  const { workId } = await props.params;
  // ...
}

// Page with search params
export default async function RecommendationsPage(props: {
  searchParams: Promise<{ page?: string }>;
}) {
  const searchParams = await props.searchParams;
  const page = parseInt(searchParams.page ?? "1", 10);
  // ...
}

// Page with both
export default async function CategoryPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await props.params;
  const searchParams = await props.searchParams;
  // ...
}
```

### TypeScript Config

Next.js 16 supports TypeScript configuration files (`next.config.ts`):

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [/* ... */],
  },
  serverExternalPackages: ["pg"],
};

export default nextConfig;
```

### Database Access

Always use the pool helpers from `lib/db/pool.ts`:

```typescript
import { query, transaction, withClient } from "@/lib/db/pool";

// Simple query
const { rows } = await query<Work>('SELECT * FROM "Work" WHERE id = $1', [id]);

// Transaction
await transaction(async (client) => {
  await client.query('INSERT INTO ...');
  await client.query('UPDATE ...');
});
```

### Vector Operations

```typescript
import { toVectorLiteral, normalizeVector } from "@/lib/db/vector";

// Convert array to pgvector literal
const vecStr = toVectorLiteral([0.1, 0.2, 0.3]); // "[0.100000,0.200000,0.300000]"

// Normalize to unit length
const normalized = normalizeVector(embedding);
```

### Environment Access

```typescript
import { getEnv, hasGoogleBooks } from "@/lib/config/env";

const env = getEnv(); // Validated, throws if invalid
if (hasGoogleBooks()) {
  // Google Books API is configured
}
```

### Logging

```typescript
import { logger, createTimer } from "@/lib/util/logger";

logger.info("Processing works", { count: 100 });
logger.error("Failed to fetch", { error: String(err) });

const timer = createTimer("Embedding generation");
// ... work ...
timer.end({ processed: 500 });
```

---

## Common Tasks

### Add a new data source

1. Create ingestion function in `lib/ingest/`
2. Add TypeScript interface for the data structure
3. Create or update database migration in `db/migrations/`
4. Add CLI script in `scripts/`
5. Register in `package.json` scripts
6. Update `scripts/update.ts` pipeline

### Add a new recommendation signal

1. Add candidate generation in `lib/recs/candidates.ts`
2. Add scoring weight in `lib/recs/rerank.ts`
3. Update user profile if needed in `lib/features/userProfile.ts`
4. Consider caching in `lib/features/cache.ts`

### Modify the schema

1. Create new migration file: `db/migrations/XXX_description.sql`
2. Update TypeScript types in `lib/db/pool.ts`
3. Update relevant ingest functions
4. Run `pnpm migrate`
5. **Update documentation:**
   - Update `CLAUDE.md` Database Schema section
   - Update `db/migrations/000_init.sql` ON CONFLICT reference comment
   - Update `README.md` if user-facing behavior changes

---

## PostgreSQL Patterns

### ON CONFLICT (Upsert) Usage

**Always specify explicit constraint columns** in ON CONFLICT clauses. PostgreSQL may fail to infer the correct constraint when using bare `ON CONFLICT DO NOTHING`.

```sql
-- Good: Explicit constraint columns
INSERT INTO "WorkAuthor" (work_id, author_id, role)
VALUES ($1, $2, 'author')
ON CONFLICT (work_id, author_id, role) DO NOTHING;

-- Bad: May cause "no unique or exclusion constraint" error
INSERT INTO "WorkAuthor" (work_id, author_id, role)
VALUES ($1, $2, 'author')
ON CONFLICT DO NOTHING;
```

**Primary key reference for ON CONFLICT:**

| Table | Primary Key Columns |
|-------|---------------------|
| WorkAuthor | (work_id, author_id, role) |
| WorkSubject | (work_id, subject) |
| Subject | (subject) |
| Rating | (work_id, source) |
| UserEvent | (user_id, work_id, source) |

### Author Lookup Pattern

The `Author` table has no unique constraint on `name` (duplicate names are valid - "John Smith" appears many times). Use find-then-insert pattern:

```typescript
// First try to find existing
const { rows } = await client.query(
  `SELECT id FROM "Author" WHERE name = $1 LIMIT 1`,
  [name]
);

if (rows[0]?.id) {
  authorId = rows[0].id;
} else {
  // Create new author
  const { rows: newRows } = await client.query(
    `INSERT INTO "Author" (name, created_at) VALUES ($1, NOW()) RETURNING id`,
    [name]
  );
  authorId = newRows[0]?.id;
}
```

---

## Performance Considerations

- **Vector search**: IVFFlat index for sub-linear ANN queries (lists=500 for ~1M rows)
- **Dimension reduction**: Embeddings reduced to 1536 dims to enable vector indexing (pgvector max 2000)
- **Batch processing**: Use transactions and multi-row inserts (1000-2000 rows per INSERT)
  - Ratings/reading log ingestion uses 2000-row batches
  - Kindle import uses 500-row batches with parallel resolution
- **N+1 query prevention**:
  - Use batch fetching (e.g., `getWorkDetailsBatch()`, `getCoversBatch()`)
  - Pre-aggregated materialized views (`work_authors_agg`, `work_subjects_agg`)
- **Rate limiting**: Bottleneck for OpenAI API (10 req/sec default)
- **Caching layers**:
  - Redis for API responses
  - Materialized views for aggregations (refresh with `refresh_performance_views()`)
  - `candidate_cache` table for precomputed candidates
  - Next.js `unstable_cache` with revalidation tags

---

## Testing & Linting

```bash
pnpm test           # Run Vitest tests
pnpm lint           # ESLint 9 (flat config)
pnpm lint:fix       # Auto-fix ESLint issues
pnpm build          # Type check + build
```

ESLint uses flat config format (`eslint.config.mjs`) with:
- `@next/eslint-plugin-next` for Next.js rules
- `typescript-eslint` for TypeScript rules
- `eslint-plugin-react-hooks` for React hooks rules

---

## Troubleshooting

### Database connection issues
- Check Docker is running: `docker compose ps`
- Verify DATABASE_URL in .env
- Check pool settings (PGPOOL_MIN/MAX)

### OpenAI errors
- Verify OPENAI_API_KEY is valid
- Check rate limits (Bottleneck settings in embeddings.ts)
- Model names: text-embedding-3-large, gpt-5-mini

### Download failures
- "Latest" dump may be incomplete, script auto-falls back
- Use `--dump-date 2025-11-06` for known complete dump
- Check disk space (~100GB for full decompressed data)

### Missing embeddings
- Run `pnpm features:embed` after ingestion
- Check OpenAI API key and quota
- Embeddings are generated incrementally (works without embedding)
