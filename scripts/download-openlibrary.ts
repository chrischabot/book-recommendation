#!/usr/bin/env tsx
/**
 * Download Open Library data dumps
 *
 * Usage:
 *   pnpm download:ol                           # Download core + user activity data
 *   pnpm download:ol -- --preset full          # Download everything
 *   pnpm download:ol -- --preset minimal       # Just works + authors (smallest)
 *   pnpm download:ol -- --files works,ratings  # Specific files
 *   pnpm download:ol -- --dump-date 2025-11-06 # Use specific dump date
 *
 * Presets:
 *   minimal  - works, authors (~3.4GB compressed)
 *   core     - works, editions, authors (~12.6GB compressed)
 *   default  - core + ratings, reading-log (~12.7GB compressed)
 *   full     - all available dumps (~14GB compressed)
 *
 * Available files:
 *   Core:     works, editions, authors
 *   Activity: ratings, reading-log
 *   Extra:    redirects, covers-metadata, wikidata, lists
 *
 * Note: The "latest" dump on openlibrary.org may not contain all files.
 * If downloads fail, use --dump-date to specify a complete dump (e.g., 2025-11-06).
 */

import { parseArgs } from "util";
import { createWriteStream, existsSync } from "fs";
import { mkdir, stat } from "fs/promises";
import { join } from "path";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

const BASE_URL = "https://openlibrary.org/data";
const ARCHIVE_URL = "https://archive.org/download";

// Known complete dump - fallback when "latest" is incomplete
const FALLBACK_DUMP_DATE = "2025-11-06";

const DUMP_FILES: Record<string, { url: string; description: string; sizeHint: string; priority: number }> = {
  // Core data (priority 1 - essential)
  works: {
    url: `${BASE_URL}/ol_dump_works_latest.txt.gz`,
    description: "All works (books as abstract entities)",
    sizeHint: "~2.9GB compressed, ~15GB uncompressed",
    priority: 1,
  },
  editions: {
    url: `${BASE_URL}/ol_dump_editions_latest.txt.gz`,
    description: "All editions (physical/digital versions with ISBNs)",
    sizeHint: "~9.2GB compressed, ~60GB uncompressed",
    priority: 1,
  },
  authors: {
    url: `${BASE_URL}/ol_dump_authors_latest.txt.gz`,
    description: "All authors",
    sizeHint: "~500MB compressed, ~3GB uncompressed",
    priority: 1,
  },

  // User activity data (priority 2 - important for recommendations)
  ratings: {
    url: `${BASE_URL}/ol_dump_ratings_latest.txt.gz`,
    description: "User ratings (1-5 stars)",
    sizeHint: "~5MB compressed, ~20MB uncompressed",
    priority: 2,
  },
  "reading-log": {
    url: `${BASE_URL}/ol_dump_reading-log_latest.txt.gz`,
    description: "User reading logs (want-to-read, currently-reading, already-read)",
    sizeHint: "~65MB compressed, ~300MB uncompressed",
    priority: 2,
  },

  // Supplementary data (priority 3 - useful additions)
  redirects: {
    url: `${BASE_URL}/ol_dump_redirects_latest.txt.gz`,
    description: "Redirects for merged/moved works and editions",
    sizeHint: "~50MB compressed, ~200MB uncompressed",
    priority: 3,
  },
  "covers-metadata": {
    url: `${BASE_URL}/ol_dump_covers_metadata_latest.txt.gz`,
    description: "Cover image metadata (dimensions, archive IDs)",
    sizeHint: "~70MB compressed, ~300MB uncompressed",
    priority: 3,
  },
  wikidata: {
    url: `${BASE_URL}/ol_dump_wikidata_latest.txt.gz`,
    description: "Links to Wikidata entities for enriched metadata",
    sizeHint: "~700MB compressed, ~4GB uncompressed",
    priority: 3,
  },
  lists: {
    url: `${BASE_URL}/ol_dump_lists_latest.txt.gz`,
    description: "User-created book lists",
    sizeHint: "~30MB compressed, ~150MB uncompressed",
    priority: 3,
  },
};

const PRESETS: Record<string, string[]> = {
  minimal: ["works", "authors"],
  core: ["works", "editions", "authors"],
  default: ["works", "editions", "authors", "ratings", "reading-log"],
  full: Object.keys(DUMP_FILES),
};

// Filter out "--" that pnpm passes
const args = process.argv.slice(2).filter((arg) => arg !== "--");

