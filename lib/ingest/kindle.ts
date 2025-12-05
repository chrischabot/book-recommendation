/**
 * Kindle/Amazon data export parser
 * Imports ownership, completion, and reading-intensity signals.
 */

import { existsSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";
import { query, transaction } from "@/lib/db/pool";
import { resolveWork } from "@/lib/ingest/resolverV2";
import { logger, createTimer } from "@/lib/util/logger";

// Concurrency for resolver calls
const RESOLUTION_CONCURRENCY = 8;
const INSERT_BATCH_SIZE = 500;

type ImportOptions = {
  exportDir: string;
  userId: string;
  resolveUnknown?: boolean;
  importClippings?: boolean;
  ownership?: boolean;
  completions?: boolean;
  sessions?: boolean;
  dayUnits?: boolean;
  force?: boolean;
};

type ImportStats = {
  ownershipRows: number;
  ownershipEvents: number;
  completionEvents: number;
  completionUpserts: number;
  sessions: number;
  dayUnits: number;
  clippings: number;
  resolved: number;
  errors: number;
  skipped?: boolean;
};

type CompletionMethod = "auto_mark" | "insights_auto" | "insights_manual" | "whispersync_last_read";

const asinResolutionCache = new Map<string, Promise<number | null>>();
const resolveLimit = pLimit(RESOLUTION_CONCURRENCY);

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function resolveAsinToWorkId(asin: string, title?: string): Promise<number | null> {
  const key = asin.toUpperCase();
  const cachedPromise = asinResolutionCache.get(key);
  if (cachedPromise) {
    return cachedPromise;
  }

  const promise = resolveLimit(async () => {
    try {
      const resolved = await resolveWork({ asin: key, title: title || key });
      return resolved.workId;
    } catch (error) {
      logger.warn("Failed to resolve ASIN", { asin: key, error: String(error) });
      // If unique constraint hit or other failure, try to reuse existing edition
      try {
        const { rows } = await query<{ work_id: number }>(
          `SELECT work_id FROM "Edition" WHERE asin = $1 LIMIT 1`,
          [key]
        );
        if (rows[0]?.work_id) {
          return rows[0].work_id;
        }
      } catch (err) {
        logger.warn("Failed to fallback resolve ASIN", { asin: key, error: String(err) });
      }
      return null;
    }
  });

  asinResolutionCache.set(key, promise);
  return promise;
}

export async function upsertUserEvents(
  userId: string,
  events: Array<{ workId: number; shelf: string; finishedAt?: Date | null; notes?: string | null }>
): Promise<void> {
  if (events.length === 0) return;

  // Deduplicate by workId, keeping highest-priority shelf and latest finishedAt
  const priority: Record<string, number> = {
    dnf: 4,
    read: 3,
    "currently-reading": 2,
    "to-read": 1,
  };
  const merged = new Map<number, { workId: number; shelf: string; finishedAt?: Date | null; notes?: string | null }>();

  for (const event of events) {
    const existing = merged.get(event.workId);
    if (!existing) {
      merged.set(event.workId, { ...event });
      continue;
    }

    const existingPriority = priority[existing.shelf] ?? 0;
    const incomingPriority = priority[event.shelf] ?? 0;

    if (incomingPriority > existingPriority) {
      merged.set(event.workId, { ...event });
      continue;
    }

    if (incomingPriority === existingPriority) {
      const latestFinished =
        existing.finishedAt && event.finishedAt
          ? existing.finishedAt > event.finishedAt
            ? existing.finishedAt
            : event.finishedAt
          : existing.finishedAt ?? event.finishedAt ?? null;

      merged.set(event.workId, {
        workId: event.workId,
        shelf: existing.shelf,
        finishedAt: latestFinished,
        notes: existing.notes ?? event.notes ?? null,
      });
    }
  }

  const dedupedEvents = Array.from(merged.values());

  for (const batch of chunkArray(dedupedEvents, INSERT_BATCH_SIZE)) {
    const values: unknown[] = [];
    const placeholders: string[] = [];

    batch.forEach((event, idx) => {
      const offset = idx * 5;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
      );
      values.push(
        userId,
        event.workId,
        event.shelf,
        event.finishedAt ?? null,
        event.notes ?? null
      );
    });

    await transaction(async (client) => {
      await client.query(
        `
        INSERT INTO "UserEvent" (user_id, work_id, shelf, finished_at, source, notes)
        SELECT v.user_id, v.work_id::bigint, v.shelf, v.finished_at::date, 'kindle', v.notes
        FROM (VALUES ${placeholders.join(",")}) AS v(user_id, work_id, shelf, finished_at, notes)
        ON CONFLICT (user_id, work_id, source) DO UPDATE SET
          shelf = CASE
            WHEN "UserEvent".shelf IN ('read', 'dnf') THEN "UserEvent".shelf
            ELSE EXCLUDED.shelf
          END,
          finished_at = CASE
            WHEN EXCLUDED.finished_at IS NULL THEN "UserEvent".finished_at
            WHEN "UserEvent".finished_at IS NULL THEN EXCLUDED.finished_at
            ELSE GREATEST("UserEvent".finished_at, EXCLUDED.finished_at)
          END,
          notes = COALESCE(EXCLUDED.notes, "UserEvent".notes)
        `,
        values
      );
    });
  }
}

