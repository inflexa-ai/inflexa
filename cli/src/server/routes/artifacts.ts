import { queryArtifactPage, type ArtifactPage, type ArtifactPageQuery, type DbError, type Pool } from "@inflexa-ai/harness";
import { Hono } from "hono";
import { join } from "node:path";
import type { ResultAsync } from "neverthrow";
import PQueue from "p-queue";
import { z } from "zod";

import type {
    ArtifactEntry,
    ArtifactError,
    ArtifactExtensionCount,
    ArtifactList,
    ArtifactSort,
    ResolvedArtifact,
    ResolvedArtifacts,
} from "../../api/artifacts.ts";
import { getLogger } from "../../lib/log.ts";
import { locateWorkspaceReadRoot } from "../../modules/analysis/boundary.ts";
import { entryDegraded, materializeTarget, resolveEntryPath, workspaceFileResolvable, type OpenArtifactError } from "../../modules/harness/artifact_open.ts";
import type { OpenTarget } from "../../types/session.ts";
import type { ServerBoot } from "../boot.ts";
import { apiError, filterValue, internalError, listEnvelope, parsePage, readBody, requireRuntime, type ServerEnv } from "../http.ts";

/** The harness mints each presentation id as `pres-` and a hex digest. The id names a file in the workspace, thus nothing else passes. */
const presId = z.string().regex(/^pres-[A-Za-z0-9_-]+$/, "A presentation id is `pres-` and a digest.");

const openTarget = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("workspace-file"), path: z.string() }),
    z.object({ kind: z.literal("echart"), presId, spec: z.record(z.string(), z.unknown()), dataPath: z.string().optional() }),
    z.object({ kind: z.literal("svg"), presId, markup: z.string() }),
    z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);

const resolveBody = z.object({
    entries: z.array(openTarget).max(1000),
    materialize: z.boolean(),
});

const sortQuery = z.enum(["path", "recent"] satisfies ArtifactSort[]);

/** The harness read that the list route calls. A test replaces it, because it needs Postgres. */
export type ArtifactRoutesOpts = {
    /** One page of the artifact ledger of the analysis, and the count of the rows that the filters select. */
    readonly listArtifacts: (pool: Pool, analysisId: string, query: ArtifactPageQuery) => ResultAsync<ArtifactPage, DbError>;
};

/** The production {@link ArtifactRoutesOpts}. */
export const DEFAULT_ARTIFACT_ROUTES_OPTS: ArtifactRoutesOpts = { listArtifacts: queryArtifactPage };

/**
 * The members of the `extension` query value: a list with a comma between the members. The harness compares
 * each member as it is, thus the lower case and the trim happen here, where the input enters. An empty member is
 * dropped, and a value with no member gives no filter.
 */
function parseExtensions(value: string | undefined): string[] {
    if (value === undefined) return [];
    return value
        .split(",")
        .map((member) => member.trim().toLowerCase())
        .filter((member) => member !== "");
}

/** How many entries of one request resolve at one time. Each entry reads the disk, and the body caps the entries at 1000. */
const RESOLVE_WIDTH = 8;

/**
 * The routes under `{A}/artifacts`.
 *
 * `GET /` lists the artifact ledger of the analysis, one page for each request. It needs the harness runtime.
 * `runId`, `stepId`, `fileType`, `path` (an exact path), `q` (a part of the path), and `extension` (a list with
 * a comma between the members) combine with AND. The response adds `extensionCounts` for the selected rows.
 * The cost of a request grows with the ledger of the one analysis, because the exact `total` reads each
 * filtered row. Each entry gets `absolutePath`: the canonical workspace root, located one time for each
 * request, joined with its relative `path`. It is `null` for each entry when the folder cannot be located.
 *
 * `POST /resolve` (draft 2.5) gives the path on disk and the degraded mark of each openable entry of a card.
 * With `materialize`, it first writes the echart or svg file of each entry into the `presentations/` folder
 * of the workspace. The client opens the path, because the desktop opener runs on the machine of the client.
 * It reads SQLite and the disk only, thus it needs no runtime.
 */
