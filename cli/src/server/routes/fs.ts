import { queryArtifactOrigins, queryRunsByAnalysis, type ArtifactOrigin, type CortexRunRow, type DbError, type Pool } from "@inflexa-ai/harness";
import type { BigIntStats } from "node:fs";
import { lstat, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Hono, type Context } from "hono";
import { err, ok, Result, ResultAsync } from "neverthrow";
import PQueue from "p-queue";
import { z } from "zod";

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
    type FsSearch,
    type FsSearchHit,
    type AddPinRequest,
    type DeletePinResponse,
    type FolderPlace,
    type HomeFolder,
    type PinList,
    type PinPlace,
    type PinView,
    type PlaceItem,
    type Places,
    type PlaceSection,
    type RecentFiles,
    type RecordRecentRequest,
    type RecordRecentResponse,
    type TablePreview,
    type TextPreview,
} from "../../api/fs.ts";
import { addPin, recordRecentFile, removePin } from "../../db/primary_mutation.ts";
import { getAnalysis, listAnalysisInputPage, listAnalysisInputs, listAnalysisPage, listPins, listRecentFiles } from "../../db/primary_query.ts";
import {
    compareEntries,
    countFolderEntries,
    entryDetails,
    readError,
    readFolder,
    scanFolder,
    type FolderEntry,
    type FolderReadError,
} from "../../lib/folder_listing.ts";
import { errnoCode, isReadableBy, processIdentity, statResultAsync, type ProcessIdentity } from "../../lib/fs.ts";
import { getLogger } from "../../lib/log.ts";
import { canonicalPathAsync } from "../../lib/paths.ts";
import { ABSENT_CODES, contains, locateWorkspaceReadRoot } from "../../modules/analysis/boundary.ts";
import { inputAbsolutePaths } from "../../modules/analysis/input.ts";
import { defaultOutputSubdir } from "../../modules/analysis/output.ts";
import { extensionOf, fileKindOf } from "../../modules/fs/file_kind.ts";
import {
    createSearchIndexCache,
    DEFAULT_SEARCH_LIMITS,
    spawnWalkChild,
    type SearchIndexCache,
    type SearchLimits,
    type WalkSpawner,
} from "../../modules/fs/search_index.ts";
import { str256 } from "../../lib/types.ts";
import type { PickerPin } from "../../types/picker.ts";
import { analysisQueryGuard, DEFAULT_ANALYSIS_GUARD_OPTS, guardAnalysisId, type AnalysisGuardOpts } from "../analysis_guard.ts";
import type { ServerBoot } from "../boot.ts";
import { apiError, filterValue, holdConnection, internalError, listEnvelope, parseCount, parsePage, readBody, type ServerEnv } from "../http.ts";
import { closeHandle, DEFAULT_FILE_ROUTE_OPTS, openRealPath, serveFile, unreadable, type FileResponseOpts, type FileRouteOpts } from "./files.ts";

/**
 * A place from which the server finds mounted volumes. A `parent` root is a folder whose entries are the candidates, for
 * example `/Volumes`. A `volume` root is one candidate itself, for example the drive root `C:\`.
 */
export type VolumeRoot = { path: string; kind: "parent" | "volume" };

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
        /** The caps of the name search. A test sets small caps and a short TTL. */
        readonly search: SearchLimits;
        /** The clock of the search cache, for its TTL and its time budget. A test gives a fake clock. */
        readonly now: () => number;
        /** Starts the walk child of a search. A test runs the walk in the test process, holds a child, or fails the start. */
        readonly spawnWalk: WalkSpawner;
        /** Gets the search cache of the routes once at their creation, so that a test can stop its walks and its timer. */
        readonly onSearchCache?: (cache: SearchIndexCache) => void;
        /** The harness read of the newest runs of an analysis. A test replaces it, because the real read needs Postgres. */
        readonly listRuns: (pool: Pool, analysisId: string, page: { limit: number }) => ResultAsync<CortexRunRow[], DbError>;
        /** The places in which the places read looks for mounted volumes. A test gives temporary folders. */
        readonly volumeRoots: () => readonly VolumeRoot[];
    };

