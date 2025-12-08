# Book Recommender

*A personal recommendation engine for those who believe algorithms should read more.*

## The Premise

You've read books. Quite a few, actually. Perhaps you've meticulously logged them in Goodreads, or Amazon has been quietly cataloging your Kindle habits with the enthusiasm of a Victorian naturalist documenting beetles. This system takes all that delightful data and does something useful with it: it finds you more books you'll actually want to read.

Unlike the recommendation engines of major retailers—which seem convinced that buying one cookbook means you've forsaken fiction forever—this system combines **vector embeddings**, **graph relationships**, and **collaborative filtering** to surface genuinely interesting suggestions. It's like having a well-read friend who remembers everything you've ever mentioned liking, except it won't judge you for that fantasy phase.

## What It Does

- **Ingests** the Open Library dataset (~18M works, because why think small?)
- **Imports** your reading history from Goodreads exports and Kindle data
- **Embeds** books using OpenAI's text-embedding-3-large (the ~550K works people actually read)
- **Builds** a taste profile from your reading patterns, weighted by ratings and engagement
- **Recommends** books using vector similarity, collaborative filtering, and diversity constraints
- **Searches** your library with fuzzy trigram matching for titles and authors
- **Visualizes** your "Reading DNA"—the books that most define your taste
- **Explains** why each book was suggested, because recommendations without reasons are just guesses with confidence

## Tech Stack

| Component | Choice |
|-----------|--------|
| Framework | Next.js 16 (App Router) |
| Database | PostgreSQL 16 + pgvector + pg_trgm |
| Embeddings | OpenAI text-embedding-3-large (1536 dims) |
| Styling | Tailwind CSS |
| Runtime | Node.js 20+ |

## Quick Start

```bash
# Install dependencies
pnpm install

# Start PostgreSQL (requires Docker)
pnpm docker:up

# Run database migrations
pnpm migrate

# Download Open Library data (~16GB, patience is a virtue)
pnpm download:ol

# Ingest the data (go make tea, this takes a while)
pnpm ingest:ol

# Import your reading history (see "Getting Your Data" below)
pnpm import:goodreads    # From Goodreads CSV export
pnpm import:kindle       # From Amazon data export

# Generate embeddings (~$8-12 in OpenAI costs)
pnpm features:embed

# Build your taste profile
pnpm profile:build

# Start the development server
pnpm dev
```

