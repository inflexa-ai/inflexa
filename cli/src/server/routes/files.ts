import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";

import type { Context } from "hono";
import { getMimeType, mimes } from "hono/utils/mime";
import { err, ok, ResultAsync, type Result } from "neverthrow";

import { errnoCode } from "../../lib/fs.ts";
import { getLogger } from "../../lib/log.ts";
import { classifyRealPath, type ReadRoots } from "../../modules/analysis/boundary.ts";
import { apiError, type ServerEnv } from "../http.ts";

/** The disk reads of {@link serveFile}. A test replaces one to make a read fail or to count the closes. */
export type FileRouteOpts = {
    /** Opens the real path that passed the test. The route gives the flags that refuse a final symbolic link and never wait on a FIFO. */
    readonly open: (path: string, flags: number) => Promise<FileHandle>;
    /** The largest count of bytes that one read of the body takes, thus the bound on the memory of one request. */
    readonly chunkBytes: number;
};

/** The production {@link FileRouteOpts}. */
export const DEFAULT_FILE_ROUTE_OPTS: FileRouteOpts = { open, chunkBytes: 64 * 1024 };

// `?? 0`: a platform that has no such flag (Windows) opens the file without it.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The types that a browser runs as a document with script. They get `Content-Security-Policy: sandbox`. */
const SANDBOXED_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml", "image/svg+xml", "application/xml", "text/xml"]);

/**
 * The hono types plus the protein structure formats, which hono does not know. A text format gets a `text/` type,
 * thus a client reads it as text under `nosniff`. The structure entries come last, thus they win over a later hono entry.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
    ...mimes,
    pdb: "text/x-pdb; charset=utf-8",
    ent: "text/x-pdb; charset=utf-8",
    cif: "text/x-mmcif; charset=utf-8",
    mmcif: "text/x-mmcif; charset=utf-8",
    bcif: "application/x-bcif",
};

/** The `Content-Type` that the read route gives for a file name: from its extension, or `application/octet-stream` for an extension that the server does not know. */
export function contentTypeOf(name: string): string {
    return getMimeType(name, CONTENT_TYPES) ?? "application/octet-stream";
}

type ByteRange = { start: number; end: number };

/** What the `Range` header asks for: one range, nothing (absent, ignored, or a form that the route does not serve), or a range that no byte satisfies. */
type RangeRequest = ByteRange | "none" | "unsatisfiable";

const FORBIDDEN_MESSAGE = "The path is outside the folders that the server serves.";

/** What differs between the callers of {@link serveFile}. */
export type FileResponseOpts = {
    /** Send the file as a download, with a `Content-Disposition` of the requested name. */
    readonly download: boolean;
    /**
     * Headers on each response that carries a file, a 304 included. A value here replaces the default of the same
     * name, thus a caller that sets `Content-Security-Policy` replaces the type-based `sandbox`, and one that sets
     * `Cache-Control` replaces `no-cache`.
     */
    readonly headers: Readonly<Record<string, string>>;
    /** The response for a path that is not a regular file (a folder, a socket). */
    readonly notAFile: (c: Context<ServerEnv>) => Response;
};

/**
 * The response for `target`: the real-path test against `roots` (`"unlimited"` admits each existing path), the open that refuses a final symbolic link, and
 * the stat, the tag, the range, and the streamed body. `name` gives the content type and the download name. The
 * read route `GET /api/v1/fs/read` and the page route of a report session both call it, thus one implementation
 * opens and streams each served file. A test failure gives 403 `forbidden`, and an absent path inside a root gives 404
 * `not_found`.
 */
export async function serveFile(
    c: Context<ServerEnv>,
    opts: FileRouteOpts,
    roots: ReadRoots,
    target: string,
    name: string,
    response: FileResponseOpts,
): Promise<Response> {
    const opened = await openRealPath(c, opts, roots, target, response.notAFile);
    if (opened.isErr()) return opened.error;
    return serveHandle(c, opts, opened.value.handle, name, response);
}

/** An open file or folder from {@link openRealPath}. */
export type OpenedPath = {
    /** The caller owns the handle and must close it. */
    readonly handle: FileHandle;
    /** The path with each symbolic link resolved, the path that the handle opened. */
    readonly realPath: string;
};