/** The mounted-volume roots of the platform that runs the server. A platform with no known roots gives none. */
function platformVolumeRoots(): readonly VolumeRoot[] {
    switch (process.platform) {
        case "darwin":
            return [{ path: "/Volumes", kind: "parent" }];
        case "linux": {
            // The call throws when the OS user has no password entry. The per-user mount folders are then unknown.
            const user = Result.fromThrowable(
                () => userInfo().username,
                (cause) => cause,
            )();
            const perUser = user.isOk()
                ? [
                      { path: join("/media", user.value), kind: "parent" as const },
                      { path: join("/run/media", user.value), kind: "parent" as const },
                  ]
                : [];
            return [...perUser, { path: "/mnt", kind: "parent" }];
        }
        case "win32":
            return Array.from({ length: 26 }, (_, i): VolumeRoot => ({ path: `${String.fromCharCode(65 + i)}:\\`, kind: "volume" }));
        default:
            return [];
    }
}

/** The production {@link FsRouteOpts}. */
export const DEFAULT_FS_ROUTE_OPTS: FsRouteOpts = {
    ...DEFAULT_FILE_ROUTE_OPTS,
    ...DEFAULT_ANALYSIS_GUARD_OPTS,
    entryDetails,
    artifactOrigins: queryArtifactOrigins,
    previewBytes: 64 * 1024,
    homedir,
    search: DEFAULT_SEARCH_LIMITS,
    now: Date.now,
    spawnWalk: spawnWalkChild,
    listRuns: queryRunsByAnalysis,
    volumeRoots: platformVolumeRoots,
};

/** How many entries of one page read their facts at one time. A slow mount holds one slot and not the page. */
const ENTRY_READ_WIDTH = 16;

/** The count of the hits of a search without `limit`. */
const SEARCH_DEFAULT_LIMIT = 50;

/** The most hits of one search. */
const SEARCH_MAX_LIMIT = 200;

/** The most recent files that one scope keeps, and the most that one read of a scope looks at. */
const RECENT_FILES_CAP = 100;

/** The most declared inputs that the places read looks at. `count` still holds all of them. */
const PLACE_INPUTS_CAP = 200;

/** The most runs of the analysis section. */
const PLACE_RUNS_CAP = 10;

/** The most step folders that the places read gives for one run. */
const PLACE_STEPS_CAP = 50;

/** The most pins of the favorites section. */
const PLACE_PINS_CAP = 50;

/** The most other analyses of the places read. */
const PLACE_ANALYSES_CAP = 20;

/** The most mounted volumes of the places read. */
const PLACE_DRIVES_CAP = 20;

/** The folders of the home folder that are places, in the order of the section. */
const HOME_PLACES = [
    { kind: "desktop", name: "Desktop" },
    { kind: "documents", name: "Documents" },
    { kind: "downloads", name: "Downloads" },
] as const;

/** The `limit` of the recent-file read when the request sends none. */
const RECENT_FILES_DEFAULT_LIMIT = 20;

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

/**
 * The views of `entries` for one request: the facts, the item count, the input mark, and the origin of each entry, in the
 * order of `entries`. The inputs and the workspace root of `analysisId` are read one time for the request, and the origins
 * with one ledger read for `entries`. The error channel holds the 500 response to send.
 */