async function ingestOwnership(
  exportDir: string,
  userId: string
): Promise<{ rows: number; events: number; resolved: number }> {
  const ownershipDir = join(exportDir, "Digital.Content.Ownership");
  let files: string[] = [];
  try {
    files = await readdir(ownershipDir);
  } catch (error) {
    logger.warn("Ownership directory missing", { dir: ownershipDir, error: String(error) });
    return { rows: 0, events: 0, resolved: 0 };
  }

  type OwnershipRow = {
    asin: string;
    productName?: string;
    originType?: string;
    rightType?: string;
    rightStatus?: string;
    resourceType?: string;
    acquiredAt?: Date | null;
    lastUpdatedAt?: Date | null;
    orderId?: string | null;
    transactionId?: string | null;
    raw?: unknown;
  };

  const merged = new Map<string, OwnershipRow>();

  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const filePath = join(ownershipDir, file);
    try {
      const json = JSON.parse(await readFile(filePath, "utf-8"));
      const rights = Array.isArray(json.rights) ? json.rights : [];
      const resource = json.resource ?? {};

      for (const right of rights) {
        const asin = resource.asin || resource.ASIN;
        if (!asin) continue;

        const rightType = right.rightType || "Unknown";
        const key = `${asin.toUpperCase()}|${rightType}`;
        const existing = merged.get(key);
        const acquiredAt = parseDate(right.acquiredDate);

        const row: OwnershipRow = {
          asin: asin.toUpperCase(),
          productName: resource.productName,
          originType: right.origin?.originType,
          rightType,
          rightStatus: right.rightStatus,
          resourceType: resource.resourceType,
          acquiredAt,
          lastUpdatedAt: parseDate(json.lastUpdatedDate),
          orderId: resource.orderId,
          transactionId: resource.transactionId,
          raw: json,
        };

        if (!existing) {
          merged.set(key, row);
        } else {
          const preferThis =
            (!existing.acquiredAt && acquiredAt) ||
            (acquiredAt && existing.acquiredAt && acquiredAt < existing.acquiredAt);
          if (preferThis) {
            merged.set(key, row);
          }
        }
      }
    } catch (error) {
      logger.warn("Failed to parse ownership file", { file, error: String(error) });
    }
  }

  // BookRelation (series content purchases)
  const bookRelation = join(exportDir, "Digital.SeriesContent.Relation.2/BookRelation.csv");
  if (existsSync(bookRelation)) {
    try {
      const rows = parse(await readFile(bookRelation, "utf-8"), {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
        relax_quotes: true,
        skip_records_with_error: true,
      }) as Array<{ ASIN: string; "Product Name": string; "Creation Date": string }>;

      for (const row of rows) {
        if (!row.ASIN) continue;
        const key = `${row.ASIN.toUpperCase()}|Download`;
        const acquiredAt = parseDate(row["Creation Date"]);
        const existing = merged.get(key);
        const productName = row["Product Name"];

        const next: OwnershipRow = {
          asin: row.ASIN.toUpperCase(),
          productName: productName === "Not Available" ? undefined : productName,
          originType: "Purchase",
          rightType: "Download",
          rightStatus: "Active",
          resourceType: "KindleEBook",
          acquiredAt,
        };

        if (!existing || (acquiredAt && existing.acquiredAt && acquiredAt < existing.acquiredAt)) {
          merged.set(key, next);
        }
      }
    } catch (error) {
      logger.warn("Failed to parse BookRelation.csv", { error: String(error) });
    }
  }

  const ownershipRows = Array.from(merged.values());
  const ownershipEvents: Array<{ asin: string; title?: string; acquiredAt?: Date | null }> = [];

  for (const batch of chunkArray(ownershipRows, INSERT_BATCH_SIZE)) {
    const values: unknown[] = [];
    const placeholders: string[] = [];

    batch.forEach((row, idx) => {
      const offset = idx * 12;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12})`
      );
      values.push(
        userId,
        row.asin,
        row.productName ?? null,
        row.originType ?? null,
        row.rightType ?? "Unknown",
        row.rightStatus ?? null,
        row.resourceType ?? null,
        row.acquiredAt ?? null,
        row.lastUpdatedAt ?? null,
        row.orderId ?? null,
        row.transactionId ?? null,
        row.raw ? JSON.stringify(row.raw) : null
      );
    });

    await transaction(async (client) => {
      await client.query(
        `
        INSERT INTO "KindleOwnership"
          (user_id, asin, product_name, origin_type, right_type, right_status, resource_type, acquired_at, last_updated_at, order_id, transaction_id, raw)
        VALUES ${placeholders.join(",")}
        ON CONFLICT (user_id, asin, right_type) DO UPDATE SET
          product_name = COALESCE(EXCLUDED.product_name, "KindleOwnership".product_name),
          origin_type = COALESCE(EXCLUDED.origin_type, "KindleOwnership".origin_type),
          right_status = COALESCE(EXCLUDED.right_status, "KindleOwnership".right_status),
          resource_type = COALESCE(EXCLUDED.resource_type, "KindleOwnership".resource_type),
          acquired_at = COALESCE(EXCLUDED.acquired_at, "KindleOwnership".acquired_at),
          last_updated_at = COALESCE(EXCLUDED.last_updated_at, "KindleOwnership".last_updated_at),
          order_id = COALESCE(EXCLUDED.order_id, "KindleOwnership".order_id),
          transaction_id = COALESCE(EXCLUDED.transaction_id, "KindleOwnership".transaction_id),
          raw = COALESCE(EXCLUDED.raw, "KindleOwnership".raw)
        `,
        values
      );
    });
  }

  for (const row of ownershipRows) {
    const eligible =
      (!row.rightStatus || row.rightStatus === "Active") &&
      (!row.originType || ["Purchase", "KindleUnlimited"].includes(row.originType)) &&
      (!row.resourceType || row.resourceType === "KindleEBook");

    if (eligible) {
      ownershipEvents.push({
        asin: row.asin,
        title: row.productName,
        acquiredAt: row.acquiredAt,
      });
    }
  }

  const eventsToInsert: Array<{ workId: number; finishedAt: Date | null; notes?: string | null }> = [];
  const resolvedOwnership = await Promise.all(
    ownershipEvents.map(async (evt) => ({
      workId: await resolveAsinToWorkId(evt.asin, evt.title),
      evt,
    }))
  );

  let resolved = 0;
  for (const item of resolvedOwnership) {
    if (!item.workId) continue;
    resolved++;
    eventsToInsert.push({
      workId: item.workId,
      finishedAt: item.evt.acquiredAt ?? null,
      notes: item.evt.title ?? null,
    });
  }

  await upsertUserEvents(
    userId,
    eventsToInsert.map((e) => ({ ...e, shelf: "to-read" }))
  );

  return { rows: ownershipRows.length, events: eventsToInsert.length, resolved };
}

async function ingestCompletions(
  exportDir: string,
  userId: string
): Promise<{ events: number; upserts: number; resolved: number }> {
  type CompletionEvent = { asin: string; completedAt: Date; method: CompletionMethod };
  const completionEvents: CompletionEvent[] = [];

  const autoMarkPath = join(exportDir, "Kindle.Devices.autoMarkAsRead/Kindle.Devices.autoMarkAsRead.csv");
  if (existsSync(autoMarkPath)) {
    const rows = parse(await readFile(autoMarkPath, "utf-8"), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
    }) as Array<{ created_timestamp: string; file_auto_marked_as_read: string }>;

    for (const row of rows) {
      if (!row.file_auto_marked_as_read) continue;
      const date = parseDate(row.created_timestamp);
      if (!date) continue;
      completionEvents.push({
        asin: row.file_auto_marked_as_read.toUpperCase(),
        completedAt: date,
        method: "auto_mark",
      });
    }
  }

  const uniqueCompletedPath = join(
    exportDir,
    "Kindle.ReadingInsights/datasets/Kindle.UserUniqueTitlesCompleted/Kindle.UserUniqueTitlesCompleted.csv"
  );
  if (existsSync(uniqueCompletedPath)) {
    const rows = parse(await readFile(uniqueCompletedPath, "utf-8"), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
    }) as Array<{ asin_date_and_content_type: string; product_name?: string }>;

    for (const row of rows) {
      const key = row.asin_date_and_content_type;
      if (!key) continue;
      const parts = key.split("_");
      if (parts.length < 3) continue;
      const asin = parts[0].toUpperCase();
      const date = parseDate(parts[1]);
      const methodRaw = parts[2].toLowerCase();
      if (!date) continue;
      const method: CompletionMethod =
        methodRaw === "automatic" ? "insights_auto" : "insights_manual";
      completionEvents.push({ asin, completedAt: date, method });
    }
  }

  const whisperPath = join(exportDir, "Digital.Content.Whispersync/whispersync.csv");
  if (existsSync(whisperPath)) {
    const rows = parse(await readFile(whisperPath, "utf-8"), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
    }) as Array<{
      ASIN: string;
      "Annotation Type": string;
      "Customer modified date on device": string;
      "Product Name"?: string;
      "Is Deleted"?: string;
    }>;

    for (const row of rows) {
      const asin = row.ASIN;
      if (!asin) continue;
      if (row["Is Deleted"] && row["Is Deleted"].toLowerCase() === "yes") continue;

      const annotation = row["Annotation Type"]?.toLowerCase();
      if (!annotation) continue;
      if (
        annotation !== "kindle.last_read" &&
        annotation !== "kindle.most_recent_read" &&
        annotation !== "kindle.continuous_read"
      ) {
        continue;
      }

      const date = parseDate(row["Customer modified date on device"]);
      if (!date) continue;

      completionEvents.push({
        asin: asin.toUpperCase(),
        completedAt: date,
        method: "whispersync_last_read",
      });
    }
  }

  // Insert completion events table
  for (const batch of chunkArray(completionEvents, INSERT_BATCH_SIZE)) {
    const values: unknown[] = [];
    const placeholders: string[] = [];

    batch.forEach((evt, idx) => {
      const offset = idx * 4;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`
      );
      values.push(userId, evt.asin, evt.completedAt, evt.method);
    });

    await transaction(async (client) => {
      await client.query(
        `
        INSERT INTO "UserCompletionEvent" (user_id, asin, completed_at, method)
        VALUES ${placeholders.join(",")}
        ON CONFLICT (user_id, asin, method, completed_at) DO NOTHING
        `,
        values
      );
    });
  }

  // Determine best shelf updates per ASIN
  type AggregatedCompletion = {
    finishAt: Date | null;
    finishMethod?: CompletionMethod;
    lastReadAt: Date | null;
  };

  const byAsin = new Map<string, AggregatedCompletion>();
  const priority: Record<CompletionMethod, number> = {
    auto_mark: 3,
    insights_auto: 2,
    insights_manual: 1,
    whispersync_last_read: 0,
  };

  for (const evt of completionEvents) {
    const existing = byAsin.get(evt.asin) ?? { finishAt: null, lastReadAt: null };
    if (evt.method === "whispersync_last_read") {
      if (!existing.lastReadAt || evt.completedAt > existing.lastReadAt) {
        existing.lastReadAt = evt.completedAt;
      }
    } else {
      const better =
        !existing.finishAt ||
        evt.completedAt > existing.finishAt ||
        (existing.finishMethod && priority[evt.method] > priority[existing.finishMethod]);
      if (better) {
        existing.finishAt = evt.completedAt;
        existing.finishMethod = evt.method;
      }
    }
    byAsin.set(evt.asin, existing);
  }

  const eventsToInsert: Array<{ workId: number; shelf: string; finishedAt: Date | null; notes?: string }> = [];
  const resolvedCompletions = await Promise.all(
    Array.from(byAsin.entries()).map(async ([asin, info]) => ({
      asin,
      info,
      workId: await resolveAsinToWorkId(asin),
    }))
  );

  let resolved = 0;

  for (const item of resolvedCompletions) {
    if (!item.workId) continue;
    resolved++;

    if (item.info.finishAt) {
      eventsToInsert.push({
        workId: item.workId,
        shelf: "read",
        finishedAt: item.info.finishAt,
        notes: item.info.finishMethod,
      });
    } else if (item.info.lastReadAt) {
      eventsToInsert.push({
        workId: item.workId,
        shelf: "currently-reading",
        finishedAt: item.info.lastReadAt,
        notes: "whispersync",
      });
    }
  }

  await upsertUserEvents(userId, eventsToInsert);

  return {
    events: completionEvents.length,
    upserts: eventsToInsert.length,
    resolved,
  };
}