/**
 * The real-path test of `target` against `roots` (`"unlimited"` admits each existing path), and the open of the real path with
 * the flags that refuse a final symbolic link and never wait on a FIFO. A failure is the response to send: 403
 * `forbidden` for a path outside the roots or a link that replaced the last part after the test, 404 `not_found` for an
 * absent path inside a root, `notAFile` for a socket, and 403 with the code of the operating system for each other
 * failure. A folder opens too, thus the caller tells it from a file with `stat` on the handle.
 */
export async function openRealPath(
    c: Context<ServerEnv>,
    opts: FileRouteOpts,
    roots: ReadRoots,
    target: string,
    notAFile: (c: Context<ServerEnv>) => Response,
): Promise<Result<OpenedPath, Response>> {
    const verdict = await classifyRealPath(roots, target);
    if (verdict.isErr()) return err(unreadable(c, verdict.error.cause));
    switch (verdict.value.type) {
        case "outside":
            return err(apiError(c, "forbidden", FORBIDDEN_MESSAGE));
        case "absent":
            return err(verdict.value.insideAsText ? apiError(c, "not_found", "No file at the path.") : apiError(c, "forbidden", FORBIDDEN_MESSAGE));
        case "in":
            break;
        default: {
            const exhaustive: never = verdict.value;
            throw new Error(`unhandled real-path verdict: ${JSON.stringify(exhaustive)}`);
        }
    }

    const { realPath } = verdict.value;
    const handle = await ResultAsync.fromPromise(opts.open(realPath, OPEN_FLAGS), (cause) => cause);
    if (handle.isErr()) return err(openFailure(c, handle.error, notAFile));
    return ok({ handle: handle.value, realPath });
}

/** The 403 `forbidden` response for a failure of the disk that has no named meaning, with the code of the operating system in `details.code`. */
export function unreadable(c: Context<ServerEnv>, cause: unknown): Response {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return apiError(c, "forbidden", `The server cannot read the file: ${reason}`, { code: errnoCode(cause) });
}

function openFailure(c: Context<ServerEnv>, cause: unknown, notAFile: (c: Context<ServerEnv>) => Response): Response {
    switch (errnoCode(cause)) {
        // `O_NOFOLLOW`: a symbolic link replaced the last part of the path after the test.
        case "ELOOP":
            return apiError(c, "forbidden", FORBIDDEN_MESSAGE);
        case "ENOENT":
        case "ENOTDIR":
            return apiError(c, "not_found", "No file at the path.");
        // A Unix socket does not open: `EOPNOTSUPP` on macOS, `ENXIO` on Linux. It is not a regular file, as `serveHandle` tells.
        case "EOPNOTSUPP":
        case "ENXIO":
            return notAFile(c);
        default:
            return unreadable(c, cause);
    }
}

/**
 * The response for an open file. This function owns `handle`: it closes the handle for each response that has no
 * body, and the body stream closes it for a response that has one.
 */
