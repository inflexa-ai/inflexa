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

/** Why a download failed. `http_failed`/`insecure_redirect` are transport faults; `io_failed` is a local fs/stream fault. */
export type DownloadError =
    | { readonly type: "http_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "insecure_redirect"; readonly message: string }
    | { readonly type: "io_failed"; readonly message: string; readonly cause?: unknown };

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
 */
export async function downloadToFile(url: string, dest: string, options: DownloadToFileOptions = {}): Promise<Result<DownloadedFile, DownloadError>> {
    const doFetch = options.fetch ?? fetch;
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
        let attempted: Response;
        try {
            attempted = await doFetch(url, {});
        } catch (cause) {
            // A transport fault retries on the same schedule as a shed status: in the moment, neither is
            // distinguishable from an upstream that will answer on the next try.
            lastCause = cause;
            response = undefined;
            continue;
        }
        response = attempted;
        if (!retry.shouldRetry(attempted.status) || attempt === retry.attempts - 1) break;
        // A discarded response still owns its socket until the body is drained or cancelled, and an
        // abandoned one would hold the connection the imminent retry needs.
        await attempted.body?.cancel().catch(() => undefined);
    }
    if (response === undefined) return err({ type: "http_failed", message: `Could not reach ${url}.`, cause: lastCause });

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
                reportProgress(options.onProgress, { type: "bytes", bytes: chunk.length });
                callback(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(partPath, { flags: "w" }));
        const written = (await stat(partPath)).size;
        const digest = await sha256File(partPath);
        if (digest.isErr()) return err({ type: "io_failed", message: `Could not hash the download of ${url}.`, cause: digest.error.cause });
        await rename(partPath, dest);
        reportProgress(options.onProgress, { type: "completed", bytes: written });
        return ok({ bytes: written, sha256: digest.value });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not write ${dest}.`, cause });
    }
}