async function ingestSessions(
  exportDir: string,
  userId: string
): Promise<{ sessions: number }> {
  type SessionRow = {
    asin: string;
    start_at: Date;
    end_at?: Date | null;
    duration_ms?: number | null;
    source: "ri_adjusted" | "ereader_active" | "legacy_session";
    device_family?: string | null;
  };

  const sessions: SessionRow[] = [];

  const insightsPath = join(
    exportDir,
    "Kindle.ReadingInsights/datasets/Kindle.reading-insights-sessions_with_adjustments/Kindle.reading-insights-sessions_with_adjustments.csv"
  );

  if (existsSync(insightsPath)) {
    const rows = parse(await readFile(insightsPath, "utf-8"), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      skip_records_with_error: true,
    }) as Array<{
      ASIN: string;
      start_time: string;
      end_time: string;
      total_reading_milliseconds?: string;
      product_name?: string;
    }>;

    for (const row of rows) {
      if (!row.ASIN || !row.start_time) continue;
      const start = parseDate(row.start_time);
      const end = parseDate(row.end_time);
      if (!start) continue;
      const duration = row.total_reading_milliseconds ? Number(row.total_reading_milliseconds) : null;
      sessions.push({
        asin: row.ASIN.toUpperCase(),
        start_at: start,
        end_at: end,
        duration_ms: Number.isNaN(duration) ? null : duration,
        source: "ri_adjusted",
        device_family: null,
      });
    }
  }

  const activePath = join(
    exportDir,
    "Kindle.Devices.EreaderDeviceActiveUsageTime/Kindle.Devices.EreaderDeviceActiveUsageTime.csv"
  );
  if (existsSync(activePath)) {
    const rows = parse(await readFile(activePath, "utf-8"), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      skip_records_with_error: true,
    }) as Array<{
      created_timestamp: string;
      ASIN: string;
      device_active_time_in_ms?: string;
      device_family?: string;
    }>;

    for (const row of rows) {
      if (!row.ASIN || !row.created_timestamp) continue;
      const start = parseDate(row.created_timestamp);
      if (!start) continue;
      const duration = row.device_active_time_in_ms ? Number(row.device_active_time_in_ms) : null;
      sessions.push({
        asin: row.ASIN.toUpperCase(),
        start_at: start,
        end_at: null,
        duration_ms: Number.isNaN(duration) ? null : duration,
        source: "ereader_active",
        device_family: row.device_family ?? "Kindle E-reader",
      });
    }
  }

  const legacyPath = join(exportDir, "Kindle.Devices.ReadingSession/Kindle.Devices.ReadingSession.csv");
  if (existsSync(legacyPath)) {
    const rows = parse(await readFile(legacyPath, "utf-8"), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      skip_records_with_error: true,
    }) as Array<{
      start_timestamp: string;
      end_timestamp: string;
      ASIN: string;
      content_type?: string;
      total_reading_millis?: string;
      device_family?: string;
    }>;

    for (const row of rows) {
      if (!row.ASIN || row.ASIN === "Not Available") continue;
      if (row.content_type && row.content_type !== "E-Book") continue;
      const start = parseDate(row.start_timestamp);
      if (!start) continue;
      const end = parseDate(row.end_timestamp);
      const duration = row.total_reading_millis ? Number(row.total_reading_millis) : null;
      sessions.push({
        asin: row.ASIN.toUpperCase(),
        start_at: start,
        end_at: end,
        duration_ms: Number.isNaN(duration) ? null : duration,
        source: "legacy_session",
        device_family: row.device_family ?? null,
      });
    }
  }

  for (const batch of chunkArray(sessions, INSERT_BATCH_SIZE)) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    batch.forEach((row, idx) => {
      const offset = idx * 7;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
      );
      values.push(
        userId,
        row.asin,
        row.start_at,
        row.end_at ?? null,
        row.duration_ms ?? null,
        row.source,
        row.device_family ?? null
      );
    });

    await transaction(async (client) => {
      await client.query(
        `
        INSERT INTO "UserReadingSession"
          (user_id, asin, start_at, end_at, duration_ms, source, device_family)
        VALUES ${placeholders.join(",")}
        ON CONFLICT (user_id, asin, start_at, source) DO NOTHING
        `,
        values
      );
    });
  }

  return { sessions: sessions.length };
}

