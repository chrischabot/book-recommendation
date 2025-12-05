import pLimit from "p-limit";
import { query, transaction } from "@/lib/db/pool";
import { logger, createTimer } from "@/lib/util/logger";
import { resolveAsinToWorkId, upsertUserEvents } from "@/lib/ingest/kindle";

const RESOLUTION_CONCURRENCY = 8;
const STALE_CURRENTLY_READING_DAYS = 30;
const resolveLimit = pLimit(RESOLUTION_CONCURRENCY);

function computeCurrentStreak(days: Date[]): number {
  if (days.length === 0) return 0;
  // Normalize to unique ISO dates and sort ascending
  const uniqueDays = Array.from(new Set(days.map((d) => d.toISOString().slice(0, 10)))).sort();
  let streak = 0;
  let prev: Date | null = null;

  for (let i = uniqueDays.length - 1; i >= 0; i--) {
    const cur = new Date(uniqueDays[i]);
    if (!prev) {
      streak = 1;
      prev = cur;
      continue;
    }

    const diffDays = Math.round(
      (prev.getTime() - cur.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (diffDays === 0) {
      continue; // same day duplicate
    }

    if (diffDays === 1) {
      streak += 1;
      prev = cur;
      continue;
    }

    break; // gap breaks current streak
  }

  return streak;
}

export async function aggregateKindleReading(userId: string): Promise<{
  aggregates: number;
  streak: number;
  eventsUpserted: number;
  autoDnfs: number;
}> {
  logger.info("Aggregating Kindle reading", { userId });
  const timer = createTimer("Kindle reading aggregate");

  // Clear existing aggregates to avoid stale rows
  await query(`DELETE FROM "UserReadingAggregate" WHERE user_id = $1`, [userId]);

  // Build aggregates from sessions
  await transaction(async (client) => {
    await client.query(
      `
      WITH session_durations AS (
        SELECT
          user_id,
          asin,
          COALESCE(
            duration_ms,
            GREATEST(EXTRACT(EPOCH FROM (COALESCE(end_at, start_at) - start_at)) * 1000, 0)
          ) AS dur,
          start_at,
          COALESCE(end_at, start_at) AS session_end
        FROM "UserReadingSession"
        WHERE user_id = $1
      )
      INSERT INTO "UserReadingAggregate"
        (user_id, asin, total_ms, sessions, last_read_at, avg_session_ms, max_session_ms, last_30d_ms, updated_at)
      SELECT
        user_id,
        asin,
        COALESCE(SUM(dur), 0) AS total_ms,
        COUNT(*) AS sessions,
        MAX(session_end) AS last_read_at,
        NULLIF(AVG(dur), 0) AS avg_session_ms,
        MAX(dur) AS max_session_ms,
        COALESCE(SUM(dur) FILTER (WHERE start_at >= NOW() - INTERVAL '30 days'), 0) AS last_30d_ms,
        NOW() AS updated_at
      FROM session_durations
      GROUP BY user_id, asin
      ON CONFLICT (user_id, asin) DO UPDATE SET
        total_ms = EXCLUDED.total_ms,
        sessions = EXCLUDED.sessions,
        last_read_at = EXCLUDED.last_read_at,
        avg_session_ms = EXCLUDED.avg_session_ms,
        max_session_ms = EXCLUDED.max_session_ms,
        last_30d_ms = EXCLUDED.last_30d_ms,
        updated_at = NOW()
      `,
      [userId]
    );
  });

  // Compute streak from day units
  const { rows: dayRows } = await query<{ day: Date }>(
    `SELECT day FROM "UserReadingDay" WHERE user_id = $1 ORDER BY day ASC`,
    [userId]
  );
  const streak = computeCurrentStreak(dayRows.map((r) => r.day));
  await query(
    `UPDATE "UserReadingAggregate" SET streak_days = $2, updated_at = NOW() WHERE user_id = $1`,
    [userId, streak]
  );

  // Upsert UserEvent entries for aggregated ASINs (currently-reading)
  const { rows: aggRows } = await query<{ asin: string; last_read_at: Date | null }>(
    `SELECT asin, last_read_at FROM "UserReadingAggregate" WHERE user_id = $1`,
    [userId]
  );

  const resolved = await Promise.all(
    aggRows.map((row) =>
      resolveLimit(async () => ({
        asin: row.asin,
        lastReadAt: row.last_read_at,
        workId: await resolveAsinToWorkId(row.asin),
      }))
    )
  );

  const events = resolved
    .filter((r) => r.workId)
    .map((r) => ({
      workId: r.workId as number,
      shelf: "currently-reading",
      finishedAt: r.lastReadAt ?? null,
      notes: "reading session",
    }));

  await upsertUserEvents(userId, events);

  const aggregates = aggRows.length;
  const eventsUpserted = events.length;

  const autoDnfs = await markStaleCurrentlyReading(userId);

  timer.end({ aggregates, streak, eventsUpserted, autoDnfs });

  return { aggregates, streak, eventsUpserted, autoDnfs };
}

async function markStaleCurrentlyReading(userId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `
    WITH updated AS (
      UPDATE "UserEvent" ue
      SET shelf = 'dnf',
          finished_at = COALESCE(ua.last_read_at::date, ue.finished_at),
          notes = TRIM(BOTH ' ' FROM CONCAT_WS(' | ', ue.notes, 'auto-dnf-stale'))
      FROM "Edition" e
      JOIN "UserReadingAggregate" ua
        ON ua.user_id = $1 AND ua.asin = e.asin
      LEFT JOIN "UserCompletionEvent" ce
        ON ce.user_id = $1 AND ce.asin = ua.asin
           AND ce.method IN ('auto_mark', 'insights_auto', 'insights_manual')
      WHERE ue.user_id = $1
        AND ue.source = 'kindle'
        AND ue.shelf = 'currently-reading'
        AND e.work_id = ue.work_id
        AND ua.last_read_at IS NOT NULL
        AND ua.last_read_at < NOW() - INTERVAL '${STALE_CURRENTLY_READING_DAYS} days'
        AND ce.asin IS NULL
      RETURNING 1
    )
    SELECT COUNT(*) FROM updated
    `,
    [userId]
  );

  return parseInt(rows[0]?.count ?? "0", 10);
}
