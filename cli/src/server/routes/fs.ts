import { queryArtifactOrigins, type ArtifactOrigin, type DbError, type Pool } from "@inflexa-ai/harness";
import type { BigIntStats } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { Hono, type Context } from "hono";
import { err, ok, Result, ResultAsync } from "neverthrow";
import PQueue from "p-queue";

import {
    FILE_KINDS,
    type CardPreview,
    type FileKind,
    type FileOrigin,
    type FilePreview,
    type FolderEntryView,
    type FolderFacts,
    type FolderList,
    type FolderPreview,
    type HomeFolder,
    type TablePreview,
    type TextPreview,
} from "../../api/fs.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { compareEntries, countFolderEntries, entryDetails, readFolder, scanFolder, type FolderEntry, type FolderReadError } from "../../lib/folder_listing.ts";
import { errnoCode, isReadableBy, processIdentity, statResultAsync, type ProcessIdentity } from "../../lib/fs.ts";
import { getLogger } from "../../lib/log.ts";
import { canonicalPathAsync } from "../../lib/paths.ts";
import { contains, locateWorkspaceReadRoot } from "../../modules/analysis/boundary.ts";
import { inputAbsolutePaths } from "../../modules/analysis/input.ts";
import { extensionOf, fileKindOf } from "../../modules/fs/file_kind.ts";
import { analysisQueryGuard, DEFAULT_ANALYSIS_GUARD_OPTS, type AnalysisGuardOpts } from "../analysis_guard.ts";
import type { ServerBoot } from "../boot.ts";
import { apiError, filterValue, holdConnection, internalError, listEnvelope, parsePage, type ServerEnv } from "../http.ts";
import { closeHandle, DEFAULT_FILE_ROUTE_OPTS, openRealPath, serveFile, unreadable, type FileResponseOpts, type FileRouteOpts } from "./files.ts";

/** The reads and the lock of the file system routes. A test replaces one to count the calls or to make a read fail. */
export type FsRouteOpts = FileRouteOpts &
    AnalysisGuardOpts & {
        readonly entryDetails: typeof entryDetails;
        /** The harness read of the step that wrote each path of a list. A test replaces it, because the real read needs Postgres. */
        readonly artifactOrigins: (pool: Pool, analysisId: string, paths: readonly string[]) => ResultAsync<ArtifactOrigin[], DbError>;
        /** The most bytes that the preview reads from the start of a file. A test sets a small value to cut the head of a small file. */
        readonly previewBytes: number;
        /** The home folder of the server user. A test gives a path behind a link without a change to the `HOME` of the shared process. */
        readonly homedir: () => string;
    };

/** The production {@link FsRouteOpts}. */
export const DEFAULT_FS_ROUTE_OPTS: FsRouteOpts = {
    ...DEFAULT_FILE_ROUTE_OPTS,
    ...DEFAULT_ANALYSIS_GUARD_OPTS,
    entryDetails,
    artifactOrigins: queryArtifactOrigins,
    previewBytes: 64 * 1024,
    homedir,
};

/** How many entries of one page read their facts at one time. A slow mount holds one slot and not the page. */
const ENTRY_READ_WIDTH = 16;

/** The facts of one request that do not depend on the entry. */
type ListContext = {
    readonly identity: ProcessIdentity | null;
    /** The `hidden` value of the request. It sets the hidden rule of `itemCount`. */
    readonly hidden: boolean;
    /** The canonical absolute path of each declared input file that could be located. */
    readonly inputFiles: ReadonlySet<string>;
    /** The canonical absolute path of each declared input folder that could be located. */
    readonly inputFolders: ReadonlySet<string>;
};

/** True when the path is a declared input, or inside a declared input folder. A declared input file marks only its own path. */
function isInputPath(path: string, list: ListContext): boolean {
    if (list.inputFiles.has(path) || list.inputFolders.has(path)) return true;
    if (list.inputFolders.size === 0) return false;
    let current = path;
    let parent = dirname(current);
    while (parent !== current) {
        if (list.inputFolders.has(parent)) return true;
        current = parent;
        parent = dirname(current);
    }
    return false;
}

