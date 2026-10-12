import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { Hono } from "hono";

import type { FolderEntryView, FolderFacts, FolderList, HomeFolder } from "../../api/fs.ts";
import { entryDetails, readFolder, type FolderEntry, type FolderReadError } from "../../lib/folder_listing.ts";
import { errnoCode, isReadableBy, processIdentity, statResult, type ProcessIdentity } from "../../lib/fs.ts";
import { apiError, holdConnection, listEnvelope, parsePage, type ServerEnv } from "../http.ts";

/** The reads of the file system routes. A test replaces one to count the calls. */
export type FsRouteOpts = {
    readonly entryDetails: typeof entryDetails;
};

/** The production {@link FsRouteOpts}. */
export const DEFAULT_FS_ROUTE_OPTS: FsRouteOpts = { entryDetails };

function entryView(entry: FolderEntry, identity: ProcessIdentity | null, opts: FsRouteOpts): FolderEntryView {
    const details = opts.entryDetails(entry, identity);
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
 * The file system routes under `/api/v1/fs`: the home folder, and the entries of one folder. They give metadata
 * only, with no root limit, and they use no harness runtime.
 */
export function fsRoutes(opts: FsRouteOpts = DEFAULT_FS_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    // A process cannot change its own ids, thus one read serves each request.
    const identity = processIdentity();

    routes.get("/home", (c) => {
        const body: HomeFolder = { path: homedir() };
        return c.json(body);
    });

    routes.get("/list", (c) => {
        const path = c.req.query("path");
        // `node:fs` refuses a NUL byte with `ERR_INVALID_ARG_VALUE`, a fault of the request and not a read failure.
        if (path === undefined || !isAbsolute(path) || path.includes("\0")) {
            return apiError(c, "validation_error", "`path` must be an absolute path.", {
                formErrors: [],
                fieldErrors: { path: ["The path must be absolute."] },
            });
        }
        const hidden = c.req.query("hidden");
        if (hidden !== undefined && hidden !== "true" && hidden !== "false") {
            return apiError(c, "validation_error", "`hidden` must be `true` or `false`.", {
                formErrors: [],
                fieldErrors: { hidden: ["must be true or false"] },
            });
        }
        // A read on a slow mount can run for longer than 10 s.
        holdConnection(c);
        // `resolve` removes each `..` segment as text, before `realpathSync` sees the path.
        const folder = readFolder(resolve(path), hidden === "true");
        if (folder.isErr()) return readErrorResponse(c, folder.error);

        const { path: canonical, entries } = folder.value;
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const items = entries.slice(page.page * page.perPage, (page.page + 1) * page.perPage).map((entry) => entryView(entry, identity, opts));
        const facts: FolderFacts = {
            path: canonical,
            readable: statResult(canonical, "fsRoutes:folderStat").match(
                (stats) => (identity ? isReadableBy(stats, identity) : null),
                () => null,
            ),
        };
        const body: FolderList = { ...listEnvelope("entries", items, entries.length, page), folder: facts };
        return c.json(body);
    });

    return routes;
}
