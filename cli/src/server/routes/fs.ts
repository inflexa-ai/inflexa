import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { Hono, type Context } from "hono";
import { err, ok, type Result } from "neverthrow";

import type { FolderEntryView, FolderFacts, FolderList, HomeFolder } from "../../api/fs.ts";
import { entryDetails, readFolder, type FolderEntry, type FolderReadError } from "../../lib/folder_listing.ts";
import { errnoCode, isReadableBy, processIdentity, statResultAsync, type ProcessIdentity } from "../../lib/fs.ts";
import { canonicalPathAsync } from "../../lib/paths.ts";
import { analysisQueryGuard, DEFAULT_ANALYSIS_GUARD_OPTS, type AnalysisGuardOpts } from "../analysis_guard.ts";
import { apiError, holdConnection, listEnvelope, parsePage, type ServerEnv } from "../http.ts";
import { DEFAULT_FILE_ROUTE_OPTS, serveFile, type FileResponseOpts, type FileRouteOpts } from "./files.ts";

/** The reads and the lock of the file system routes. A test replaces one to count the calls or to make a read fail. */
export type FsRouteOpts = FileRouteOpts &
    AnalysisGuardOpts & {
        readonly entryDetails: typeof entryDetails;
        /** The home folder of the server user. A test gives a path behind a link without a change to the `HOME` of the shared process. */
        readonly homedir: () => string;
    };

/** The production {@link FsRouteOpts}. */
export const DEFAULT_FS_ROUTE_OPTS: FsRouteOpts = { ...DEFAULT_FILE_ROUTE_OPTS, ...DEFAULT_ANALYSIS_GUARD_OPTS, entryDetails, homedir };

async function entryView(entry: FolderEntry, identity: ProcessIdentity | null, opts: FsRouteOpts): Promise<FolderEntryView> {
    const details = await opts.entryDetails(entry, identity);
    return {
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        link: details.link,
        size: details.size,
        modifiedAt: details.modifiedMs === null ? null : new Date(details.modifiedMs).toISOString(),
        mode: details.mode,
        readable: details.readable,
        writable: details.writable,
        hidden: entry.hidden,
    };
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
 * The file system routes under `/api/v1/fs`: the home folder, the entries of one folder, and the bytes of one file.
 * They read each path of the machine with no root limit, and they use no harness runtime.
 */
export function fsRoutes(opts: FsRouteOpts = DEFAULT_FS_ROUTE_OPTS): Hono<ServerEnv> {
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
        const folder = await readFolder(path.value, hidden === "true");
        if (folder.isErr()) return readErrorResponse(c, folder.error);

        const { path: canonical, entries } = folder.value;
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        // `parsePage` caps `perPage`, thus the cap bounds the count of `stat` calls in flight.
        const [items, readable] = await Promise.all([
            Promise.all(entries.slice(page.page * page.perPage, (page.page + 1) * page.perPage).map((entry) => entryView(entry, identity, opts))),
            statResultAsync(canonical, "fsRoutes:folderStat").match(
                (stats) => (identity ? isReadableBy(stats, identity) : null),
                () => null,
            ),
        ]);
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

    return routes;
}
