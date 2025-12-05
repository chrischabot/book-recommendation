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