async function entryView(entry: FolderEntry, list: ListContext, opts: FsRouteOpts): Promise<Omit<FolderEntryView, "origin">> {
    const details = await opts.entryDetails(entry, list.identity);
    const isFolder = entry.kind === "folder" || details.link?.targetKind === "folder";
    const itemCount = isFolder
        ? await countFolderEntries(entry.path, list.hidden).match(
              (count) => count,
              () => null,
          )
        : null;
    return {
        name: entry.name,
        path: entry.path,
        type: entry.kind,
        kind: isFolder ? null : fileKindOf(entry.name),
        link: details.link,
        size: details.size,
        modifiedAt: details.modifiedMs === null ? null : new Date(details.modifiedMs).toISOString(),
        mode: details.mode,
        readable: details.readable,
        writable: details.writable,
        hidden: entry.hidden,
        itemCount,
        isInput: isInputPath(entry.path, list),
    };
}

/**
 * The step that wrote each entry of the page, from one ledger read for the page. The ledger keys a path relative to the
 * workspace root, thus an entry outside the root, or equal to it, has no origin and no key in the read. The map is keyed by
 * the absolute entry path. A failed read gives an empty map, because a list with no origin is better than no list.
 */
async function readOrigins(
    entries: readonly FolderEntry[],
    root: string,
    pool: Pool,
    analysisId: string,
    opts: FsRouteOpts,
): Promise<ReadonlyMap<string, FileOrigin>> {
    const relativeOf = new Map<string, string>();
    for (const entry of entries) {
        if (entry.path !== root && contains(root, entry.path)) relativeOf.set(relative(root, entry.path).split(sep).join("/"), entry.path);
    }
    if (relativeOf.size === 0) return new Map();
    return opts.artifactOrigins(pool, analysisId, [...relativeOf.keys()]).match(
        (rows) => {
            const origins = new Map<string, FileOrigin>();
            for (const row of rows) {
                const path = relativeOf.get(row.path);
                // An `input` row has no run and no step, thus it is no origin.
                if (path !== undefined && row.runId !== null && row.stepId !== null) origins.set(path, { runId: row.runId, stepId: row.stepId });
            }
            return origins;
        },
        (cause) => {
            getLogger("server").warn({ err: cause }, "could not read the origins of the files for the list of a folder");
            return new Map<string, FileOrigin>();
        },
    );
}

/** The response of `GET /read` for a file: no extra header, and the download flag is set per request. */
const READ_ROUTE_RESPONSE: FileResponseOpts = { download: false, headers: {}, notAFile };

function notAFile(c: Context<ServerEnv>): Response {
    return apiError(c, "validation_error", "`path` must name a file.", { formErrors: [], fieldErrors: { path: ["The path is not a file."] } });
}

/**
 * The `path` query value as an absolute path with each `.` and `..` segment removed as text. The error channel holds
 * the 400 response to send. Each route of this file reads its path here, thus the rule has one home.
 */
function absolutePathOf(c: Context<ServerEnv>): Result<string, Response> {
    const path = c.req.query("path");
    // `node:fs` refuses a NUL byte with `ERR_INVALID_ARG_VALUE`, a fault of the request and not a read failure.
    if (path === undefined || !isAbsolute(path) || path.includes("\0")) {
        return err(
            apiError(c, "validation_error", "`path` must be an absolute path.", {
                formErrors: [],
                fieldErrors: { path: ["The path must be absolute."] },
            }),
        );
    }
    // `resolve` removes each `..` segment as text, before `realpath` sees the path.
    return ok(resolve(path));
}

/** How many entries of a folder the folder preview names. */
const FOLDER_PREVIEW_NAMES = 10;

/** The ids of the highlighter language for the extensions that the server maps. Each other extension is `text`. */
const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
    ["py", "python"],
    ["r", "r"],
    ["sh", "bash"],
    ["toml", "toml"],
    ["json", "json"],
    ["ipynb", "json"],
    ["md", "markdown"],
    ["yaml", "yaml"],
    ["yml", "yaml"],
    ["csv", "csv"],
    ["tsv", "tsv"],
    ["log", "log"],
]);

// A fatal decoder throws a `TypeError` on a byte sequence that is not UTF-8. Stream mode holds back an incomplete
// character at the end, which a cut head always risks.
const decodeUtf8 = Result.fromThrowable(
    (bytes: Uint8Array, stream: boolean): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream }),
    (cause) => cause,
);

