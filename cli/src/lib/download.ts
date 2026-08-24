import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { err, ok, type Result } from "neverthrow";

import { sha256File } from "./hash.ts";

/** A fire-and-forget progress notification for one single-file download. */
export type DownloadProgress =
    | { readonly type: "started"; readonly declaredBytes?: number }
    | { readonly type: "bytes"; readonly bytes: number }
    | { readonly type: "completed"; readonly bytes: number };

/**
 * Why a download failed. `http_failed`/`insecure_redirect` are transport faults; `io_failed` is a local
 * fs/stream fault; `stalled` is a transfer that stopped moving bytes (see {@link LIVENESS_WINDOW_MS}).
 *
 * `stalled` is its own variant rather than one more `io_failed`, because the two want different
 * remedies: a full disk wants space, and a dead connection wants another attempt. A caller that folded
 * them together would report the wrong one to the user.
 */
export type DownloadError =
    | { readonly type: "http_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "insecure_redirect"; readonly message: string }
    | { readonly type: "io_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "stalled"; readonly message: string };

/** The injectable fetch seam — production passes nothing (global `fetch`), tests inject a stub. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What a successful download produced. The destination is the caller's own `dest` argument, so it is not repeated here. */
export type DownloadedFile = { readonly bytes: number; readonly sha256: string };

/**
 * How the INITIAL request is retried. `attempts` counts the first try, so `1` means "take the answer".
 *
 * Only the request is retried, never a body that has already begun arriving: by then bytes are on disk,
 * and restarting would need the resume this utility deliberately does not do (it carries no digest to
 * tell a truncated file from a complete one).
 */
export type DownloadRetry = {
    readonly attempts: number;
    readonly baseMs: number;
    /** Whether this status is worth another attempt — the caller's knowledge of its own upstream. */
    readonly shouldRetry: (status: number) => boolean;
};

/** Options for {@link downloadToFile}. */
export type DownloadToFileOptions = {
    readonly fetch?: FetchLike;
    readonly onProgress?: (event: DownloadProgress) => void;
    /**
     * Retry schedule for the initial request; omitted means the first answer is the settled one.
     *
     * Off by default because WHICH statuses are worth retrying is a property of the upstream, not of
     * downloading: a CDN that answers honestly has nothing to retry, while GEO sheds load with a status
     * it also uses to mean "nothing here". Only the caller knows which of the two it is talking to.
     */
    readonly retry?: DownloadRetry;
    /**
     * Window of silence that ends the transfer, in milliseconds; omitted means {@link LIVENESS_WINDOW_MS}.
     * A test passes a small value, and production passes none.
     */
    readonly livenessWindowMs?: number;
};

/**
 * The size the upstream declared, or undefined when it declared none we can trust.
 *
 * A `Content-Length` beside a content encoding counts the *encoded* entity, while the runtime inflates
 * the body before it reaches the stream this code measures, so the header describes something other than
 * what is being counted and the decoded size is not derivable from it — the only honest reading is that
 * nothing was declared. A present header can also be malformed or negative, so everything that is not a
 * positive finite integer collapses to "unknown" — the state the consumer already handles.
 */
export function declaredContentLength(response: Response): number | undefined {
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return undefined;
    const raw = response.headers.get("content-length");
    if (raw === null) return undefined;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * How long a transfer may receive no bytes before it counts as dead.
 *
 * A transfer has no honest wall-clock limit: a 2 GB artifact on a slow link is healthy work for half an
 * hour, and a ceiling generous enough to spare it would also spare a socket that died an hour ago.
 * Silence separates the two, because bytes arrive only while the upstream is really there. Two minutes
 * is long enough for a publisher that stalls under load, and short enough that a dead connection does
 * not hold the command for the rest of the day.
 */
export const LIVENESS_WINDOW_MS = 120_000;

/**
 * A liveness watch over one transfer.
 *
 * Give `signal` to the request and to the body: the watch aborts both when the window passes with no
 * report of progress. Call `alive` for each sign of progress, and the window starts again. `expired`
 * tells the caller that the watch ended the transfer, and not the upstream — the one fact an abort
 * cannot carry by itself. Call `close` on each exit, or the timer outlives the transfer.
 */
export type LivenessWatch = {
    readonly signal: AbortSignal;
    /** The window this watch holds, in milliseconds. Carried so an error message can state it. */
    readonly windowMs: number;
    readonly alive: () => void;
    readonly expired: () => boolean;
    readonly close: () => void;
};

/**
 * Make a liveness watch with a window of `windowMs`.
 *
 * The timer is unref'd, thus a stalled transfer never holds the process open by itself. The open socket
 * does that for as long as it lives, which is the correct owner of the wait.
 */
export function createLivenessWatch(windowMs: number = LIVENESS_WINDOW_MS): LivenessWatch {
    const controller = new AbortController();
    let fired = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
        timer = setTimeout(() => {
            fired = true;
            controller.abort();
        }, windowMs);
        timer.unref();
    };
    arm();
    return {
        signal: controller.signal,
        windowMs,
        // A watch that fired stays fired: the abort is already out, the transfer is already ending, and
        // a late chunk from a socket that still drains must not present a dead transfer as a live one.
        alive: () => {
            if (closed || fired) return;
            if (timer !== undefined) clearTimeout(timer);
            arm();
        },
        expired: () => fired,
        close: () => {
            closed = true;
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
        },
    };
}

/** The default schedule: ask once and believe the answer. Named so the retry loop reads the same either way. */
const SINGLE_ATTEMPT: DownloadRetry = { attempts: 1, baseMs: 0, shouldRetry: () => false };

/** Deliver a progress event, swallowing observer throws — progress is decoration and must never abort a live transfer. */
function reportProgress(onProgress: ((event: DownloadProgress) => void) | undefined, event: DownloadProgress): void {
    if (onProgress === undefined) return;
    try {
        onProgress(event);
    } catch {
        // Progress is a fire-and-forget notification channel; an observer fault is not the transfer's problem.
    }
}

/**
 * Stream an https URL to `dest`, hashing its bytes and activating atomically.
 *
 * The bytes land in a sibling `${dest}.part` first and are `rename`d onto `dest` only after the whole
 * body is written and hashed, so a reader never sees a half-written file. https is the whole integrity
 * story — nothing downstream re-checks the bytes against a reviewed digest — so a redirect that downgrades
 * off https is refused: `fetch` follows redirects, and a trusted-on-first-use downgrade would defeat the
 * transport guarantee. The utility carries no digest to distinguish a partial file from a complete one, so
 * it never resumes; a stale `.part` is discarded and the body fetched fresh. Returns the computed sha256 so
 * a caller that DOES have a pinned digest can verify against it.
 *
 * Retries only the initial request, and only on the caller's schedule ({@link DownloadToFileOptions.retry}).
 * A body that truncates mid-stream is never restarted, for the same reason it never resumes.
 *
 * Bounded by liveness, never by the clock: one {@link LivenessWatch} covers the request and the body, so
 * a transfer lives for as long as bytes keep arriving and ends as `stalled` when they stop. The watch is
 * owned here rather than inside the transfer, so it closes on every exit, including a thrown one.
 */
export async function downloadToFile(url: string, dest: string, options: DownloadToFileOptions = {}): Promise<Result<DownloadedFile, DownloadError>> {
    const watch = createLivenessWatch(options.livenessWindowMs ?? LIVENESS_WINDOW_MS);
    try {
        return await transferToFile(url, dest, options, watch);
    } finally {
        watch.close();
    }
}

/** One transfer under the liveness watch that {@link downloadToFile} owns. */
async function transferToFile(url: string, dest: string, options: DownloadToFileOptions, watch: LivenessWatch): Promise<Result<DownloadedFile, DownloadError>> {
    const doFetch = options.fetch ?? fetch;
    const stalled = (): DownloadError => ({
        type: "stalled",
        message: `No data arrived from ${url} for ${Math.round(watch.windowMs / 1000)}s.`,
    });
    const partPath = `${dest}.part`;
    // Preparing the destination and reaching the upstream are separated so each reports as what it
    // is: a full disk and an unreachable host are different problems with different remedies, and
    // folding a connect failure into `io_failed` mislabels the commonest failure a download has.
    try {
        await rm(partPath, { force: true });
        await mkdir(dirname(dest), { recursive: true });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not prepare ${dest} for download.`, cause });
    }
    const retry = options.retry ?? SINGLE_ATTEMPT;
    let response: Response | undefined;
    let lastCause: unknown;
    for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
        if (attempt > 0 && retry.baseMs > 0) await Promise.sleep(retry.baseMs * 2 ** (attempt - 1));
        // Each attempt starts the window again, so the backoff between two attempts never counts against
        // the upstream: waiting on our own schedule is not the upstream going quiet.
        watch.alive();
        let attempted: Response;
        try {
            attempted = await doFetch(url, { signal: watch.signal });
        } catch (cause) {
            // A transport fault retries on the same schedule as a shed status: in the moment, neither is
            // distinguishable from an upstream that will answer on the next try. An expired watch is the
            // exception — the upstream already had its window, so more attempts would only spend more of
            // it against a host that says nothing.
            lastCause = cause;
            response = undefined;
            if (watch.expired()) break;
            continue;
        }
        response = attempted;
        if (!retry.shouldRetry(attempted.status) || attempt === retry.attempts - 1) break;
        // A discarded response still owns its socket until the body is drained or cancelled, and an
        // abandoned one would hold the connection the imminent retry needs.
        await attempted.body?.cancel().catch(() => undefined);
    }
    if (response === undefined) return err(watch.expired() ? stalled() : { type: "http_failed", message: `Could not reach ${url}.`, cause: lastCause });

    if (!response.ok || response.body === null) {
        // A rejected response still owns its socket until the body is drained or cancelled, exactly
        // as a retried one does — an error path that skipped this would hold the connection for as
        // long as it took the runtime to collect the abandoned stream.
        await response.body?.cancel().catch(() => undefined);
        return err({ type: "http_failed", message: `Download failed: HTTP ${response.status} ${response.statusText} (${url}).` });
    }
    if (response.url !== "" && !response.url.startsWith("https://")) {
        await response.body.cancel().catch(() => undefined);
        return err({ type: "insecure_redirect", message: `Refusing ${url}: redirected to a non-https location (${response.url}).` });
    }

    const declared = declaredContentLength(response);
    reportProgress(options.onProgress, declared === undefined ? { type: "started" } : { type: "started", declaredBytes: declared });

    try {
        // A pass-through Transform rather than a `data` listener: `pipeline` owns the flow, so a listener
        // would compete with it for the stream's mode, while an inline stage keeps backpressure intact.
        const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                // The one place that knows the upstream is still there. Every other signal — a socket
                // that is open, a promise that is pending — holds just as true for a connection that
                // died mid-body, which is the failure this watch exists to end.
                watch.alive();
                reportProgress(options.onProgress, { type: "bytes", bytes: chunk.length });
                callback(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(partPath, { flags: "w" }), { signal: watch.signal });
        const written = (await stat(partPath)).size;
        const digest = await sha256File(partPath);
        if (digest.isErr()) return err({ type: "io_failed", message: `Could not hash the download of ${url}.`, cause: digest.error.cause });
        await rename(partPath, dest);
        reportProgress(options.onProgress, { type: "completed", bytes: written });
        return ok({ bytes: written, sha256: digest.value });
    } catch (cause) {
        // The abort the watch raised surfaces here as a rejected pipeline, and it is not a local write
        // fault: reporting it as one would send the user after disk space for a dead connection.
        return err(watch.expired() ? stalled() : { type: "io_failed", message: `Could not write ${dest}.`, cause });
    }
}
