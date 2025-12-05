# Kindle Data Integration Plan

Comprehensive plan to ingest and leverage Amazon/Kindle export data for better library coverage, completion accuracy, and reading-intensity signals.

## Goals
- Capture owned/borrowed Kindle books (ASIN-first) with purchase/borrow dates.
- Improve completion and in-progress status from Kindle-specific signals.
- Add reading-intensity metrics (time spent, recency, streaks) to strengthen profiles and reranking.
- Keep ingestion optional and fast; avoid polluting recs with samples/pdocs.

## High-Value Files (observed columns)
- `Digital.Content.Ownership/*.json`: rights[].{rightType,rightStatus,acquiredDate,origin.originType}, resource.{resourceType,asin,productName,catalog,orderId,transactionId}
- `Digital.SeriesContent.Relation.2/BookRelation.csv`: ASIN, Product Name, Creation Date (purchase timestamp)
- `Digital.SeriesContent.Relation.1/SeriesRelation.csv`: ASIN, Product Name, Update Count, Creation Date (weak series info)
- `Kindle.Devices.autoMarkAsRead/Kindle.Devices.autoMarkAsRead.csv`: created_timestamp, device_family, active_ASIN, file_auto_marked_as_read
- `Digital.Content.Whispersync/whispersync.csv`: ASIN, Product Name, Annotation Type (kindle.last_read|most_recent_read|continuous_read...), Customer modified date on device, Creation Date, LastUpdatedDate
- `Kindle.ReadingInsights/datasets/Kindle.UserUniqueTitlesCompleted/*.csv`: asin_date_and_content_type (ASIN + date + AUTO/MANUAL), product_name
- `Kindle.ReadingInsights/datasets/Kindle.reading-insights-sessions_with_adjustments/*.csv`: ASIN, start_time, end_time, total_reading_milliseconds, product_name
- `Kindle.ReadingInsights/datasets/Kindle.ReadingInsightsDayUnits/*.csv`: reading_tracked_on_day (UTC date)
- `Kindle.Devices.EreaderDeviceActiveUsageTime/Kindle.Devices.EreaderDeviceActiveUsageTime.csv`: created_timestamp, ASIN, device_active_time_in_ms, device_family
- `Kindle.Devices.ReadingSession/Kindle.Devices.ReadingSession.csv`: start_timestamp, end_timestamp, ASIN, total_reading_millis, number_of_page_flips, content_type

## Schema Additions
1) `KindleOwnership`
- Columns: user_id, asin, product_name, origin_type, right_type, right_status, acquired_at, last_updated_at, resource_type, order_id, transaction_id, raw JSON
- PK: (user_id, asin, right_type)
- Filter to resource_type in (KindleEBook) and origin_type in (Purchase, KindleUnlimited). Skip Samples/PDocs in recs.

2) `UserCompletionEvent`
- Columns: user_id, asin, completed_at, method enum (auto_mark | insights_auto | insights_manual | whispersync_last_read), source_file
- PK: (user_id, asin, method, completed_at)

3) `UserReadingSession`
- Columns: user_id, asin, start_at, end_at, duration_ms, source enum (ri_adjusted | ereader_active | legacy_session), device_family
- PK: (user_id, asin, start_at, source)

4) `UserReadingDay`
- Columns: user_id, day, source (ri_day_units)
- PK: (user_id, day, source)

5) `UserReadingAggregate`
- Columns: user_id, asin, total_ms, sessions, last_read_at, avg_session_ms, max_session_ms, streak_days, last_30d_ms, updated_at
- PK: (user_id, asin); indexes on (user_id, last_read_at DESC)

## Resolver Updates
- Add ASIN-first resolution path in resolverV2; populate Edition.asin and link to Work.
- Fallback: title match using product_name when ASIN fails.

## Ingestion Steps
### Ownership (library)
- Implemented in `lib/ingest/kindle.ts` from `Digital.Content.Ownership/*.json` and `Digital.SeriesContent.Relation.2/BookRelation.csv` (tolerant CSV parsing).
- Stores `KindleOwnership`; creates `UserEvent` rows as `to-read` (Purchase/KU only) once ASIN resolves (via resolverV2 → Edition.asin).

### Completion signals
- Implemented in `lib/ingest/kindle.ts` from autoMarkAsRead, UserUniqueTitlesCompleted, and Whispersync (last_read / most_recent_read / continuous_read).
- Writes `UserCompletionEvent`; upgrades `UserEvent` to `read` (completion priority: auto_mark > insights_auto > insights_manual) or `currently-reading` from Whispersync last_read.

