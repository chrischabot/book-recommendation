# Design Guide

This document explains the data sources, where they land in the database, how they relate, and how to query them to power recommendations (general, by-category, by-book) and UI presentation.

## Data Sources → Tables
- **Open Library dumps** → `Work` (works), `Edition` (ISBN/ASIN/volume ids), `Author`, `WorkAuthor`, `WorkSubject`, `OLRating`, `OLReadingLog`, `OLList`, `OLListSeed`, `WorkPopularity`, `WorkOLRating`, `OLRedirect`, `OLCover`.
- **Google Books API** → `Rating` (source=`googlebooks`), `Work.description` (if missing), `WorkSubject` (categories), `Edition.google_volume_id`, `Edition.ol_data` enrichment.
- **Kindle export** → `KindleOwnership` (ASIN + product_name), `UserCompletionEvent`, `UserReadingSession`, `UserReadingDay`, `UserReadingAggregate`, `UserEvent` (to-read/read/currently-reading/dnf), `Edition.asin`.
- **Goodreads CSV** → `UserEvent` (shelf/rating/finished_at), `Edition.goodreads_book_id`.
- **OpenAI** → `Work.embedding`, `UserProfile.profile_vec`, explanations (LLM).

## Key Relationships
- `Edition.work_id → Work.id`
- `Edition.asin` ↔ `KindleOwnership.asin` ↔ `UserReadingAggregate.asin`
- `UserEvent.user_id + work_id` links user history to `Work.embedding`
- `UserReadingAggregate` joins through `Edition.asin` to add engagement signals to recs and explanations.
- Subjects/authors: `WorkSubject.subject` and `WorkAuthor.author_id → Author.name`

## Query Cheat Sheet
### General recommendations (personalized)
1. Fetch user profile: `SELECT profile_vec FROM "UserProfile" WHERE user_id=$1`
2. Candidate KNN: `SELECT id, 1 - (embedding <=> $profile_vec) AS sim FROM "Work" WHERE embedding IS NOT NULL ORDER BY embedding <=> $profile_vec LIMIT 2000`
3. Exclude already-read: `WHERE NOT EXISTS (SELECT 1 FROM "UserEvent" ue WHERE ue.user_id=$1 AND ue.work_id=w.id)`
4. Join quality/diversity metadata: `Rating`, `WorkSubject`, `work_authors_agg`, `WorkPopularity`
5. Engagement join: `LEFT JOIN "Edition" e ON e.work_id=w.id LEFT JOIN "UserReadingAggregate" agg ON agg.user_id=$1 AND agg.asin=e.asin`

### By-category (slug)
```sql
SELECT w.id, w.title, w.embedding
FROM "Work" w
JOIN "WorkSubject" ws ON ws.work_id=w.id
WHERE ws.subject = $slug AND w.embedding IS NOT NULL;
```
Then rerank with user profile (if available) or category-centric scoring.

### By-book (“more like this”)
```sql
-- get anchor work embedding
SELECT embedding FROM "Work" WHERE id=$workId;
-- KNN
SELECT id, 1 - (embedding <=> $anchor_embedding) AS sim
FROM "Work" WHERE id <> $workId AND embedding IS NOT NULL
ORDER BY embedding <=> $anchor_embedding
LIMIT 500;
```
Exclude user-read, then rerank with diversity/quality.

### Engagement highlights (for explanations/UI badges)
```sql
SELECT w.id, agg.total_ms, agg.last_read_at, agg.last_30d_ms
FROM "Work" w
JOIN "Edition" e ON e.work_id = w.id
JOIN "UserReadingAggregate" agg ON agg.asin = e.asin
WHERE agg.user_id = $userId;
```
Compute hours = `total_ms/3600000`; last sprint date = `last_read_at`.

### “Unknown” cleanup helpers
- Fetch ISBNs for unknown OL works: `pnpm fetch:ol-isbns`
- Small-batch GB enrichment for unknowns with ISBNs: `pnpm enrich:unknown-gb -- --limit 50 --concurrency 2`

## Recommendation Signals & Scoring
- **Relevance**: cosine(user_profile, work_embedding)
- **Quality**: ratings (OL + Google Books) with Bayesian smoothing
- **Novelty**: penalize too-similar to user’s recent reads (recency from `UserEvent.finished_at` or `agg.last_read_at`)
- **Diversity**: MMR across authors/subjects
- **Engagement boost**: from `UserReadingAggregate.total_ms` and `last_30d_ms`
- **Exclusions**: user already read (`UserEvent`), blocked (`Block`)

## UI Data Map (where to pull)
- **Title/Subtitles**: `Work.title`, `Work.subtitle`
- **Author names**: join `WorkAuthor` → `Author.name`
- **Cover image**: `Work.cover_id` via OL cover service, or `Edition.cover_url` if present
- **Subjects/Labels**: `WorkSubject.subject` (category tags), `Rating.source`
- **Quality badge**: from `Rating` (avg/count)
- **Engagement pill**: from `UserReadingAggregate.total_ms`/`last_read_at` via Edition.asin match
- **Because you read…**: from rerank/explain, include anchors and engagement (“matched because you read {book} for a 3.2h sprint” using `last_read_at`/`total_ms`)
- **Match %**: derive from normalized rerank score (e.g., scale 0–1 relevance to 0–100)

## Front-end Flows
- **General**: call `/api/recommendations/general?user_id=me&page=1&page_size=24` (uses profile, excludes read)
- **By-category**: `/api/recommendations/by-category?user_id=me&slug=sci-fi&page=1` (filters by subject, reranks with profile if present)
- **By-book**: `/api/recommendations/by-book?user_id=me&work_id=123&k=100` (seeded by anchor work embedding)

## Operational Tips
- Run enrichment in small batches to avoid timeouts: `pnpm enrich:unknown-gb -- --limit 50 --concurrency 2`
- After new imports: `pnpm embed:user-events && pnpm profile:build -- --user me`
- Unknown Amazon titles require product_name or manual title; Amazon page scraping (including archive.org mirrors) is out-of-scope per data policy.