function notAFileOrFolder(c: Context<ServerEnv>): Response {
    return apiError(c, "validation_error", "`path` must name a file or a folder.", {
        formErrors: [],
        fieldErrors: { path: ["The path is not a file or a folder."] },
    });
}

function folderChanged(c: Context<ServerEnv>): Response {
    return apiError(c, "forbidden", "The path is not the folder that the server opened.");
}

/** The count of the fields of a header line. A separator inside double quotes does not split a field. */
function countFields(header: string, separator: string): number {
    let fields = 1;
    let quoted = false;
    for (const ch of header) {
        if (ch === '"') quoted = !quoted;
        else if (ch === separator && !quoted) fields += 1;
    }
    return fields;
}

/** The index of the first line end in `text` from `start` that is outside double quotes, or -1 when there is none. */
function recordEnd(text: string, start: number): number {
    let quoted = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '"') quoted = !quoted;
        else if (!quoted && (ch === "\n" || ch === "\r")) return i;
    }
    return -1;
}

/** The count of the records in `text` from `start`. A line end inside double quotes does not end a record, and an empty last line is no record. */
function countRecords(text: string, start: number): number {
    let records = 0;
    let quoted = false;
    let inRecord = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '"') {
            quoted = !quoted;
            inRecord = true;
        } else if (!quoted && (ch === "\n" || ch === "\r")) {
            if (ch === "\r" && text[i + 1] === "\n") i += 1;
            records += 1;
            inRecord = false;
        } else {
            inRecord = true;
        }
    }
    return inRecord ? records + 1 : records;
}

/**
 * The member for the head of a file that is not a figure. `cut` is true when the file is longer than the head. A NUL byte,
 * or a byte sequence that is not UTF-8, gives `card`. A table needs a full line in the head and a separator in the header.
 */
function previewHead(name: string, head: Uint8Array, cut: boolean): TablePreview | TextPreview | CardPreview {
    const format = extensionOf(name);
    if (head.includes(0)) return { kind: "card", format };
    const decoded = decodeUtf8(head, cut);
    if (decoded.isErr()) return { kind: "card", format };

    let text = decoded.value;
    // The end of a cut head is a line that the cut may have split, thus the text stops at the last line end. A head with no line end keeps its text.
    const lastLineEnd = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
    if (cut && lastLineEnd >= 0) text = text.slice(0, lastLineEnd + 1);

    const headerEnd = recordEnd(text, 0);
    const holdsFullLine = !cut || headerEnd >= 0;
    if (holdsFullLine && fileKindOf(name) === "table") {
        const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
        const separator = header.includes("\t") ? "\t" : header.includes(",") ? "," : null;
        if (separator !== null) {
            const bodyStart = headerEnd < 0 ? text.length : text.startsWith("\r\n", headerEnd) ? headerEnd + 2 : headerEnd + 1;
            return {
                kind: "table",
                text,
                separator,
                columnCount: countFields(header, separator),
                rowCount: cut ? null : countRecords(text, bodyStart),
            };
        }
    }
    return { kind: "text", language: LANGUAGE_BY_EXTENSION.get(format ?? "") ?? "text", code: text };
}

/** Insert `entry` in `names`, which is in the order of the folder list, and keep the first {@link FOLDER_PREVIEW_NAMES}. */
function keepFirstNames(names: FolderEntry[], entry: FolderEntry): void {
    const at = names.findIndex((kept) => compareEntries(kept, entry) > 0);
    if (at < 0) {
        if (names.length < FOLDER_PREVIEW_NAMES) names.push(entry);
        return;
    }
    names.splice(at, 0, entry);
    if (names.length > FOLDER_PREVIEW_NAMES) names.pop();
}

/**
 * The folder member from one streamed read of the real path. The read is by path, because Node has no folder read through an open
 * handle. The `lstat` after the read makes sure that the path is still the folder that the handle opened.
 */