### Sessions (reading intensity)
- Implemented in `lib/ingest/kindle.ts` from reading-insights sessions (preferred), EreaderDeviceActiveUsageTime, and legacy ReadingSession (filters to E-Book, skips "Not Available"). CSV parser is relaxed about quotes.
- Writes `UserReadingSession`; day-level entries go to `UserReadingDay`.

### Aggregation job
- `lib/ingest/kindleAggregate.ts` + `scripts/aggregate-kindle-reading.ts`.
- Deletes/rebuilds `UserReadingAggregate` per user (sums duration, counts sessions, last_read_at, last_30d_ms, streak_days from `UserReadingDay`).
- Upserts `UserEvent` as `currently-reading` with `finished_at = last_read_at` to keep recency aligned.

## Profile & Recs Integration
- `lib/features/userProfile.ts`: pulls aggregates via Edition.asin; recency uses `finished_at` fallback to `last_read_at`; boosts weights based on `total_ms` and `last_30d_ms`.
- Future: incorporate `UserReadingAggregate` into rerank/explain for novelty/diversity/explanations (not yet wired).

## Heuristics
- Ignore Samples/PDocs for recommendations; keep KindleUnlimited as borrow.
- Dedup per ASIN by latest timestamp in each category.
- Trust completion priority: auto_mark/insights_auto > insights_manual > whispersync.
- Time parsing: all timestamps in UTC (trailing Z); parse as UTC.
- Device serials stored but not surfaced.
- Stale detection: `currently-reading` Kindle rows with no completion and `last_read_at` older than 30 days are downgraded to `dnf` (finished_at set to last_read_at, notes preserved).

## Script Flags (extend `scripts/import-kindle.ts`)
- `--ownership` (default true)
- `--completions` (default true)
- `--sessions` (default true)
- `--clippings` (existing)
- `--aggregate` (default true; runs aggregation + UserEvent sync + cache invalidation)
- `--force` (default false; bypasses mtime/db freshness check)
- `--dir` for export path
- Handy scripts:
  - `pnpm kindle:enrich` — rerun resolver on Kindle ASINs
- `pnpm kindle:dedupe` — merge duplicate works sharing an ASIN
- `pnpm kindle:fix-unknowns` — replace placeholder titles from KindleOwnership (optional `--enrich`)
- `pnpm embed:user-events -- --user me` — generate embeddings for Kindle/Goodreads events that don't meet the global quality thresholds
- `pnpm fetch:ol-isbns` — fetch ISBNs for unknown OL works and upsert editions/ISBNs
- `pnpm enrich:unknown-gb -- --limit 50 --concurrency 2` — small-batch Google Books enrichment for unknown-title works with ISBNs (fast, avoids long stalls)

## Execution Order
1) Ingest ownership → populate KindleOwnership + initial `UserEvent` to-read.
2) Ingest completions → upgrade to read/finished_at.
3) Ingest sessions + day_units → populate sessions/days.
4) Aggregate (`aggregate:kindle` or import flag) → fill `UserReadingAggregate`, upsert recency into `UserEvent`, auto-DNF stale currently-reading (>30d, no completion).
5) Re-enrich (`reenrich:kindle`) to re-run resolver on ASINs (helps fix “Unknown” titles/duplicates).
6) Invalidate caches (built into scripts).
7) Embed user-event works (`pnpm embed:user-events -- --user me`) so profile/rerank have vectors for Kindle-only titles, then rebuild profile (`pnpm profile:build -- --user me`).

## Freshness guard
- Import skips if the latest file mtime in the export dir is older than or equal to the latest Kindle data for the user (across ownership/completion/sessions/day tables). Use `--force` to override.

## QA Checklist
- Spot-check a few ASINs across ownership, completion, sessions to ensure consistent work_id mapping.
- Verify samples/pdocs excluded from UserEvent.
- Ensure conflicts: UserEvent ON CONFLICT (user_id, work_id, source) keeps latest finished_at.
- Check aggregates: total_ms non-negative; streak_days computed from DayUnits; last_read_at matches latest session/completion.
- Run `pnpm test` (once tests exist) + manual query sanity for one user_id.

## Recent findings
- Unknown works: 1,031 titles remain `unknown%`; 815 now carry ISBNs (via `fetch:ol-isbns`), and unknown Amazon titles stay until a title/product_name is available.
- Use repeated small runs of `pnpm enrich:unknown-gb` to gradually enrich ISBN-backed unknowns without hitting long 429/503 stalls.
