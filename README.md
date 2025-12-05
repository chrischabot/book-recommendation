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
- **Recommends** books using vector similarity, with diversity constraints so you don't get fifteen variations of the same novel
- **Explains** why each book was suggested, because recommendations without reasons are just guesses with confidence

## Tech Stack

| Component | Choice |
|-----------|--------|
| Framework | Next.js 16 (App Router) |
| Database | PostgreSQL 16 + pgvector |
| Embeddings | OpenAI text-embedding-3-large |
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

# Import your reading history
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

- **Open Library** — The Internet Archive's open book database
- **Google Books API** — For metadata enrichment
- **Your exports** — Goodreads CSV, Amazon "Request Your Data"

It does not scrape. Librarians have standards.

## The Recommendation Philosophy

Good recommendations require more than similarity. This system:

1. **Retrieves candidates** via vector search (what's semantically close)
2. **Expands** through author and subject relationships (what's contextually related)
3. **Incorporates** collaborative signals (what similar readers enjoyed)
4. **Re-ranks** with diversity constraints (so you don't get a list of clones)
5. **Explains** each suggestion (because "you might like this" is lazy)

The goal isn't to maximize engagement or sell you anything. It's to help you find books worth your finite reading hours.

## Scripts

```bash
# The full pipeline (for the patient)
pnpm update              # Download, ingest, import, embed, profile — everything

# Or à la carte
pnpm download:ol         # Download Open Library dumps
pnpm ingest:ol           # Ingest catalog data
pnpm enrich:gb           # Enrich with Google Books
pnpm enrich:descriptions # Fetch missing book descriptions
pnpm import:goodreads    # Import your Goodreads export
pnpm import:kindle       # Import your Kindle data
pnpm features:embed      # Generate embeddings
pnpm profile:build       # Build taste profile
pnpm refresh:all         # Refresh computed features
```

## Project Structure

```
app/                    # Next.js pages and API routes
lib/
  ├── db/               # Database connection and utilities
  ├── features/         # Embedding generation, user profiles
  ├── ingest/           # Data import from various sources
  └── recs/             # Recommendation engine
scripts/                # CLI tools for data pipeline
db/migrations/          # SQL schema migrations
```

## API Endpoints

```
GET /api/recommendations/general          # Personalized picks
GET /api/recommendations/by-book?work_id= # "More like this"
GET /api/recommendations/by-category?slug=# By genre
```

## License

MIT. Take it, use it, improve it. Just maybe recommend a good book sometime.

---

*"The only thing better than a good book is knowing which good book to read next."*