async function previewFolder(c: Context<ServerEnv>, realPath: string, opened: BigIntStats): Promise<Response> {
    const counts = new Map<FileKind | "folder", number>();
    const first: FolderEntry[] = [];
    const scanned = await scanFolder(realPath, false, (entry) => {
        const kind = entry.kind === "folder" ? "folder" : fileKindOf(entry.name);
        if (kind !== null) counts.set(kind, (counts.get(kind) ?? 0) + 1);
        keepFirstNames(first, entry);
    });
    // The handle opened a folder, thus a path that is not a folder now is a different entry.
    if (scanned.isErr()) return scanned.error.type === "not_folder" ? folderChanged(c) : readErrorResponse(c, scanned.error);

    const after = await ResultAsync.fromPromise(lstat(realPath, { bigint: true }), (cause) => cause);
    if (after.isErr()) return unreadable(c, after.error);
    if (!after.value.isDirectory() || after.value.dev !== opened.dev || after.value.ino !== opened.ino) return folderChanged(c);

    const kinds: FolderPreview["kinds"] = [];
    for (const kind of ["folder", ...FILE_KINDS] as const) {
        const count = counts.get(kind) ?? 0;
        if (count > 0) kinds.push({ kind, count });
    }
    const body: FolderPreview = {
        kind: "folder",
        items: scanned.value,
        kinds,
        names: first.map((entry) => ({ name: entry.name, dir: entry.kind === "folder", kind: entry.kind === "folder" ? null : fileKindOf(entry.name) })),
    };
    return c.json(body satisfies FilePreview);
}

/**
 * Read up to `limit + 1` bytes from the start of the file, in a loop that ends at the end of the file. A count above
 * `limit` means that the file is longer than the head, and the extra byte is dropped.
 */
function readHead(handle: FileHandle, limit: number): ResultAsync<{ head: Uint8Array; cut: boolean }, unknown> {
    return ResultAsync.fromPromise(
        (async () => {
            const buffer = Buffer.alloc(limit + 1);
            let filled = 0;
            while (filled < buffer.length) {
                const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
                if (bytesRead === 0) break;
                filled += bytesRead;
            }
            return { head: buffer.subarray(0, Math.min(filled, limit)), cut: filled > limit };
        })(),
        (cause) => cause,
    );
}

/** The response for an open path. The caller owns the handle and closes it after this function. */
async function previewOpened(c: Context<ServerEnv>, opts: FsRouteOpts, handle: FileHandle, realPath: string): Promise<Response> {
    const stats = await ResultAsync.fromPromise(handle.stat({ bigint: true }), (cause) => cause);
    if (stats.isErr()) return unreadable(c, stats.error);
    if (stats.value.isDirectory()) return previewFolder(c, realPath, stats.value);
    if (!stats.value.isFile()) return notAFileOrFolder(c);

    // The name of the real path gives the kind, because the preview describes the file that it read.
    const name = basename(realPath);
    if (fileKindOf(name) === "figure") {
        const body: FilePreview = { kind: "figure", src: `/api/v1/fs/read?path=${encodeURIComponent(realPath)}`, alt: name };
        return c.json(body);
    }
    const read = await readHead(handle, opts.previewBytes);
    if (read.isErr()) return unreadable(c, read.error);
    return c.json(previewHead(name, read.value.head, read.value.cut) satisfies FilePreview);
}

function readErrorResponse(c: Parameters<typeof apiError>[0], error: FolderReadError): Response {
    switch (error.type) {
        case "absent":
            return apiError(c, "not_found", `No folder at ${error.path}.`);
        case "not_folder":
            return apiError(c, "validation_error", "`path` must name a folder.", { formErrors: [], fieldErrors: { path: ["The path is not a folder."] } });
        case "unreadable": {
            const reason = error.cause instanceof Error ? error.cause.message : String(error.cause);
            return apiError(c, "forbidden", `The server cannot read the folder ${error.path}: ${reason}`, { code: errnoCode(error.cause) });
        }
        default: {
            const unhandled: never = error.type;
            throw new Error(`unhandled folder read error: ${String(unhandled)}`);
        }
    }
}

/**
 * The file system routes under `/api/v1/fs`: the home folder, the entries of one folder, the bytes of one file, and the preview
 * of one file or folder.
 * They read each path of the machine with no root limit. The list reads the harness runtime for the `origin` of its
 * entries only, and only when the boot is ready. Before that each `origin` is `null` and each route still answers.
 */