async function enrichEntries(
    c: Context<ServerEnv>,
    boot: ServerBoot,
    opts: FsRouteOpts,
    identity: ProcessIdentity | null,
    entries: readonly FolderEntry[],
    hidden: boolean,
): Promise<Result<FolderEntryView[], Response>> {
    const analysisId = filterValue(c.req.query("analysisId"));
    const inputFiles = new Set<string>();
    const inputFolders = new Set<string>();
    let origins: Promise<ReadonlyMap<string, FileOrigin>> = Promise.resolve(new Map());
    if (analysisId !== undefined) {
        const inputs = listAnalysisInputs(analysisId);
        if (inputs.isErr()) return err(internalError(c, inputs.error, "read the inputs of the analysis"));
        const located = await inputAbsolutePaths(inputs.value);
        for (const [input, inputPath] of located) {
            if (inputPath !== null) (input.isDir ? inputFolders : inputFiles).add(inputPath);
        }

        const runtime = boot.runtime();
        if (runtime !== null) {
            const root = await locateWorkspaceReadRoot(analysisId);
            if (root.isErr()) return err(internalError(c, root.error, "locate the workspace folder"));
            if (root.value !== null) origins = readOrigins(entries, root.value.canonical, runtime.pool, analysisId, opts);
        }
    }

    const list: ListContext = { identity, hidden, inputFiles, inputFolders };
    const queue = new PQueue({ concurrency: ENTRY_READ_WIDTH });
    const [views, originOf] = await Promise.all([Promise.all(entries.map((entry) => queue.add(() => entryView(entry, list, opts)))), origins]);
    return ok(views.map((view): FolderEntryView => ({ ...view, origin: originOf.get(view.path) ?? null })));
}

/** The `hidden` query value of the list and the search: absent is false. The error channel holds the 400 response to send. */
function hiddenOf(c: Context<ServerEnv>): Result<boolean, Response> {
    const hidden = c.req.query("hidden");
    if (hidden !== undefined && hidden !== "true" && hidden !== "false") {
        return err(
            apiError(c, "validation_error", "`hidden` must be `true` or `false`.", {
                formErrors: [],
                fieldErrors: { hidden: ["must be true or false"] },
            }),
        );
    }
    return ok(hidden === "true");
}

/** The response of `GET /read` for a file: no extra header, and the download flag is set per request. */
const READ_ROUTE_RESPONSE: FileResponseOpts = { download: false, headers: {}, notAFile };

function notAFile(c: Context<ServerEnv>): Response {
    return apiError(c, "validation_error", "`path` must name a file.", { formErrors: [], fieldErrors: { path: ["The path is not a file."] } });
}

/**
 * `path` as an absolute path with each `.` and `..` segment removed as text. The error channel holds the 400 response to
 * send. Each route of this file reads its path here, thus the rule has one home.
 */