async function ingestDayUnits(
  exportDir: string,
  userId: string
): Promise<{ days: number }> {
  const dayUnitsPath = join(
    exportDir,
    "Kindle.ReadingInsights/datasets/Kindle.ReadingInsightsDayUnits/Kindle.ReadingInsightsDayUnits.csv"
  );
  if (!existsSync(dayUnitsPath)) return { days: 0 };

  const rows = parse(await readFile(dayUnitsPath, "utf-8"), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<{ reading_tracked_on_day: string }>;

  const days = rows
    .map((r) => parseDate(r.reading_tracked_on_day))
    .filter((d): d is Date => Boolean(d));

  for (const batch of chunkArray(days, INSERT_BATCH_SIZE)) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    batch.forEach((day, idx) => {
      const offset = idx * 2;
      placeholders.push(`($${offset + 1}, $${offset + 2})`);
      values.push(userId, day);
    });

    await transaction(async (client) => {
      await client.query(
        `
        INSERT INTO "UserReadingDay" (user_id, day, source)
        SELECT v.user_id, v.day::date, 'ri_day_units'
        FROM (VALUES ${placeholders.join(",")}) AS v(user_id, day)
        ON CONFLICT (user_id, day, source) DO NOTHING
        `,
        values
      );
    });
  }

  return { days: days.length };
}