export function fsRoutes(boot: ServerBoot, opts: FsRouteOpts = DEFAULT_FS_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    // A process cannot change its own ids, thus one read serves each request.
    const identity = processIdentity();

    routes.use("*", analysisQueryGuard(opts));

    routes.get("/home", async (c) => {
        const body: HomeFolder = { path: await canonicalPathAsync(opts.homedir()) };
        return c.json(body);
    });

    routes.get("/list", async (c) => {
        const path = absolutePathOf(c);
        if (path.isErr()) return path.error;
        const hidden = c.req.query("hidden");
        if (hidden !== undefined && hidden !== "true" && hidden !== "false") {
            return apiError(c, "validation_error", "`hidden` must be `true` or `false`.", {
                formErrors: [],
                fieldErrors: { hidden: ["must be true or false"] },
            });
        }
        // A read on a slow mount can run for longer than 10 s.
        holdConnection(c);
        // With a prefix, the read keeps the hidden names, because only a prefix that starts with a dot can select one.
        const namePrefix = filterValue(c.req.query("namePrefix"))?.toLowerCase();
        const showHidden = hidden === "true";
        const folder = await readFolder(path.value, showHidden || namePrefix !== undefined);
        if (folder.isErr()) return readErrorResponse(c, folder.error);

        const { path: canonical, entries: read } = folder.value;
        const entries = namePrefix === undefined ? read : read.filter((entry) => entry.name.toLowerCase().startsWith(namePrefix));
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const pageEntries = entries.slice(page.page * page.perPage, (page.page + 1) * page.perPage);

        // The inputs and the workspace root are read one time for the request.
        const analysisId = filterValue(c.req.query("analysisId"));
        const inputFiles = new Set<string>();
        const inputFolders = new Set<string>();
        let origins: Promise<ReadonlyMap<string, FileOrigin>> = Promise.resolve(new Map());
        if (analysisId !== undefined) {
            const inputs = listAnalysisInputs(analysisId);
            if (inputs.isErr()) return internalError(c, inputs.error, "read the inputs of the analysis");
            const located = await inputAbsolutePaths(inputs.value);
            for (const [input, inputPath] of located) {
                if (inputPath !== null) (input.isDir ? inputFolders : inputFiles).add(inputPath);
            }

            const runtime = boot.runtime();
            if (runtime !== null) {
                const root = await locateWorkspaceReadRoot(analysisId);
                if (root.isErr()) return internalError(c, root.error, "locate the workspace folder");
                if (root.value !== null) origins = readOrigins(pageEntries, root.value.canonical, runtime.pool, analysisId, opts);
            }
        }

        const list: ListContext = { identity, hidden: showHidden, inputFiles, inputFolders };
        const queue = new PQueue({ concurrency: ENTRY_READ_WIDTH });
        const [views, originOf, readable] = await Promise.all([
            Promise.all(pageEntries.map((entry) => queue.add(() => entryView(entry, list, opts)))),
            origins,
            statResultAsync(canonical, "fsRoutes:folderStat").match(
                (stats) => (identity ? isReadableBy(stats, identity) : null),
                () => null,
            ),
        ]);
        const items = views.map((view): FolderEntryView => ({ ...view, origin: originOf.get(view.path) ?? null }));
        const facts: FolderFacts = { path: canonical, readable };
        const body: FolderList = { ...listEnvelope("entries", items, entries.length, page), folder: facts };
        return c.json(body);
    });

    routes.get("/read", async (c) => {
        const path = absolutePathOf(c);
        if (path.isErr()) return path.error;
        const download = c.req.query("download");
        if (download !== undefined && download !== "1") {
            return apiError(c, "validation_error", "`download` is 1 or absent.", { formErrors: [], fieldErrors: { download: ["must be 1"] } });
        }
        // The real path of a file on a hung mount can take more than 10 s.
        holdConnection(c);
        return serveFile(c, opts, "unlimited", path.value, path.value, { ...READ_ROUTE_RESPONSE, download: download === "1" });
    });

    routes.get("/preview", async (c) => {
        const path = absolutePathOf(c);
        if (path.isErr()) return path.error;
        // The real path of a file on a hung mount can take more than 10 s.
        holdConnection(c);
        const opened = await openRealPath(c, opts, "unlimited", path.value, notAFileOrFolder);
        if (opened.isErr()) return opened.error;
        try {
            return await previewOpened(c, opts, opened.value.handle, opened.value.realPath);
        } finally {
            await closeHandle(opened.value.handle);
        }
    });

    return routes;
}
