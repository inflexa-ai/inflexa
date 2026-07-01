/**
 * Streaming HTTP download helper with optional ranged-GET parallelism.
 *
 * Per-stream working memory is bounded at ~64 KiB regardless of file size —
 * bodies are never materialized as Buffers. When the caller supplies the
 * total size and it exceeds `partSize`, the download is split into N ranged
 * GETs that write into a pre-allocated file at their respective offsets.
 */

import { createWriteStream } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mapConcurrent, sleep } from "./async-utils.js";

export interface StreamDownloadOpts {
    /** Total file size. Required for ranged-parallel downloads. */
    size?: number;
    /** Bytes per range. Falls back to single-GET when size <= partSize. */
    partSize?: number;
    /** Max ranges in flight. */
    concurrency?: number;
    /** Max retries per range or per whole-file stream. */
    maxRetries?: number;
    /** Abort signal for cancellation. */
    signal?: AbortSignal;
}

const DEFAULT_PART_SIZE = 32 * 1024 * 1024; // 32 MiB
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

/**
 * Download a URL to `destPath`, streaming the body to disk.
 *
 * Creates the destination file (truncating any existing content). On success
 * the file exists at `destPath`; on failure it may be partially written —
 * callers should use a temp path + rename pattern if atomicity matters.
 */
export async function streamDownload(url: string, destPath: string, opts: StreamDownloadOpts = {}): Promise<void> {
    const size = opts.size;
    const partSize = opts.partSize ?? DEFAULT_PART_SIZE;
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

    if (!size || size <= partSize) {
        await fetchStreamToFile(url, destPath, "w", undefined, maxRetries, opts.signal);
        return;
    }

    // Pre-allocate the file so per-range streams can write at correct offsets.
    const fh = await fsOpen(destPath, "w");
    try {
        await fh.truncate(size);
    } finally {
        await fh.close();
    }

    const totalParts = Math.ceil(size / partSize);
    await mapConcurrent(
        Array.from({ length: totalParts }, (_, i) => i),
        concurrency,
        async (i) => {
            const start = i * partSize;
            const end = Math.min(start + partSize, size) - 1;
            await fetchRangeToFile(url, destPath, start, end, maxRetries, opts.signal);
        },
    );
}

async function fetchStreamToFile(
    url: string,
    destPath: string,
    flags: "w" | "r+",
    start: number | undefined,
    maxRetries: number,
    signal?: AbortSignal,
): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const res = await fetch(url, { signal });
            if (!res.ok) {
                lastError = `HTTP ${res.status}`;
                if (res.status >= 500 && attempt < maxRetries - 1) {
                    await sleep(BASE_DELAY_MS * 2 ** attempt);
                    continue;
                }
                throw new Error(lastError);
            }
            if (!res.body) throw new Error("response body is null");
            const writer = createWriteStream(destPath, start !== undefined ? { flags, start } : { flags });
            await pipeline(Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream), writer);
            return;
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (attempt < maxRetries - 1) {
                await sleep(BASE_DELAY_MS * 2 ** attempt);
                continue;
            }
        }
    }
    throw new Error(`download failed after ${maxRetries} attempts: ${lastError}`);
}

async function fetchRangeToFile(url: string, destPath: string, start: number, end: number, maxRetries: number, signal?: AbortSignal): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { Range: `bytes=${start}-${end}` },
                signal,
            });
            // 206 is the expected success; 200 means the server ignored Range — treat
            // as fatal since it would overwrite other ranges.
            if (res.status !== 206) {
                lastError = `HTTP ${res.status}`;
                if (res.status >= 500 && attempt < maxRetries - 1) {
                    await sleep(BASE_DELAY_MS * 2 ** attempt);
                    continue;
                }
                throw new Error(res.status === 200 ? `server ignored Range header (HTTP 200) — parallel download would clobber` : lastError);
            }
            if (!res.body) throw new Error("response body is null");
            const writer = createWriteStream(destPath, { flags: "r+", start });
            await pipeline(Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream), writer);
            return;
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (attempt < maxRetries - 1) {
                await sleep(BASE_DELAY_MS * 2 ** attempt);
                continue;
            }
        }
    }
    throw new Error(`range ${start}-${end} failed after ${maxRetries} attempts: ${lastError}`);
}