const { values } = parseArgs({
  args,
  options: {
    dir: { type: "string", default: "./data/openlibrary" },
    files: { type: "string" },
    preset: { type: "string", default: "full" },
    decompress: { type: "boolean", default: true },
    force: { type: "boolean", default: false },
    "dump-date": { type: "string" },
    "no-fallback": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Build URL for a specific dump file
 */
function buildUrl(fileType: string, dumpDate?: string): string {
  if (dumpDate) {
    // Use direct Archive.org URL with specific date
    return `${ARCHIVE_URL}/ol_dump_${dumpDate}/ol_dump_${fileType}_${dumpDate}.txt.gz`;
  }
  // Use openlibrary.org "latest" link
  return `${BASE_URL}/ol_dump_${fileType}_latest.txt.gz`;
}

async function downloadFile(
  url: string,
  destPath: string,
  decompress: boolean,
  fallbackUrl?: string
): Promise<void> {
  console.log(`\nDownloading: ${url}`);
  console.log(`Destination: ${destPath}`);

  const startTime = Date.now();
  let downloadedBytes = 0;
  let lastReportTime = startTime;

  let response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404 && fallbackUrl) {
      console.log(`  Latest not found (404), trying fallback: ${fallbackUrl}`);
      response = await fetch(fallbackUrl);
      if (!response.ok) {
        throw new Error(`Failed to download from fallback: ${response.status} ${response.statusText}`);
      }
    } else {
      throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
    }
  }

  const totalBytes = parseInt(response.headers.get("content-length") ?? "0", 10);
  console.log(`Size: ${formatBytes(totalBytes)} (compressed)`);

  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();

  // Create a readable stream from the fetch response
  const readable = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        downloadedBytes += value.length;

        // Progress report every 5 seconds
        const now = Date.now();
        if (now - lastReportTime > 5000) {
          const elapsed = (now - startTime) / 1000;
          const speed = downloadedBytes / elapsed;
          const percent = totalBytes > 0 ? ((downloadedBytes / totalBytes) * 100).toFixed(1) : "?";
          const eta = totalBytes > 0 ? (totalBytes - downloadedBytes) / speed : 0;

          console.log(
            `  Progress: ${percent}% | ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)} | ` +
            `${formatBytes(speed)}/s | ETA: ${formatDuration(eta * 1000)}`
          );
          lastReportTime = now;
        }

        this.push(value);
      } catch (err) {
        this.destroy(err as Error);
      }
    },
  });

  const writeStream = createWriteStream(destPath);

  if (decompress) {
    const gunzip = createGunzip();
    await pipeline(readable, gunzip, writeStream);
  } else {
    await pipeline(readable, writeStream);
  }

  const elapsed = Date.now() - startTime;
  console.log(`  Completed in ${formatDuration(elapsed)}`);
}

async function main() {
  const dir = values.dir!;
  const decompress = values.decompress;
  const force = values.force;
  const dumpDate = values["dump-date"];
  const noFallback = values["no-fallback"];

  // Determine files to download: explicit --files overrides --preset
  let files: string[];
  let usingPreset: string | null = null;

  if (values.files) {
    files = values.files.split(",").map((f) => f.trim().toLowerCase());
  } else {
    const presetName = values.preset ?? "default";
    if (!PRESETS[presetName]) {
      console.error(`Unknown preset: ${presetName}`);
      console.error(`Available presets: ${Object.keys(PRESETS).join(", ")}`);
      process.exit(1);
    }
    files = PRESETS[presetName];
    usingPreset = presetName;
  }

  console.log("Open Library Data Dump Downloader");
  console.log("==================================");
  console.log(`Output directory: ${dir}`);
  if (usingPreset) {
    console.log(`Preset: ${usingPreset}`);
  }
  if (dumpDate) {
    console.log(`Dump date: ${dumpDate}`);
  } else {
    console.log(`Using: latest (with fallback to ${FALLBACK_DUMP_DATE})`);
  }
  console.log(`Files to download: ${files.join(", ")}`);
  console.log(`Decompress: ${decompress}`);
  console.log("");

  // Validate file names
  for (const file of files) {
    if (!DUMP_FILES[file]) {
      console.error(`Unknown file type: ${file}`);
      console.error(`Available: ${Object.keys(DUMP_FILES).join(", ")}`);
      process.exit(1);
    }
  }

  // Show what we're about to download
  console.log("Files to download:");
  for (const file of files) {
    const info = DUMP_FILES[file];
    console.log(`  - ${file}: ${info.description}`);
    console.log(`    Size: ${info.sizeHint}`);
  }
  console.log("");

  // Create output directory
  await mkdir(dir, { recursive: true });

  // Download each file
  for (const file of files) {
    const info = DUMP_FILES[file];
    const ext = decompress ? ".txt" : ".txt.gz";
    const destPath = join(dir, `ol_dump_${file}_latest${ext}`);

    if (existsSync(destPath) && !force) {
      const fileStat = await stat(destPath);
      const ageInDays = (Date.now() - fileStat.mtimeMs) / (1000 * 60 * 60 * 24);

      if (fileStat.size > 0 && ageInDays < 5) {
        console.log(`\nSkipping ${file}: ${destPath} already exists`);
        console.log(`  Size: ${formatBytes(fileStat.size)}, Age: ${ageInDays.toFixed(1)} days`);
        console.log(`  Use --force to re-download`);
        continue;
      }

      console.log(`\nRe-downloading ${file}: file is ${ageInDays >= 5 ? "stale (>5 days old)" : "empty"}`);
    }

    try {
      // Build primary URL
      const url = dumpDate ? buildUrl(file, dumpDate) : info.url;
      // Build fallback URL (only if not using explicit date and fallback not disabled)
      const fallbackUrl = !dumpDate && !noFallback ? buildUrl(file, FALLBACK_DUMP_DATE) : undefined;

      await downloadFile(url, destPath, decompress, fallbackUrl);
    } catch (error) {
      console.error(`\nFailed to download ${file}:`, error instanceof Error ? error.message : error);
      console.log(`  Continuing with remaining files...`);
    }
  }

  console.log("\n==================================");
  console.log("Download complete!");
  console.log(`\nNext steps:`);
  console.log(`  1. Run migrations: pnpm migrate`);
  console.log(`  2. Ingest data: pnpm ingest:ol -- --dir ${dir}`);
}

main().catch((error) => {
  console.error("Download failed:", error);
  process.exit(1);
});