// Optional legacy clippings (kept for compatibility)
async function ingestClippings(
  exportDir: string,
  userId: string
): Promise<{ events: number; resolved: number }> {
  const files = await readdir(exportDir);
  const clippingsFile = files.find(
    (f) =>
      f.toLowerCase().includes("clipping") || f.toLowerCase() === "my clippings.txt"
  );

  if (!clippingsFile) return { events: 0, resolved: 0 };

  const filePath = join(exportDir, clippingsFile);
  const content = await readFile(filePath, "utf-8");
  const entries = content.split("==========");

  const unique = new Map<string, { title: string; author: string; date?: Date | null }>();
  for (const entry of entries) {
    const lines = entry.trim().split("\n").filter(Boolean);
    if (lines.length < 2) continue;
    const titleMatch = lines[0].match(/^(.+?)\s*\(([^)]+)\)$/);
    if (!titleMatch) continue;
    const [, title, author] = titleMatch;
    const metaLine = lines[1];
    const dateMatch = metaLine.match(/Added on\s+(.+)$/i);
    const key = `${title}|${author}`.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, { title, author, date: parseDate(dateMatch?.[1] ?? null) });
    }
  }

  const events: Array<{ workId: number; shelf: string; finishedAt: Date | null; notes?: string }> = [];
  let resolved = 0;
  for (const clip of unique.values()) {
    try {
      const result = await resolveWork({ title: clip.title, author: clip.author });
      if (!result.workId) continue;
      resolved++;
      events.push({
        workId: result.workId,
        shelf: "read",
        finishedAt: clip.date ?? null,
        notes: "From clippings",
      });
    } catch (error) {
      logger.warn("Failed to resolve clipping", { title: clip.title, error: String(error) });
    }
  }

  await upsertUserEvents(userId, events);
  return { events: events.length, resolved };
}

