import { stat } from "node:fs/promises";
import { join } from "node:path";

import { buildReportSessionUrl } from "@inflexa-ai/harness/contracts/content-url.js";
import { PAGE_ASSETS } from "@inflexa-ai/harness/report-render/assets.js";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { err, ok, ResultAsync, type Result } from "neverthrow";

import type { ReportSessionAccess } from "../../api/conversation.ts";
import { serverBaseUrl } from "../../client/api.ts";
import { env } from "../../lib/env.ts";
import { errnoCode } from "../../lib/fs.ts";
import { classifyRealPath, workspaceReadRoot, type ReadRoot } from "../../modules/analysis/boundary.ts";
import type { WorkspaceError } from "../../modules/analysis/output.ts";
import { apiError, holdConnection, internalError, listenerPort, type ServerEnv } from "../http.ts";
import type { PageGrantStore } from "../report_page_grants.ts";
import { DEFAULT_FILE_ROUTE_OPTS, serveFile, type FileRouteOpts } from "./files.ts";

/** The cookie that carries the page grant after the entry request. The managed content server uses the same name. */
const PAGE_COOKIE = "__ic";

/** The folder of the workspace root that holds one folder for each report session. */
const SESSIONS_DIR = "report-sessions";

const UNAUTHORIZED_MESSAGE = "The link of this report page is not valid, or it expired. Open the report page again from Inflexa.";

/**
 * The headers of each response of the page route. The page runs in a sandbox with an opaque origin, thus a script
 * of the page cannot use the origin of the API. `allow-downloads` keeps the table and chart downloads. The URL of the
 * entry request carries the token, thus `Referrer-Policy` keeps it off each link of the page.
 */
const PAGE_HEADERS: Readonly<Record<string, string>> = {
    "Content-Security-Policy": "sandbox allow-scripts allow-downloads",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
};

/**
 * The files that need no grant: the shipped libraries and fonts that the preview stages beside each page. A
 * sandboxed page fetches a font in CORS mode and that fetch carries no cookie. The set is the manifest and not the
 * folder `assets/deps/`, because the folder can hold a file that a different writer put there.
 */
const PUBLIC_FILES: ReadonlySet<string> = new Set(PAGE_ASSETS.map((asset) => `assets/${asset.file}`));

/** The CORS header of a public file. Without it the browser refuses a font that a sandboxed page fetches. */
const PUBLIC_FILE_HEADERS: Readonly<Record<string, string>> = { "Access-Control-Allow-Origin": "*" };

const PUBLIC_LINK_MESSAGE = "A public file of the report session must be a file at its own path.";

/** Whether an id of the path is one safe segment: not empty, no separator, no NUL byte, and not `.` or `..`. */
function isSafeId(id: string): boolean {
    return id !== "" && id !== "." && id !== ".." && !/[/\\\0]/.test(id);
}

/** Whether a segment of the path inside the session folder can name a file: safe, and not hidden. */
function isServedSegment(segment: string): boolean {
    return isSafeId(segment) && !segment.startsWith(".");
}

/**
 * The decoded segments of the path of the request after `report-sessions`, or `null` for a path that does not
 * decode. The route reads the ids from the same segments as the file, thus the router and the route cannot
 * disagree on them.
 */
function pathSegments(c: Context): string[] | null {
    const raw = new URL(c.req.url).pathname.split("/").slice(1);
    if (raw[0] !== SESSIONS_DIR) return null;
    try {
        return raw.slice(1).map((segment) => decodeURIComponent(segment));
    } catch {
        // A segment with a bad percent escape names no file.
        return null;
    }
}

/** Why {@link locateSessionFolder} found no session folder. */
type SessionFolderFailure = { type: "workspace"; error: WorkspaceError } | { type: "absent" } | { type: "moved" } | { type: "io_failed"; cause: unknown };

/**
 * The folder of a report session as the one root of a read. Its real path must be the real path of the workspace
 * root joined with `report-sessions/{threadId}`. A link that moves the folder, in the folder itself or in
 * `report-sessions`, is `moved`: the confinement of a read would otherwise follow the link and take its target as
 * the root.
 */
