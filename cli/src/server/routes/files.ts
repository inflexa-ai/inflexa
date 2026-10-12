import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import { Hono, type Context } from "hono";
import { getMimeType } from "hono/utils/mime";
import { err, ok, ResultAsync, type Result } from "neverthrow";

import { errnoCode } from "../../lib/fs.ts";
import { getLogger } from "../../lib/log.ts";
import { classifyRealPath, inputReadRoots, workspaceReadRoot, type ReadRoot } from "../../modules/analysis/boundary.ts";
import { apiError, holdConnection, internalError, type ServerEnv } from "../http.ts";

/** The disk reads of the file route. A test replaces one to make a read fail or to count the closes. */
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

type ByteRange = { start: number; end: number };

/** What the `Range` header asks for: one range, nothing (absent, ignored, or a form that the route does not serve), or a range that no byte satisfies. */
type RangeRequest = ByteRange | "none" | "unsatisfiable";

const FORBIDDEN_MESSAGE = "The path is outside the files of the analysis.";

/**
 * The route `GET {A}/files?path=<path>`: the bytes of one file of an analysis. A relative path must have its real path
 * inside the workspace root, and an absolute path must have its real path inside a declared input. The body streams
 * from the open file. The route needs no harness runtime, thus it has no `requireRuntime`.
 */
export function fileRoutes(opts: FileRouteOpts = DEFAULT_FILE_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.get("/", async (c) => {
        const path = c.req.query("path");
        if (path === undefined || path === "" || path.includes("\0")) {
            return apiError(c, "validation_error", "`path` must be a path that is not empty.", {
                formErrors: [],
                fieldErrors: { path: ["A path is necessary."] },
            });
        }
        const download = c.req.query("download");
        if (download !== undefined && download !== "1") {
            return apiError(c, "validation_error", "`download` is 1 or absent.", { formErrors: [], fieldErrors: { download: ["must be 1"] } });
        }
        // The real path of a file on a hung mount can take more than 10 s.
        holdConnection(c);

        const located = await locateTarget(c, c.req.param("analysisId") ?? "", path);
        if (located.isErr()) return located.error;
        const verdict = await classifyRealPath(located.value.roots, located.value.target);
        if (verdict.isErr()) return unreadable(c, verdict.error.cause);
        switch (verdict.value.type) {
            case "outside":
                return apiError(c, "forbidden", FORBIDDEN_MESSAGE);
            case "absent":
                return verdict.value.insideAsText ? apiError(c, "not_found", "No file at the path.") : apiError(c, "forbidden", FORBIDDEN_MESSAGE);
            case "in":
                break;
            default: {
                const exhaustive: never = verdict.value;
                throw new Error(`unhandled real-path verdict: ${JSON.stringify(exhaustive)}`);
            }
        }

        const handle = await ResultAsync.fromPromise(opts.open(verdict.value.realPath, OPEN_FLAGS), (cause) => cause);
        if (handle.isErr()) return openFailure(c, handle.error);
        return serveHandle(c, opts, handle.value, path, download === "1");
    });

    return routes;
}

/**
 * The roots of the form of the path and the absolute path to test. A relative path joins the workspace root,
 * and an absolute path stays as it is. The error channel holds the response to send.
 */
async function locateTarget(c: Context<ServerEnv>, analysisId: string, path: string): Promise<Result<{ roots: ReadRoot[]; target: string }, Response>> {
    if (isAbsolute(path)) {
        const roots = await inputReadRoots(analysisId);
        if (roots.isErr()) return err(internalError(c, roots.error, "read the inputs"));
        return ok({ roots: roots.value, target: resolve(path) });
    }
    const root = await workspaceReadRoot(analysisId);
    if (root.isErr()) {
        return err(
            root.error.type === "workspace_unavailable" ? apiError(c, "conflict", root.error.message) : internalError(c, root.error, "locate the workspace"),
        );
    }
    return ok({ roots: [root.value], target: resolve(root.value.text, path) });
}

/** The 403 `forbidden` response for a failure of the disk that has no named meaning, with the code of the operating system in `details.code`. */
function unreadable(c: Context<ServerEnv>, cause: unknown): Response {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return apiError(c, "forbidden", `The server cannot read the file: ${reason}`, { code: errnoCode(cause) });
}

function openFailure(c: Context<ServerEnv>, cause: unknown): Response {
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

function notAFile(c: Context<ServerEnv>): Response {
    return apiError(c, "validation_error", "`path` must name a file.", { formErrors: [], fieldErrors: { path: ["The path is not a file."] } });
}

/**
 * The response for an open file. This function owns `handle`: it closes the handle for each response that has no
 * body, and the body stream closes it for a response that has one.
 */
async function serveHandle(c: Context<ServerEnv>, opts: FileRouteOpts, handle: FileHandle, path: string, download: boolean): Promise<Response> {
    const stats = await ResultAsync.fromPromise(handle.stat({ bigint: true }), (cause) => cause);
    if (stats.isErr()) {
        await closeHandle(handle);
        return unreadable(c, stats.error);
    }
    const facts = stats.value;
    if (!facts.isFile()) {
        await closeHandle(handle);
        return notAFile(c);
    }
    const size = Number(facts.size);
    // The fields come from the open handle, thus the tag, the length, and the bytes describe one file. The
    // nanosecond time keeps the window of a rewrite with the same size small.
    const etag = `"${facts.ino.toString(16)}-${facts.size.toString(16)}-${facts.mtimeNs.toString(16)}"`;

    const headers = new Headers({ ETag: etag, "Cache-Control": "no-cache" });
    if (matchesNoneMatch(c.req.header("If-None-Match"), etag)) {
        await closeHandle(handle);
        return new Response(null, { status: 304, headers });
    }

    // The requested name, not the name of the real path, gives the type and the download name.
    const name = basename(path);
    const type = getMimeType(name) ?? "application/octet-stream";
    headers.set("Content-Type", type);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Accept-Ranges", "bytes");
    if (SANDBOXED_TYPES.has((type.split(";", 1)[0] ?? "").trim().toLowerCase())) headers.set("Content-Security-Policy", "sandbox");
    if (download) headers.set("Content-Disposition", attachment(name));

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
async function closeHandle(handle: FileHandle): Promise<void> {
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