async function getLatestMtime(dir: string): Promise<Date | null> {
  let latest: Date | null = null;
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = await getLatestMtime(fullPath);
      if (child && (!latest || child > latest)) latest = child;
    } else if (entry.isFile()) {
      const s = await stat(fullPath);
      const m = s.mtime;
      if (!latest || m > latest) latest = m;
    }
  }

  return latest;
}

async function getLatestKindleTimestamp(userId: string): Promise<Date | null> {
  const { rows } = await query<{ latest: Date | null }>(
    `
    SELECT GREATEST(
      (SELECT MAX(created_at) FROM "KindleOwnership" WHERE user_id = $1),
      (SELECT MAX(created_at) FROM "UserCompletionEvent" WHERE user_id = $1),
      (SELECT MAX(created_at) FROM "UserReadingSession" WHERE user_id = $1),
      (SELECT MAX(created_at) FROM "UserReadingDay" WHERE user_id = $1)
    ) AS latest
    `,
    [userId]
  );
  return rows[0]?.latest ?? null;
}

/**
 * Import Kindle export directory
 */
export async function importKindle(options: ImportOptions): Promise<ImportStats> {
  const {
    exportDir,
    userId,
    importClippings = true,
    ownership = true,
    completions = true,
    sessions = true,
    dayUnits = true,
    force = false,
  } = options;

  logger.info("Starting Kindle import", { exportDir, userId });
  const timer = createTimer("Kindle import");

  const stats: ImportStats = {
    ownershipRows: 0,
    ownershipEvents: 0,
    completionEvents: 0,
    completionUpserts: 0,
    sessions: 0,
    dayUnits: 0,
    clippings: 0,
    resolved: 0,
    errors: 0,
    skipped: false,
  };

  try {
    if (!force) {
      const latestFileMtime = await getLatestMtime(exportDir);
      const dbLatest = await getLatestKindleTimestamp(userId);

      if (latestFileMtime && dbLatest && dbLatest >= latestFileMtime) {
        logger.info("Kindle import skipped (export not newer than DB)", {
          latestFileMtime,
          dbLatest,
        });
        stats.skipped = true;
        return stats;
      }
    }

    if (ownership) {
      const result = await ingestOwnership(exportDir, userId);
      stats.ownershipRows = result.rows;
      stats.ownershipEvents = result.events;
      stats.resolved += result.resolved;
      logger.info("Ownership ingested", result);
    }

    if (completions) {
      const result = await ingestCompletions(exportDir, userId);
      stats.completionEvents = result.events;
      stats.completionUpserts = result.upserts;
      stats.resolved += result.resolved;
      logger.info("Completions ingested", result);
    }

    if (sessions) {
      const result = await ingestSessions(exportDir, userId);
      stats.sessions = result.sessions;
      logger.info("Sessions ingested", result);
    }

    if (dayUnits) {
      const result = await ingestDayUnits(exportDir, userId);
      stats.dayUnits = result.days;
      logger.info("Day units ingested", result);
    }

    if (importClippings) {
      const result = await ingestClippings(exportDir, userId);
      stats.clippings = result.events;
      stats.resolved += result.resolved;
      logger.info("Clippings ingested", result);
    }
  } catch (error) {
    stats.errors += 1;
    logger.error("Kindle import failed", { error: String(error) });
    throw error;
  } finally {
    timer.end(stats);
  }

  return stats;
}