async function locateSessionFolder(analysisId: string, threadId: string): Promise<Result<ReadRoot, SessionFolderFailure>> {
    const root = await workspaceReadRoot(analysisId);
    if (root.isErr()) return err({ type: "workspace", error: root.error });
    const folder: ReadRoot = {
        text: join(root.value.text, SESSIONS_DIR, threadId),
        canonical: join(root.value.canonical, SESSIONS_DIR, threadId),
    };
    const verdict = await classifyRealPath([root.value], folder.text);
    if (verdict.isErr()) return err({ type: "io_failed", cause: verdict.error.cause });
    switch (verdict.value.type) {
        case "absent":
            return err({ type: "absent" });
        case "outside":
            return err({ type: "moved" });
        case "in":
            return verdict.value.realPath === folder.canonical ? ok(folder) : err({ type: "moved" });
        default: {
            const exhaustive: never = verdict.value;
            throw new Error(`unhandled real-path verdict: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * Whether a public file is reached through a link. A public file needs no grant, thus it must be the file at its
 * own path: a link at that path would publish a different file of the session under a manifest name. A path that is
 * absent, outside the folder, or unreadable is not a link here: {@link serveFile} gives its answer.
 */
async function isLinkedPublicFile(folder: ReadRoot, tail: readonly string[], target: string): Promise<boolean> {
    const verdict = await classifyRealPath([folder], target);
    return verdict.isOk() && verdict.value.type === "in" && verdict.value.realPath !== join(folder.canonical, ...tail);
}

function noPage(c: Context<ServerEnv>): Response {
    return apiError(c, "not_found", "No page was rendered for this report session.");
}

function unauthorized(c: Context<ServerEnv>): Response {
    return apiError(c, "unauthorized", UNAUTHORIZED_MESSAGE);
}

/**
 * The route `GET /report-sessions/{analysisId}/{threadId}/<path>`: the files of one report session. It lives
 * outside `/api`, and only a page grant gives access. The checks run in this order: the form of the ids and of the
 * path (404), the proof (401), then the file (404 and 403). A request with no proof never learns whether a guarded
 * file exists.
 *
 * The proof is the cookie swap of the managed content server. The query value `t` wins and sets the cookie `__ic`.
 * Else a public file of the page asset manifest passes. Else the cookie must hold a live grant of the session.
 * Each response carries the sandbox headers of {@link PAGE_HEADERS}.
 */
export function reportPageRoutes(grants: PageGrantStore, opts: FileRouteOpts = DEFAULT_FILE_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    // After `next()`, so that an error body and a 304 carry the headers too. The headers of a response that
    // `new Response` made are mutable.
    routes.use("*", async (c, next) => {
        await next();
        for (const [name, value] of Object.entries(PAGE_HEADERS)) c.res.headers.set(name, value);
    });

    routes.get("/*", async (c) => {
        const segments = pathSegments(c);
        const [analysisId = "", threadId = "", ...tail] = segments ?? [];
        if (segments === null || tail.length === 0 || !isSafeId(analysisId) || !isSafeId(threadId) || !tail.every(isServedSegment)) {
            return apiError(c, "not_found", "No file at the path.");
        }

        const publicFile = PUBLIC_FILES.has(tail.join("/"));
        const queryToken = c.req.query("t");
        let entrySeconds: number | null = null;
        if (queryToken !== undefined) {
            entrySeconds = grants.remainingSeconds(queryToken, analysisId, threadId);
            if (entrySeconds === null) return unauthorized(c);
        } else if (!publicFile) {
            const cookie = getCookie(c, PAGE_COOKIE);
            if (cookie === undefined || grants.remainingSeconds(cookie, analysisId, threadId) === null) return unauthorized(c);
        }

        // The real path of a file on a hung mount can take more than 10 s.
        holdConnection(c);
        const folder = await locateSessionFolder(analysisId, threadId);
        let response: Response;
        if (folder.isErr()) {
            response = sessionFolderFailure(c, folder.error);
        } else {
            const target = join(folder.value.text, ...tail);
            response =
                publicFile && (await isLinkedPublicFile(folder.value, tail, target))
                    ? apiError(c, "forbidden", PUBLIC_LINK_MESSAGE)
                    : await serveFile(c, opts, [folder.value], target, tail[tail.length - 1] ?? "", {
                          download: false,
                          headers: publicFile ? { ...PAGE_HEADERS, ...PUBLIC_FILE_HEADERS } : PAGE_HEADERS,
                          notAFile: (context) => apiError(context, "not_found", "No file at the path."),
                      });
        }

        // The token of the entry request is the one that passed, thus the cookie holds the same token. The path of
        // the cookie names the session, and a cookie of one session never reaches a different session.
        if (queryToken !== undefined && entrySeconds !== null) {
            const path = `/${SESSIONS_DIR}/${encodeURIComponent(analysisId)}/${encodeURIComponent(threadId)}/`;
            response.headers.append("Set-Cookie", `${PAGE_COOKIE}=${queryToken}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${entrySeconds}`);
        }
        return response;
    });

    return routes;
}

/**
 * The response for a session folder that cannot serve. The route is outside the analysis guard, and a request
 * with no grant can ask for a public file. Thus a lost workspace and an absent folder both give 404, and the route
 * does not tell an unknown analysis from a lost folder.
 */
function sessionFolderFailure(c: Context<ServerEnv>, failure: SessionFolderFailure): Response {
    switch (failure.type) {
        case "workspace":
            return failure.error.type === "workspace_unavailable"
                ? apiError(c, "not_found", "No file at the path.")
                : internalError(c, failure.error, "locate the workspace");
        case "absent":
            return apiError(c, "not_found", "No file at the path.");
        case "moved":
            return apiError(c, "forbidden", "The folder of the report session is outside the workspace.");
        case "io_failed":
            return internalError(c, failure.cause, "read the session folder");
        default: {
            const exhaustive: never = failure;
            throw new Error(`unhandled session folder failure: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * The route `POST {A}/report-sessions/:threadId/access`: a new page grant for one report session, and the URL that
 * opens its page. It mints only when `report-sessions/{threadId}/index.html` is a file inside the session folder,
 * thus a client opens a page and never a 404 body. It needs no harness runtime.
 */
export function reportSessionAccessRoutes(grants: PageGrantStore): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.post("/:threadId/access", async (c) => {
        const analysisId = c.req.param("analysisId") ?? "";
        const threadId = c.req.param("threadId") ?? "";
        if (!isSafeId(threadId)) {
            return apiError(c, "validation_error", "`threadId` must be one name of a thread.", {
                formErrors: [],
                fieldErrors: { threadId: ["Not a thread id."] },
            });
        }
        holdConnection(c);

        const folder = await locateSessionFolder(analysisId, threadId);
        if (folder.isErr()) {
            switch (folder.error.type) {
                case "workspace":
                    return folder.error.error.type === "workspace_unavailable"
                        ? apiError(c, "conflict", folder.error.error.message)
                        : internalError(c, folder.error.error, "locate the workspace");
                case "absent":
                case "moved":
                    return noPage(c);
                case "io_failed":
                    return internalError(c, folder.error.cause, "read the session folder");
                default: {
                    const exhaustive: never = folder.error;
                    throw new Error(`unhandled session folder failure: ${JSON.stringify(exhaustive)}`);
                }
            }
        }

        const verdict = await classifyRealPath([folder.value], join(folder.value.text, "index.html"));
        if (verdict.isErr()) return internalError(c, verdict.error.cause, "read the report page");
        if (verdict.value.type !== "in") return noPage(c);
        const facts = await ResultAsync.fromPromise(stat(verdict.value.realPath), (cause) => cause);
        if (facts.isErr()) {
            const code = errnoCode(facts.error);
            return code === "ENOENT" || code === "ENOTDIR" ? noPage(c) : internalError(c, facts.error, "read the report page");
        }
        if (!facts.value.isFile()) return noPage(c);

        const { token, expiresAtMs } = grants.mint(analysisId, threadId);
        const answer: ReportSessionAccess = {
            url: buildReportSessionUrl(serverBaseUrl(listenerPort(c) ?? env.serverPort), analysisId, threadId, "index.html", token),
            expiresAt: new Date(expiresAtMs).toISOString(),
        };
        return c.json(answer);
    });

    return routes;
}