function absolutePathFrom(c: Context<ServerEnv>, path: string | undefined): Result<string, Response> {
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

/** The `path` query value, read by {@link absolutePathFrom}. */
function absolutePathOf(c: Context<ServerEnv>): Result<string, Response> {
    return absolutePathFrom(c, c.req.query("path"));
}

/**
 * The real path and the kind of the entry that a body `path` names, for a pin or a recent file. The error channel holds
 * the response to send: 400 for a path that is not absolute, 404 `not_found` when no entry exists, and 403 `forbidden`
 * with the code of the operating system for each other failure. Two spellings of one folder give one real path.
 */
async function locatePath(c: Context<ServerEnv>, path: string): Promise<Result<{ realPath: string; isDir: boolean }, Response>> {
    const absolute = absolutePathFrom(c, path);
    if (absolute.isErr()) return err(absolute.error);
    const located = await ResultAsync.fromPromise(
        realpath(absolute.value).then(async (realPath) => ({ realPath, isDir: (await stat(realPath)).isDirectory() })),
        (cause) => cause,
    );
    if (located.isErr()) {
        return err(ABSENT_CODES.has(errnoCode(located.error) ?? "") ? apiError(c, "not_found", "No entry at the path.") : unreadable(c, located.error));
    }
    return ok(located.value);
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

const addPinBody = z.object({ path: z.string(), label: z.string().optional() }) satisfies z.ZodType<AddPinRequest>;

const recordRecentBody = z.object({ path: z.string(), analysisId: z.string().optional() }) satisfies z.ZodType<RecordRecentRequest>;

function pinView(pin: PickerPin, absolutePath: string | null): PinView {
    return {
        id: pin.id,
        createdAt: new Date(pin.createdAt).toISOString(),
        updatedAt: new Date(pin.updatedAt).toISOString(),
        path: pin.path,
        label: pin.label,
        isDir: pin.isDir,
        absolutePath,
    };
}

/**
 * The entry at a stored path from one `lstat`, or `null` when no entry exists at the path now. An `lstat` that fails for a
 * different reason keeps the entry, with the type of the stored `isDir`, because the person can still open the file.
 */
async function entryAt(path: string, isDir: boolean): Promise<FolderEntry | null> {
    const name = basename(path);
    const stats = await ResultAsync.fromPromise(lstat(path), (cause) => cause);
    if (stats.isErr()) {
        if (ABSENT_CODES.has(errnoCode(stats.error) ?? "")) return null;
        return { name, path, kind: isDir ? "folder" : "file", hidden: name.startsWith(".") };
    }
    const kind = stats.value.isDirectory() ? "folder" : stats.value.isSymbolicLink() ? "symlink" : "file";
    return { name, path, kind, hidden: name.startsWith(".") };
}

/** The real path of `path` when it leads to a folder, and `null` for each other outcome. */
async function folderRealPath(path: string): Promise<string | null> {
    return ResultAsync.fromPromise(
        realpath(path).then(async (real) => ((await stat(real)).isDirectory() ? real : null)),
        (cause) => cause,
    ).unwrapOr(null);
}

/** The label of a place from its path: the name of the last segment, or the path itself for a root. */
function placeLabel(path: string): string {
    return basename(path) || path;
}

/**
 * The first `limit` distinct non-null results of `probe` over `items`, in the order of `items`. It probes one fixed-width
 * chunk at a time and stops at the first chunk that fills `limit`, thus a long list costs only what the answer needs. The
 * probes of a chunk settle in any order, but the fold reads them in the order of `items`. As a result, when two items give
 * the same `keyOf` value, the first item wins, and a duplicate does not count against `limit`.
 */
async function firstProbed<T, R>(items: readonly T[], limit: number, probe: (item: T) => Promise<R | null>, keyOf: (result: R) => string): Promise<R[]> {
    const found: R[] = [];
    const keys = new Set<string>();
    for (let at = 0; at < items.length && found.length < limit; at += ENTRY_READ_WIDTH) {
        const probed = await Promise.all(items.slice(at, at + ENTRY_READ_WIDTH).map(probe));
        for (const result of probed) {
            if (result === null || found.length >= limit) continue;
            const key = keyOf(result);
            if (keys.has(key)) continue;
            keys.add(key);
            found.push(result);
        }
    }
    return found;
}

/** The `analysis` section: the workspace, the inputs, and the runs with their steps. The error channel holds the 500 response. */
async function analysisPlaces(
    c: Context<ServerEnv>,
    boot: ServerBoot,
    opts: FsRouteOpts,
    identity: ProcessIdentity | null,
    analysisId: string,
): Promise<Result<PlaceItem[], Response>> {
    const analysis = getAnalysis(analysisId);
    if (analysis.isErr()) return err(internalError(c, analysis.error, "read the analysis"));
    const root = await locateWorkspaceReadRoot(analysisId);
    if (root.isErr()) return err(internalError(c, root.error, "locate the workspace folder"));
    const inputPage = listAnalysisInputPage(analysisId, { limit: PLACE_INPUTS_CAP, offset: 0 });
    if (inputPage.isErr()) return err(internalError(c, inputPage.error, "read the inputs of the analysis"));

    const items: PlaceItem[] = [];
    const workspace = root.value;
    if (workspace !== null && analysis.value !== null && (await folderRealPath(workspace.canonical)) !== null) {
        items.push({ kind: "workspace", label: analysis.value.name, path: workspace.canonical });
    }

    const located = await inputAbsolutePaths(inputPage.value.items);
    const queue = new PQueue({ concurrency: ENTRY_READ_WIDTH });
    const entries: FolderEntry[] = [];
    const inputFiles = new Set<string>();
    const inputFolders = new Set<string>();
    const probed = await Promise.all(
        inputPage.value.items.map((input) =>
            queue.add(async () => {
                const path = located.get(input) ?? null;
                return path === null ? null : { input, path, entry: await entryAt(path, input.isDir) };
            }),
        ),
    );
    for (const probe of probed) {
        if (probe === null || probe.entry === null) continue;
        entries.push(probe.entry);
        (probe.input.isDir ? inputFolders : inputFiles).add(probe.path);
    }

    const runtime = boot.runtime();
    // One ledger read for the runs, started with the origins read, and one origins read for all entries.
    const origins =
        runtime !== null && workspace !== null
            ? readOrigins(entries, workspace.canonical, runtime.pool, analysisId, opts)
            : Promise.resolve(new Map<string, FileOrigin>());
    const runs =
        runtime !== null && workspace !== null
            ? await opts.listRuns(runtime.pool, analysisId, { limit: PLACE_RUNS_CAP }).match(
                  (rows) => rows,
                  (cause) => {
                      getLogger("server").warn({ err: cause }, "could not read the runs for the places of the picker");
                      return [];
                  },
              )
            : [];

    const list: ListContext = { identity, hidden: false, inputFiles, inputFolders };
    const [views, originOf, runPlaces] = await Promise.all([
        Promise.all(entries.map((entry) => queue.add(() => entryView(entry, list, opts)))),
        origins,
        workspace === null ? [] : runPlacesOf(workspace.canonical, runs, queue),
    ]);
    items.push({
        kind: "inputs",
        label: "Inputs",
        count: inputPage.value.total,
        entries: views.map((view): FolderEntryView => ({ ...view, origin: originOf.get(view.path) ?? null })),
    });
    items.push(...runPlaces);
    return ok(items);
}

/** A `run` item for each run whose folder exists, each followed by the `step` items of its folders. The queue bounds the folder reads. */
async function runPlacesOf(root: string, runs: readonly CortexRunRow[], queue: PQueue): Promise<PlaceItem[]> {
    const read = await Promise.all(runs.map((run) => queue.add(() => readFolder(join(root, "runs", run.runId), false).unwrapOr(null))));
    const items: PlaceItem[] = [];
    for (const [index, folder] of read.entries()) {
        const run = runs[index];
        if (run === undefined || folder === null) continue;
        items.push({ kind: "run", label: run.runId, path: folder.path });
        for (const step of folder.entries.filter((entry) => entry.kind === "folder").slice(0, PLACE_STEPS_CAP)) {
            items.push({ kind: "step", label: step.name, path: step.path });
        }
    }
    return items;
}

/** The `favorites` section: the first pins, each resolved in a queue of fixed width. */
async function favoritePlaces(c: Context<ServerEnv>): Promise<Result<PlaceItem[], Response>> {
    const read = listPins({ limit: PLACE_PINS_CAP, offset: 0 });
    if (read.isErr()) return err(internalError(c, read.error, "list the pins"));
    const queue = new PQueue({ concurrency: ENTRY_READ_WIDTH });
    const items = await Promise.all(
        read.value.items.map((pin) =>
            queue.add(async (): Promise<PinPlace> => {
                const resolved = await ResultAsync.fromPromise(realpath(pin.path), (cause) => cause).unwrapOr(null);
                return { kind: "pin", label: pin.label ?? placeLabel(pin.path), path: resolved ?? pin.path, pinId: pin.id, lost: resolved === null };
            }),
        ),
    );
    return ok(items);
}

/** The `locations` section: the home folder, and each of its standard folders that exists. */
async function locationPlaces(opts: FsRouteOpts): Promise<PlaceItem[]> {
    const home = await canonicalPathAsync(opts.homedir());
    const standard = await Promise.all(
        HOME_PLACES.map(async ({ kind, name }): Promise<PlaceItem | null> => {
            const real = await folderRealPath(join(home, name));
            return real === null ? null : { kind, label: name, path: real };
        }),
    );
    return [{ kind: "home", label: placeLabel(home), path: home }, ...standard.filter((item) => item !== null)];
}

/** The `otherAnalyses` section, from one page read. The cached anchor path gives each workspace path, thus no query runs for each analysis. */
async function otherAnalysisPlaces(c: Context<ServerEnv>, analysisId: string | undefined): Promise<Result<PlaceItem[], Response>> {
    const page = listAnalysisPage({ projectId: null, sort: "activity", limit: PLACE_ANALYSES_CAP + 1, offset: 0 });
    if (page.isErr()) return err(internalError(c, page.error, "list the analyses"));
    const others = page.value.items.filter(({ analysis }) => analysis.id !== analysisId).slice(0, PLACE_ANALYSES_CAP);
    const queue = new PQueue({ concurrency: ENTRY_READ_WIDTH });
    const items = await Promise.all(
        others.map(({ analysis, anchorPath }) =>
            queue.add(async (): Promise<PlaceItem | null> => {
                if (anchorPath === null) return null;
                const real = await folderRealPath(join(anchorPath, defaultOutputSubdir(analysis.slug)));
                return real === null ? null : { kind: "analysis", label: analysis.name, path: real };
            }),
        ),
    );
    return ok(items.filter((item) => item !== null));
}

/** The label of a drive: the drive letter with its colon, or the name of the volume folder. */
function driveLabel(path: string): string {
    const stripped = path.replace(/[\\/]+$/, "");
    return /^[A-Za-z]:$/.test(stripped) ? stripped : placeLabel(stripped);
}

/**
 * The `drives` section: the mounted volumes of the roots, in name order, at most {@link PLACE_DRIVES_CAP}. A candidate gives
 * an item when its real path is a folder and is not `/`, which drops the link of a volume to the system root.
 */
async function drivePlaces(opts: FsRouteOpts): Promise<PlaceItem[]> {
    const candidates: string[] = [];
    for (const root of opts.volumeRoots()) {
        if (root.kind === "volume") {
            candidates.push(root.path);
            continue;
        }
        // An absent root gives no candidate.
        const folder = await readFolder(root.path, false).unwrapOr(null);
        if (folder !== null) candidates.push(...folder.entries.map((entry) => entry.path));
    }
    const byName = candidates.map((path) => ({ path, label: driveLabel(path) })).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    // Two roots can lead to one volume. The fold of `firstProbed` drops the later candidate by real path, in name order.
    return firstProbed(
        byName,
        PLACE_DRIVES_CAP,
        async (candidate): Promise<FolderPlace | null> => {
            const real = await folderRealPath(candidate.path);
            return real === null || real === "/" ? null : { kind: "drive", label: candidate.label, path: real };
        },
        (item) => item.path,
    );
}

/**
 * The file system routes under `/api/v1/fs`: the home folder, the entries of one folder, a name search under one folder, the
 * bytes of one file, the preview of one file or folder, and the pins (`/pins`), the recent files (`/recents`), and the
 * places (`/places`) of the picker.
 * They read each path of the machine with no root limit. The only writes are the rows of the pins and of the recent
 * files. The list, the recent-file read, and the places read use the harness runtime for the `origin` of their entries, and
 * the places read also for the runs, only when the boot is ready. Before that each `origin` is `null`, the places give no
 * run, and each route still answers.
 */
export function fsRoutes(boot: ServerBoot, opts: FsRouteOpts = DEFAULT_FS_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    // A process cannot change its own ids, thus one read serves each request.
    const identity = processIdentity();

    // One cache for the routes: each keystroke of a picker reads the index that its first search built.
    const searchCache = createSearchIndexCache(opts.search, opts.now, opts.spawnWalk);
    opts.onSearchCache?.(searchCache);

    routes.use("*", analysisQueryGuard(opts));

    routes.get("/home", async (c) => {
        const body: HomeFolder = { path: await canonicalPathAsync(opts.homedir()) };
        return c.json(body);
    });

    routes.get("/list", async (c) => {
        const path = absolutePathOf(c);
        if (path.isErr()) return path.error;
        const hidden = hiddenOf(c);
        if (hidden.isErr()) return hidden.error;
        // A read on a slow mount can run for longer than 10 s.
        holdConnection(c);
        // With a prefix, the read keeps the hidden names, because only a prefix that starts with a dot can select one.
        const namePrefix = filterValue(c.req.query("namePrefix"))?.toLowerCase();
        const showHidden = hidden.value;
        const folder = await readFolder(path.value, showHidden || namePrefix !== undefined);
        if (folder.isErr()) return readErrorResponse(c, folder.error);

        const { path: canonical, entries: read } = folder.value;
        const entries = namePrefix === undefined ? read : read.filter((entry) => entry.name.toLowerCase().startsWith(namePrefix));
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const pageEntries = entries.slice(page.page * page.perPage, (page.page + 1) * page.perPage);

        const [items, readable] = await Promise.all([
            enrichEntries(c, boot, opts, identity, pageEntries, showHidden),
            statResultAsync(canonical, "fsRoutes:folderStat").match(
                (stats) => (identity ? isReadableBy(stats, identity) : null),
                () => null,
            ),
        ]);
        if (items.isErr()) return items.error;
        const facts: FolderFacts = { path: canonical, readable };
        const body: FolderList = { ...listEnvelope("entries", items.value, entries.length, page), folder: facts };
        return c.json(body);
    });

    // The walk takes no signal of the request: a picker aborts its request at each keystroke, and the next keystroke reads
    // the same index. A walk ends at a cap, at the end of the scope, or at an eviction.
    routes.get("/search", async (c) => {
        const path = absolutePathOf(c);
        if (path.isErr()) return path.error;
        const hidden = hiddenOf(c);
        if (hidden.isErr()) return hidden.error;
        const query = filterValue(c.req.query("q")) ?? "";
        const limit = parseCount(c.req.query("limit"), SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
        // A walk on a slow mount can run for longer than 10 s before its first answer.
        holdConnection(c);
        // The cache keys an index on the canonical scope, thus two paths to one folder share one walk.
        const canonical = await ResultAsync.fromPromise(realpath(path.value), (cause) => readError(path.value, cause));
        if (canonical.isErr()) return readErrorResponse(c, canonical.error);
        const found = await searchCache.search(canonical.value, hidden.value, query, limit);
        if (found.isErr())
            return found.error.type === "spawn_failed"
                ? internalError(c, found.error.cause, "start the walk of the search")
                : readErrorResponse(c, found.error);

        const { hits, truncated } = found.value;
        const views = await enrichEntries(
            c,
            boot,
            opts,
            identity,
            hits.map((hit) => hit.entry),
            hidden.value,
        );
        if (views.isErr()) return views.error;
        // `enrichEntries` gives one view for each entry, in the order of the entries, thus index `k` holds a view.
        const items = hits.map((hit, k): FsSearchHit => ({ entry: views.value[k]!, subpath: hit.subpath }));
        const body: FsSearch = { hits: items, truncated };
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

    routes.get("/places", async (c) => {
        // The reads of the places can wait on a slow mount for longer than 10 s.
        holdConnection(c);
        const analysisId = filterValue(c.req.query("analysisId"));
        const [analysis, favorites, locations, others, drives] = await Promise.all([
            analysisId === undefined ? Promise.resolve(null) : analysisPlaces(c, boot, opts, identity, analysisId),
            favoritePlaces(c),
            locationPlaces(opts),
            otherAnalysisPlaces(c, analysisId),
            drivePlaces(opts),
        ]);
        if (analysis !== null && analysis.isErr()) return analysis.error;
        if (favorites.isErr()) return favorites.error;
        if (others.isErr()) return others.error;
        const sections: PlaceSection[] = [
            ...(analysis === null || analysis.isErr() ? [] : [{ id: "analysis" as const, items: analysis.value }]),
            { id: "favorites", items: favorites.value },
            { id: "locations", items: locations },
            { id: "otherAnalyses", items: others.value },
            { id: "drives", items: drives },
        ];
        return c.json({ sections } satisfies Places);
    });

    routes.get("/pins", async (c) => {
        // The real path of a pin on a hung mount can take more than 10 s.
        holdConnection(c);
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const read = listPins({ limit: page.perPage, offset: page.page * page.perPage });
        if (read.isErr()) return internalError(c, read.error, "list the pins");

        // A failure of any kind means that the server cannot locate the path, and the pin stays in the list as lost.
        const queue = new PQueue({ concurrency: ENTRY_READ_WIDTH });
        const pins = await Promise.all(
            read.value.items.map((pin) =>
                queue.add(async () => pinView(pin, await ResultAsync.fromPromise(realpath(pin.path), (cause) => cause).unwrapOr(null))),
            ),
        );
        const body: PinList = listEnvelope("pins", pins, read.value.total, page);
        return c.json(body);
    });

    routes.post("/pins", async (c) => {
        const body = await readBody(c, addPinBody);
        if (body.isErr()) return body.error;
        let label: string | null = null;
        if (body.value.label !== undefined) {
            const trimmed = str256(body.value.label);
            if (trimmed.isOk()) label = trimmed.value;
            else if (trimmed.error === "too_long") {
                return apiError(c, "validation_error", "`label` must be at most 256 characters.", {
                    formErrors: [],
                    fieldErrors: { label: ["must be at most 256 characters"] },
                });
            }
        }
        const located = await locatePath(c, body.value.path);
        if (located.isErr()) return located.error;
        return addPin({ path: located.value.realPath, label, isDir: located.value.isDir }).match(
            ({ pin, created }) => c.json(pinView(pin, pin.path), created ? 201 : 200),
            (e) => internalError(c, e, "add the pin"),
        );
    });

    routes.delete("/pins/:id", (c) =>
        removePin(c.req.param("id")).match(
            (changed) => (changed === 0 ? apiError(c, "not_found", "Pin not found.") : c.json({ deleted: true } satisfies DeletePinResponse)),
            (e) => internalError(c, e, "remove the pin"),
        ),
    );

    routes.post("/recents", async (c) => {
        const body = await readBody(c, recordRecentBody);
        if (body.isErr()) return body.error;
        const located = await locatePath(c, body.value.path);
        if (located.isErr()) return located.error;
        // The query guard does not see a body value, thus the same steps run here, before the write.
        const analysisId = filterValue(body.value.analysisId);
        if (analysisId !== undefined) {
            const blocked = guardAnalysisId(c, analysisId, opts);
            if (blocked !== null) return blocked;
        }
        return recordRecentFile({ path: located.value.realPath, isDir: located.value.isDir, analysisId: analysisId ?? null, cap: RECENT_FILES_CAP }).match(
            () => c.json({ recorded: true } satisfies RecordRecentResponse),
            // The analysis can go between the guard and the write. The foreign key then refuses the row.
            (e) =>
                e.type === "constraint_violation" && e.constraint === "foreign_key"
                    ? apiError(c, "not_found", `No analysis has the id ${analysisId ?? ""}.`)
                    : internalError(c, e, "record the recent file"),
        );
    });

    routes.get("/recents", async (c) => {
        // An `lstat` on a hung mount can take more than 10 s.
        holdConnection(c);
        const analysisId = filterValue(c.req.query("analysisId"));
        const limit = parseCount(c.req.query("limit"), RECENT_FILES_DEFAULT_LIMIT, RECENT_FILES_CAP);
        const rows = listRecentFiles({ analysisId: analysisId ?? null, limit: RECENT_FILES_CAP });
        if (rows.isErr()) return internalError(c, rows.error, "list the recent files");

        // Each chunk is one fixed-width read of the disk. The loop stops at the first chunk that fills `limit`.
        const entries: FolderEntry[] = [];
        for (let at = 0; at < rows.value.length && entries.length < limit; at += ENTRY_READ_WIDTH) {
            const chunk = rows.value.slice(at, at + ENTRY_READ_WIDTH);
            const probed = await Promise.all(chunk.map((row) => entryAt(row.path, row.isDir)));
            for (const entry of probed) {
                if (entries.length >= limit) break;
                // A missing path keeps its row: an unmounted volume comes back, and only the cap of a post removes a row.
                if (entry !== null) entries.push(entry);
            }
        }

        const views = await enrichEntries(c, boot, opts, identity, entries, false);
        if (views.isErr()) return views.error;
        const body: RecentFiles = { entries: views.value };
        return c.json(body);
    });

    return routes;
}