export function artifactRoutes(boot: ServerBoot, opts: ArtifactRoutesOpts = DEFAULT_ARTIFACT_ROUTES_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.get("/", requireRuntime(boot), async (c) => {
        const analysisId = c.req.param("analysisId") ?? "";
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const sort = sortQuery.safeParse(filterValue(c.req.query("sort")) ?? "path");
        if (!sort.success) {
            return apiError(c, "validation_error", "`sort` must be `path` or `recent`.", { fieldErrors: { sort: ["must be path or recent"] } });
        }
        const runId = filterValue(c.req.query("runId"));
        const stepId = filterValue(c.req.query("stepId"));
        const fileType = filterValue(c.req.query("fileType"));
        const q = filterValue(c.req.query("q"));
        const path = filterValue(c.req.query("path"));
        const extensions = parseExtensions(filterValue(c.req.query("extension")));
        const query: ArtifactPageQuery = {
            ...(runId === undefined ? {} : { runId }),
            ...(stepId === undefined ? {} : { stepId }),
            ...(fileType === undefined ? {} : { fileType }),
            ...(q === undefined ? {} : { q }),
            ...(path === undefined ? {} : { path }),
            ...(extensions.length === 0 ? {} : { extensions }),
            sort: sort.data,
            limit: page.perPage,
            offset: page.page * page.perPage,
        };
        // One lookup of the root for the request, in parallel with the ledger read. A workspace folder that
        // the server cannot locate is a normal state of the database and the folders, thus it gives `null`
        // paths and not an error.
        const pendingList = opts.listArtifacts(c.get("runtime").pool, analysisId, query);
        const pendingRoot = locateWorkspaceReadRoot(analysisId);
        const listed = await pendingList;
        const root = await pendingRoot;
        if (listed.isErr()) return internalError(c, listed.error, "list the artifacts");
        if (root.isErr()) return internalError(c, root.error, "locate the workspace folder");
        const base = root.value;
        const entries = listed.value.entries.map((entry): ArtifactEntry => ({
            ...entry,
            absolutePath: base === null ? null : join(base.canonical, entry.path),
        }));
        const extensionCounts = listed.value.extensionCounts.map((count): ArtifactExtensionCount => ({ ...count }));
        return c.json<ArtifactList>({ ...listEnvelope("artifacts", entries, listed.value.total, page), extensionCounts });
    });

    routes.post("/resolve", async (c) => {
        const body = await readBody(c, resolveBody);
        if (body.isErr()) return body.error;
        const analysisId = c.req.param("analysisId") ?? "";
        const queue = new PQueue({ concurrency: RESOLVE_WIDTH });
        const entries = await Promise.all(body.value.entries.map((target) => queue.add(() => resolveArtifact(analysisId, target, body.value.materialize))));
        return c.json({ entries } satisfies ResolvedArtifacts);
    });

    return routes;
}

async function resolveArtifact(analysisId: string, target: OpenTarget, materialize: boolean): Promise<ResolvedArtifact> {
    // A card reference is analysis-rooted. A stored part that reloads from a persisted tool call skips the
    // validation of the live tool, thus a path that leaves the workspace, also through a symbolic link, degrades here and resolves nowhere.
    if (target.kind === "workspace-file" && !(await workspaceFileResolvable(analysisId, target.path))) {
        return {
            kind: target.kind,
            path: null,
            degraded: true,
            ...(materialize ? { error: { type: "unavailable", reason: "the path is not inside the analysis" } } : {}),
        };
    }
    const path = await resolveEntryPath(analysisId, target);
    const degraded = await entryDegraded(analysisId, target);
    if (!materialize) return { kind: target.kind, path, degraded };
    return (await materializeTarget(analysisId, target)).match(
        (ready): ResolvedArtifact => ({ kind: target.kind, path: ready, degraded }),
        (e): ResolvedArtifact => ({ kind: target.kind, path, degraded, error: toArtifactError(e) }),
    );
}

function toArtifactError(e: OpenArtifactError): ArtifactError {
    switch (e.type) {
        case "unresolved":
            return { type: "unresolved" };
        case "missing":
            return { type: "missing", path: e.path };
        case "materialize_failed":
            getLogger("server").error({ err: e.cause }, "could not write a presentation file");
            return { type: "materialize_failed" };
        case "unavailable":
            return { type: "unavailable", reason: e.reason };
        default: {
            const exhaustive: never = e;
            throw new Error(`unhandled artifact error: ${JSON.stringify(exhaustive)}`);
        }
    }
}