Visit [http://localhost:3000/recommendations](http://localhost:3000/recommendations) to meet your next favorite book.

## Getting Your Data

### Goodreads Export

1. Log in to [Goodreads](https://www.goodreads.com)
2. Go to **My Books** → **Import and Export** (or visit [goodreads.com/review/import](https://www.goodreads.com/review/import))
3. Click **Export Library**
4. Save the CSV file to `./data/goodreads/export.csv`

The export includes your shelves, ratings, and read dates—everything we need to understand your taste.

### Amazon / Kindle Data

Amazon knows more about your reading habits than you might expect. Here's how to liberate that data:

1. Go to [Amazon's Request Your Data](https://www.amazon.com/hz/privacy-central/data-requests/preview.html) page
2. Select **Request All Your Data** (or specifically "Digital Content" for just Kindle)
3. Wait for Amazon's email (usually 1-3 days, though they claim up to 30)
4. Download and extract the ZIP file
5. Copy the contents to `./data/kindle/`

The import script looks for these files in your Kindle export:
- `Retail.OrderHistory.csv` — Purchase history
- `Digital Items.csv` — Your Kindle library
- `Kindle.Devices.ReadingSession/` — Reading sessions and progress
- `Digital.PrimeReading.*/` — Prime Reading borrows

Don't worry if some files are missing—the importer takes what it can get.

## Environment Variables

Create a `.env` file:

```bash
# Required
DATABASE_URL="postgresql://books:books@localhost:5432/books"
OPENAI_API_KEY="sk-..."

# Optional
GOOGLE_BOOKS_API_KEY="..."    # For metadata enrichment
REDIS_URL="redis://localhost:6379"  # For response caching
```

## Data Sources

This system respects the commons. It uses:

- **[Open Library](https://openlibrary.org)** — The Internet Archive's open book database. We ingest their [bulk data dumps](https://openlibrary.org/developers/dumps) containing works, editions, authors, ratings, and reading logs.

- **[Google Books API](https://developers.google.com/books)** — For enriching metadata (descriptions, ratings, covers) when Open Library comes up short. Free tier is generous.

- **[OpenAI API](https://platform.openai.com)** — Powers the `text-embedding-3-large` model for semantic embeddings. Expect ~$8-12 to embed the full quality corpus.

- **Your exports** — Goodreads CSV and Amazon "Request Your Data" exports. Your reading history, your recommendations.

It does not scrape. Librarians have standards.

## The Recommendation Philosophy

Good recommendations require more than similarity. This system:

1. **Retrieves candidates** via vector search (what's semantically close)
2. **Expands** through author and subject relationships (what's contextually related)
3. **Incorporates** collaborative signals (what similar readers enjoyed)
4. **Re-ranks** with diversity constraints (so you don't get a list of clones)
5. **Explains** each suggestion (because "you might like this" is lazy)

The goal isn't to maximize engagement or sell you anything. It's to help you find books worth your finite reading hours.

## Book Resolution

Not every book lives in Open Library. Kindle exclusives, self-published gems, web serials—the literary demimonde exists, and this system knows how to find it.

### Multi-Source Resolution

When you import a book, the resolver attempts identification through multiple paths, each with its own confidence score:

| Path | Confidence | Description |
|------|------------|-------------|
| ISBN → Open Library | 0.98 | The gold standard. ISBN matched to OL's canonical work. |
| ISBN → Google Books | 0.85 | OL miss, but Google knows this one. |
| Google Volume ID | 0.82 | Direct Google Books lookup. |
| Title + Author → Google | 0.80 | Fuzzy matching when ISBNs are absent. |
| ASIN (Kindle) | 0.65 | Amazon's identifier. May merge later when better ID surfaces. |
| Royal Road ID | 0.60 | Web serial. The frontier of literature. |
| Goodreads ID | 0.55 | ID only—Goodreads guards its data jealously. |

### Duplicate Detection

The system employs trigram similarity matching (via PostgreSQL's `pg_trgm`) to detect when that "new" Kindle import is actually *The Great Gatsby* with a different cover. When duplicates are found, they're merged—editions consolidated, reading history unified, your recommendations none the wiser about the bibliographic chaos that nearly was.

### Concurrent Resolution

When importing large libraries, multiple books may resolve simultaneously. Advisory locking prevents the same work from being created twice by overeager parallel processes. The database remains pristine; the importer remains fast.

## How It Learns Your Taste

Your taste profile is built from multiple engagement signals, not just star ratings. The system extracts behavioral data from your Kindle reading patterns to understand *how* you read, not just *what* you read.

### Signals We Extract

| Signal | What It Means | Weight Impact |
|--------|---------------|---------------|
| **5-Star Ratings** | Explicit preference declaration | 4x boost |
| **Re-reads** | You loved it enough to read it again | Up to 3x boost |
| **Binge Sessions** | 4+ hour max session = couldn't put it down | Up to 1.5x boost |
| **Session Quality** | Long average sessions = deep engagement | Up to 1.5x boost |
| **Author Loyalty** | 3+ books by same author | Up to 2x boost |
| **Series Velocity** | Finished next book within 3 days | 1.3x boost |
| **Purchase vs KU** | Paid money = higher commitment | 1.15x boost |

### The DNF Paradox

Here's something counterintuitive: a "Did Not Finish" after 40 hours isn't a negative signal—it's positive. You spent 40 hours in that series because you *loved* it. You DNF'd because you wanted variety, not because you disliked it.

The system distinguishes:
- **DNF < 6 hours**: Never clicked with you. Negative signal.
- **DNF ≥ 6 hours**: Enjoyed it, moved on for variety. Neutral (no penalty).

### Recency Decay

Not all old favorites fade equally. Books with high engagement signals (re-reads, binge sessions) decay slower:
- **Normal books**: 2-year half-life
- **High-engagement favorites**: 4-year half-life

That book you've re-read five times will stay relevant to your profile much longer than something you read once in 2019.

## Your Reading DNA

The `/profile` page reveals the books that most shape your recommendations—your "Reading DNA." Each anchor book displays the engagement signals that earned its influence:

| Signal | Icon | Meaning |
|--------|------|---------|
| 5-Star | ★ | You gave it a perfect rating |
| Re-read | ↻ | You've read it multiple times |
| Binge | 🔥 | 4+ hour reading session |
| Deep Read | ⏱ | Long average session times |
| Fave Author | ♥ | You've read 3+ books by this author |
| Series Binge | ⚡ | Finished within 3 days of previous book |
| Purchased | $ | Bought, not borrowed |

You can also manually add books to your DNA using the favorite button on any book page. This is useful when the algorithm underweights something you particularly loved.

## Search

The `/search` page provides fuzzy search across your library using PostgreSQL's trigram similarity. Type a partial title or author name—even with typos—and the system finds what you're looking for. Results show match type (title vs. author match) and link directly to recommendation pages.

Search uses `pg_trgm` GIN indexes for sub-second fuzzy matching across millions of works.

## Collaborative Filtering

Beyond vector similarity, the system uses collaborative signals from Open Library's community:

### "Readers Also Read"

From millions of reading logs, we compute which books are frequently read together. The `WorkCooccurrence` table stores Jaccard similarity between work pairs—if 80% of people who read Book A also read Book B, that's a strong signal.

### Book Communities

Using co-occurrence data, we detect clusters of books that belong together (via label propagation). Each work gets a `community_id`, enabling recommendations like "other books in this reading community."

### List Companions

Open Library users create curated lists. Books appearing together in many lists share something—theme, mood, era—that pure vector similarity might miss.

## Scripts

```bash
# The full pipeline (for the patient)
pnpm update              # Download, ingest, import, embed, profile — everything

# Or à la carte
pnpm download:ol         # Download Open Library dumps
pnpm ingest:ol           # Ingest catalog data
pnpm enrich:gb           # Enrich with Google Books
pnpm enrich:descriptions # Fetch missing book descriptions
pnpm enrich:unknown-gb   # Small, bounded Google Books enrichment for unknown works
pnpm import:goodreads    # Import your Goodreads export
pnpm import:kindle       # Import your Kindle data
pnpm features:embed      # Generate embeddings
pnpm embed:user-events   # Embed all works in user's reading history
pnpm profile:build       # Build taste profile
pnpm refresh:all         # Refresh computed features

# Collaborative filtering & maintenance
pnpm cooccurrence:build  # Compute book co-occurrence (Jaccard similarity)
pnpm communities:build   # Detect book communities via label propagation
pnpm dedupe:cross-source # Merge duplicate works across data sources
pnpm enrich:authors      # Fetch missing author metadata
pnpm backup:embeddings   # Backup embeddings before migrations
```

## API Endpoints

```
GET /api/recommendations/general          # Personalized picks
GET /api/recommendations/by-book?work_id= # "More like this"
GET /api/recommendations/by-category?slug=# By genre
GET /api/profile?user_id=me               # Your taste profile with anchors
GET /api/profile/favorites?work_id=       # Check/manage favorite status
GET /api/search?q=&page=&page_size=       # Fuzzy search by title/author
GET /api/books/[workId]                   # Book details
```

## Database Indexes

Performance at scale requires forethought. The system uses specialized PostgreSQL indexes:

| Index | Type | Purpose |
|-------|------|---------|
| `work_embedding_ivfflat` | IVFFlat (pgvector) | Approximate nearest neighbor search across millions of works |
| `work_title_trgm_idx` | GIN (pg_trgm) | Fuzzy title matching for search and deduplication |
| `author_name_trgm_idx` | GIN (pg_trgm) | Fuzzy author name matching |
| `cooccurrence_a_jaccard_idx` | B-tree | Fast collaborative filtering lookups |
| `work_community_idx` | B-tree | Community-based recommendations |

The vector index uses IVFFlat with 500 lists—a balance between recall and speed suitable for datasets up to ~5M embedded works. Embeddings are dimension-reduced to 1536 (from the model's native 3072) to stay within pgvector's indexing limits while preserving semantic fidelity.

## Development

In development mode (`NODE_ENV=development`), API error responses include full stack traces and expandable error details. Production errors are logged but return only generic messages—because users don't need to know about your database connection pool exhaustion at 3am.

The app includes global error boundaries (`app/error.tsx` and `app/global-error.tsx`) that provide graceful recovery options for users while logging full stack traces for debugging.

## License

MIT. Take it, use it, improve it. Just maybe recommend a good book sometime.

---

*"The only thing better than a good book is knowing which good book to read next."*