async function serveHandle(c: Context<ServerEnv>, opts: FileRouteOpts, handle: FileHandle, path: string, response: FileResponseOpts): Promise<Response> {
    const stats = await ResultAsync.fromPromise(handle.stat({ bigint: true }), (cause) => cause);
    if (stats.isErr()) {
        await closeHandle(handle);
        return unreadable(c, stats.error);
    }
    const facts = stats.value;
    if (!facts.isFile()) {
        await closeHandle(handle);
        return response.notAFile(c);
    }
    const size = Number(facts.size);
    // The fields come from the open handle, thus the tag, the length, and the bytes describe one file. The
    // nanosecond time keeps the window of a rewrite with the same size small.
    const etag = `"${facts.ino.toString(16)}-${facts.size.toString(16)}-${facts.mtimeNs.toString(16)}"`;

    const headers = new Headers({ ETag: etag, "Cache-Control": "no-cache" });
    if (matchesNoneMatch(c.req.header("If-None-Match"), etag)) {
        await closeHandle(handle);
        for (const [header, value] of Object.entries(response.headers)) headers.set(header, value);
        return new Response(null, { status: 304, headers });
    }

    // The requested name, not the name of the real path, gives the type and the download name.
    const name = basename(path);
    const type = contentTypeOf(name);
    headers.set("Content-Type", type);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Accept-Ranges", "bytes");
    if (SANDBOXED_TYPES.has((type.split(";", 1)[0] ?? "").trim().toLowerCase())) headers.set("Content-Security-Policy", "sandbox");
    if (response.download) headers.set("Content-Disposition", attachment(name));
    for (const [header, value] of Object.entries(response.headers)) headers.set(header, value);

    // A range applies only when the `If-Range` header is absent or names the current tag.
    const ifRange = c.req.header("If-Range");
    const range = ifRange === undefined || ifRange === etag ? parseRange(c.req.header("Range"), size) : "none";
    if (range === "unsatisfiable") {
        await closeHandle(handle);
        c.header("Content-Range", `bytes */${size}`);
        return apiError(c, "range_not_satisfiable", "No byte of the file is in the range.");
    }
    const part = range === "none" ? { start: 0, end: size - 1 } : range;
    const length = size === 0 ? 0 : part.end - part.start + 1;
    headers.set("Content-Length", String(length));
    if (range !== "none") headers.set("Content-Range", `bytes ${part.start}-${part.end}/${size}`);
    const status = range === "none" ? 200 : 206;

    // Hono drops the body of a HEAD response and does not cancel it, thus a stream would hold the descriptor.
    if (length === 0 || c.req.raw.method === "HEAD") {
        await closeHandle(handle);
        return new Response(null, { status, headers });
    }
    return new Response(fileBody(handle, part.start, length, opts.chunkBytes), { status, headers });
}

/** Close a handle, and log a failure of the close. Each failure after the response has no one to tell. */
export async function closeHandle(handle: FileHandle): Promise<void> {
    await handle.close().catch((cause: unknown) => getLogger("server").warn({ err: cause }, "could not close a served file"));
}

/**
 * A pull stream of `length` bytes of `handle` from `start`. The end of the range, a cancel, and a failed read each
 * close the handle, and it closes one time. The status is sent before the first read, thus a failed read ends the body
 * with an error, and the client sees fewer bytes than `Content-Length`.
 */
function fileBody(handle: FileHandle, start: number, length: number, chunkBytes: number): ReadableStream<Uint8Array> {
    let position = start;
    let remaining = length;
    let closed = false;
    const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await closeHandle(handle);
    };
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const buffer = new Uint8Array(Math.min(chunkBytes, remaining));
            const read = await ResultAsync.fromPromise(handle.read(buffer, 0, buffer.length, position), (cause) => cause);
            if (read.isErr() || read.value.bytesRead === 0) {
                // A zero read before the end means that the file got shorter after the tag was made.
                const cause = read.isErr() ? read.error : new Error("the file ended before the range did");
                getLogger("server").error({ err: cause }, "a file read failed after the status");
                controller.error(cause);
                await close();
                return;
            }
            controller.enqueue(buffer.subarray(0, read.value.bytesRead));
            position += read.value.bytesRead;
            remaining -= read.value.bytesRead;
            if (remaining === 0) {
                controller.close();
                await close();
            }
        },
        cancel: close,
    });
}

/** Whether an `If-None-Match` header names the tag: `*`, or a list of tags that can have a `W/` prefix. */
function matchesNoneMatch(header: string | undefined, etag: string): boolean {
    if (header === undefined) return false;
    return header.split(",").some((item) => {
        const tag = item.trim();
        return tag === "*" || tag.replace(/^W\//, "") === etag;
    });
}

/**
 * The range of a `Range` header over a file of `size` bytes. The forms are `bytes=<first>-<last>`, `bytes=<first>-`,
 * and `bytes=-<suffix>`. A `<last>` at or past the end means the end. More than one range, a different unit, and
 * a bad form are `none`, thus the route gives the full file.
 */
function parseRange(header: string | undefined, size: number): RangeRequest {
    const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
    if (match === null) return "none";
    const [, first = "", last = ""] = match;
    if (first === "") {
        if (last === "") return "none";
        const suffix = Number(last);
        return suffix === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(size - suffix, 0), end: size - 1 };
    }
    const start = Number(first);
    if (last !== "" && Number(last) < start) return "none";
    if (start >= size) return "unsatisfiable";
    return { start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) };
}

/** The `Content-Disposition` of a download: an ASCII `filename` for an old client and the exact name in `filename*`. */
function attachment(name: string): string {
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/gu, "_");
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
