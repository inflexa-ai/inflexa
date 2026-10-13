import { isAbsolute } from "node:path";

import {
    queryDataProfileStatusByAnalyses,
    queryLatestRunsByAnalyses,
    type AnalysisPurgeOutcome,
    type DataProfileSummary,
    type DbError as PgError,
    type LatestRunSummary,
    type Pool,
} from "@inflexa-ai/harness";
import type { BuiltinProvFormat } from "@inflexa-ai/tsprov";
import { Hono, type Context } from "hono";
import { err, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import PQueue from "p-queue";
import { z } from "zod";

import {
    describeBusyReason,
    type AnalysisDetail,
    type AnalysisLatestRun,
    type AnalysisProfileSummary,
    type AnalysisSort,
    type AnalysisSummary,
    type AnalysisView,
    type BusyReason,
    type DeleteAnalysisResponse,
    type DeleteExportOutcome,
    type InputsChange,
    type InputView,
    type OutputDirView,
    type ResolvedContextView,
    type UpdateAnalysisResponse,
} from "../../api/analyses.ts";
import { MAX_PER_PAGE } from "../../api/common.ts";
import type { DbError } from "../../db/errors.ts";
import { deleteAnalysis, updateAnalysisProject } from "../../db/primary_mutation.ts";
import {
    countAnalysisInputs,
    findAnalysesByRefWithAnchor,
    findProjectByRef,
    getAnalysis,
    listAnalysisInputPage,
    listAnalysisInputs,
    listAnalysisPage,
    listUsageTotalsByAnalysis,
} from "../../db/primary_query.ts";
import { releaseInstanceLock } from "../../lib/lock.ts";
import { getLogger } from "../../lib/log.ts";
import { pathsExistAsync } from "../../lib/fs.ts";
import { canonicalPathAsync } from "../../lib/paths.ts";
import { str256, type Str256 } from "../../lib/types.ts";
import { addInputs, applyInputsDiff, createAnalysis, removeInput, renameAnalysisAndMoveWorkspace } from "../../modules/analysis/analysis.ts";
import { describeContext, resolveContext, type ResolvedContext } from "../../modules/analysis/context.ts";
import { inputAbsolutePaths, matchInputRefs } from "../../modules/analysis/input.ts";
import { defaultOutputSubdir, disposeWorkspace, ensureOutputDir, locateExistingOutputDir, resolveOutputDir } from "../../modules/analysis/output.ts";
import { recoverAnchors, resolveAnchor } from "../../modules/anchor/anchor.ts";
import { analysisPurgeFor } from "../../modules/harness/purge.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { removeAnalysisFarm } from "../../modules/libs/composition.ts";
import { projectForAnalysis } from "../../modules/project/project.ts";
import { exportAnalysisProvenance } from "../../modules/prov/export.ts";
import { flushProvenanceAsync } from "../../modules/prov/prov.ts";
import { env } from "../../lib/env.ts";
import type { Analysis, AnalysisInput } from "../../types/analysis.ts";
import type { ServerBoot } from "../boot.ts";
import { busyReasonsOf, workspaceBusyReasons, type BusyFacts } from "../busy_gate.ts";
import { countLiveDurableWorkByAnalysis, type LiveDurableWork } from "../durable_work.ts";
import { profileWorkInFlight } from "../profile_queue.ts";
import { hasRunningTurn } from "../turns.ts";
import { apiError, holdConnection, internalError, listEnvelope, parsePage, readBody, requireRuntime, type ServerEnv } from "../http.ts";
import { toProjectView } from "./projects.ts";

/**
 * How many disk reads of one request run at one time: the existence checks of the paths of a body, and the
 * canonical paths of the inputs. A request names its paths, thus the width bounds what a client can ask for.
 */
const DISK_READ_WIDTH = 8;

/** {@link fn} over each item, in the order of `items`, with at most {@link DISK_READ_WIDTH} calls in flight. */
function mapBounded<T, U>(items: readonly T[], fn: (item: T) => Promise<U>): Promise<U[]> {
    const queue = new PQueue({ concurrency: DISK_READ_WIDTH });
    return Promise.all(items.map((item) => queue.add(() => fn(item))));
}

/** A path of a request body. The client resolves a relative path against its own folder, never the server. */
export const absolutePath = z.string().refine((path) => isAbsolute(path), "The path must be absolute.");

/** What the analysis routes do beyond SQLite and the disk: the busy gate and the steps of the delete. Tests replace each one. */
export type AnalysisRouteOpts = {
    readonly busyReasons: (analysisId: string, runtime: HarnessRuntime | null) => Promise<BusyReason[]>;
    /** Whether the analysis has a workspace folder on disk now. An unlocatable anchor folder reads as none. */
    readonly hasWorkspaceOnDisk: (analysis: Analysis) => Promise<boolean>;
    /** Drain the in-memory provenance appends into the stored chain. `false` when the flush could not run. */
    readonly flushProvenance: () => Promise<boolean>;
    /** Write the signed provenance document into the live workspace folder. `false` when nothing landed. */
    readonly exportProvenance: (analysis: Analysis, format: BuiltinProvFormat) => Promise<boolean>;
    readonly disposeWorkspace: typeof disposeWorkspace;
    /** Reclaim the Postgres footprint of the analysis. */
    readonly purgeAnalysis: (pool: Pool, analysisId: string) => ResultAsync<AnalysisPurgeOutcome, PgError>;
    /** Delete the SQLite row; its input refs cascade. */
    readonly deleteAnalysis: typeof deleteAnalysis;
    /** Remove the package farm of the analysis. A failure is swallowed: the orphan-farm reaper of `store reclaim` takes a farm that this misses. */
    readonly removeFarm: (analysisId: string) => Promise<void>;
    /** Remove one input ref and record the removal in the provenance chain. */
    readonly removeInput: typeof removeInput;
};

/** The production {@link AnalysisRouteOpts}. */
export const DEFAULT_ANALYSIS_ROUTE_OPTS: AnalysisRouteOpts = {
    busyReasons: (analysisId, runtime) => workspaceBusyReasons(analysisId, runtime),
    hasWorkspaceOnDisk: (analysis) =>
        locateExistingOutputDir(analysis).match(
            (dir) => dir !== null,
            () => false,
        ),
    flushProvenance: () =>
        ResultAsync.fromPromise(flushProvenanceAsync(), (cause) => cause).match(
            () => true,
            () => false,
        ),
    exportProvenance: (analysis, format) =>
        exportAnalysisProvenance(analysis, format, undefined).match(
            () => true,
            () => false,
        ),
    disposeWorkspace,
    // Through the per-pool memo: the booted pool outlives each delete, and an adapter for each delete would
    // leave handlers on it that nothing takes back off (see `analysisPurgeFor`).
    purgeAnalysis: (pool, analysisId) => analysisPurgeFor(pool).purgeAnalysis(analysisId),
    deleteAnalysis,
    removeFarm: async (analysisId) => {
        (await removeAnalysisFarm({ storeRoot: env.packageStoreDir, analysisId })).match(
            () => undefined,
            (e) => getLogger("server").warn({ err: e, analysisId }, "could not remove the farm of a deleted analysis"),
        );
    },
    removeInput,
};

/**
 * The reads of the list beyond SQLite: the grouped Postgres reads, the pending asks, the existence checks of the
 * folders, and the two in-memory facts of the busy rule. Tests replace each one.
 */
export type AnalysisListOpts = {
    /** The newest run of each analysis of the page. The error channel means the ledger is unreadable. */
    readonly latestRuns: (pool: Pool, analysisIds: string[]) => ResultAsync<LatestRunSummary[], unknown>;
    /** The profile state of each analysis of the page. The error channel means the ledger is unreadable. */
    readonly profiles: (pool: Pool, analysisIds: string[]) => ResultAsync<DataProfileSummary[], unknown>;
    /** The live durable work of each analysis of the page. The error channel means the ledger is unreadable. */
    readonly liveWork: (pool: Pool, analysisIds: string[]) => ResultAsync<Map<string, LiveDurableWork>, unknown>;
    /** Each pending ask of the runtime. It rejects on a failure. */
    readonly pendingAsks: (runtime: HarnessRuntime) => Promise<readonly { analysisId: string }[]>;
    /** Whether each path exists, in the order of `paths`, with at most `width` checks in flight. */
    readonly pathsExist: (paths: readonly string[], width: number) => Promise<boolean[]>;
    readonly hasRunningTurn: (analysisId: string) => boolean;
    readonly profileWorkInFlight: (analysisId: string) => boolean;
};

/** The production {@link AnalysisListOpts}. */
export const DEFAULT_ANALYSIS_LIST_OPTS: AnalysisListOpts = {
    latestRuns: queryLatestRunsByAnalyses,
    profiles: queryDataProfileStatusByAnalyses,
    liveWork: countLiveDurableWorkByAnalysis,
    pendingAsks: (runtime) => runtime.askGateway.pending(),
    pathsExist: pathsExistAsync,
    hasRunningTurn,
    profileWorkInFlight,
};

const sortQuery = z.enum(["activity", "created"] satisfies AnalysisSort[]);

const createBody = z.object({
    name: z.string(),
    folder: absolutePath,
    project: z.string().optional(),
    inputs: z.array(absolutePath).optional(),
});

const resolveBody = z.object({
    cwd: absolutePath,
    ref: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    recover: z.boolean().optional(),
    touch: z.boolean().optional(),
});

const patchBody = z.object({
    name: z.string().optional(),
    project: z.string().min(1).nullable().optional(),
});

const addPathsBody = z.object({ paths: z.array(absolutePath) });

/** A removal also matches the stored, anchor-relative `path` of an input, thus an input whose folder is gone stays removable. */
const removePathsBody = z.object({ paths: z.array(z.string().min(1)) });

const disposalQuery = z.enum(["keep", "delete"]);
const exportQuery = z.enum(["none", "prov-json", "prov-n"]);

/**
 * The routes under `/api/v1/analyses` that name no analysis (draft 2.2): the resolve of a folder or a
 * reference, the list, and the create. They read and write SQLite and the disk only.
 *
 * Mount them BEFORE the analysis guard: the guard pattern `/api/v1/analyses/:analysisId/*` also matches
 * `/resolve`, and a handler that answers first ends the chain.
 */
export function analysisCollectionRoutes(boot: ServerBoot, opts: AnalysisListOpts = DEFAULT_ANALYSIS_LIST_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.post("/resolve", async (c) => {
        const body = await readBody(c, resolveBody);
        if (body.isErr()) return body.error;
        const { cwd, ref, project, recover, touch } = body.value;
        // Recovery only, never creation (no-litter): an anchor whose folder moved under `cwd` heals in place.
        if (recover) {
            await recoverAnchors([cwd]).match(
                ({ recovered, unresolved }) => {
                    if (recovered || unresolved) getLogger("anchor").info({ recovered, unresolved }, "recovered anchors at a launch");
                },
                (e) => getLogger("anchor").warn({ err: e }, "anchor recovery failed"),
            );
        }
        const resolved = resolveContext(cwd, { analysis: ref, project }, { touch: touch ?? true }).andThen((ctx) =>
            ctx.kind === "analysis" && ref !== undefined
                ? // The same id-first, newest-first order as the resolve, thus row 0 is the resolved analysis.
                  findAnalysesByRefWithAnchor(ref).map((rows) => toContextView(ctx, rows[0]?.analysis.id === ref ? [] : rows.slice(1)))
                : ok<ResolvedContextView, DbError>(toContextView(ctx, [])),
        );
        return await resolved.match(
            (view) => c.json(view),
            (e) => internalError(c, e, "resolve the context"),
        );
    });

    routes.get("/", async (c) => {
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        // An empty value selects the default, the same as an empty `project`.
        const sortValue = c.req.query("sort");
        const sort = sortQuery.safeParse(sortValue === undefined || sortValue === "" ? "created" : sortValue);
        if (!sort.success) {
            return apiError(c, "validation_error", "`sort` must be `activity` or `created`.", { fieldErrors: { sort: ["must be activity or created"] } });
        }
        const projectRef = c.req.query("project");
        const project = projectRef === undefined || projectRef === "" ? ok(null) : findProjectByRef(projectRef);
        if (project.isErr()) return internalError(c, project.error, "resolve the project");
        if (projectRef && project.value === null) return apiError(c, "not_found", `No project found matching "${projectRef}".`);

        const listed = listAnalysisPage({ projectId: project.value?.id ?? null, sort: sort.data, limit: page.perPage, offset: page.page * page.perPage });
        if (listed.isErr()) return internalError(c, listed.error, "list the analyses");
        // One grouped ledger read for the page. A failed read leaves `usage` absent: a list that cannot show
        // figures is far better than no list.
        const ids = listed.value.items.map((item) => item.analysis.id);
        const usage = listUsageTotalsByAnalysis(ids).unwrapOr(null);
        const summaries = await summarizePage(
            ids,
            boot.runtime(),
            opts,
            listed.value.items.map((item) => item.anchorPath),
        );
        const items = listed.value.items.map((item, index): AnalysisSummary => {
            const totals = usage?.get(item.analysis.id);
            return {
                ...toAnalysisView(item.analysis),
                anchorPath: item.anchorPath,
                ...(totals === undefined ? {} : { usage: totals }),
                lastActivityAt: new Date(item.lastActivityAt).toISOString(),
                // `summarizePage` gives one summary for each id, in the order of `ids`.
                ...summaries[index]!,
            };
        });
        return c.json(listEnvelope("analyses", items, listed.value.total, page));
    });

    routes.post("/", async (c) => {
        const body = await readBody(c, createBody);
        if (body.isErr()) return body.error;
        const name = validName(c, body.value.name);
        if (name.isErr()) return name.error;

        let projectId: string | null = null;
        if (body.value.project !== undefined) {
            const project = findProjectByRef(body.value.project);
            if (project.isErr()) return internalError(c, project.error, "resolve the project");
            if (project.value === null) return apiError(c, "not_found", `No project found matching "${body.value.project}".`);
            projectId = project.value.id;
        }
        // Checked before the create: a missing input after the row lands would leave an analysis behind.
        const inputs = body.value.inputs ?? [];
        const missing = await refuseMissing(c, inputs);
        if (missing !== null) return missing;

        const created = await createAnalysis({ cwd: body.value.folder, name: name.value, inputPaths: inputs, projectId });
        if (created.isErr()) {
            const e = created.error;
            return e.type === "workspace_unavailable"
                ? apiError(c, "validation_error", e.message, { fieldErrors: { folder: [e.message] } })
                : internalError(c, e, "create an analysis");
        }
        return (await analysisDetail(created.value, null, DEFAULT_ANALYSIS_ROUTE_OPTS, { touch: false })).match(
            (detail) => c.json(detail, 201),
            (e) => internalError(c, e, "read the new analysis"),
        );
    });

    return routes;
}

/** The fields of {@link AnalysisSummary} that come from the disk, the runtime, and the busy rule. */
type PageSummary = Pick<AnalysisSummary, "folderPresent" | "profile" | "latestRun" | "pendingAsks" | "busy">;

/** One read of the runtime, as a value: the rows, or `null` for a read that failed. The failure goes to the log. */
function settled<T>(read: () => ResultAsync<T, unknown>, what: string): Promise<T | null> {
    return read().match(
        (value) => value,
        (cause) => {
            getLogger("server").warn({ err: cause }, `could not read ${what} for the list of analyses`);
            return null;
        },
    );
}

/**
 * The summary of each analysis of a page, in the order of `ids`. The runtime reads are one grouped statement
 * each, thus their count does not depend on the page size. Until the runtime is ready, the runtime fields are
 * `null` and the busy rule keeps the facts that the server knows without it. A read that fails leaves its field
 * `null` on each item, and the busy rule reads that state as unreadable, as the busy gate of `GET {A}` does.
 */
async function summarizePage(
    ids: string[],
    runtime: HarnessRuntime | null,
    opts: AnalysisListOpts,
    anchorPaths: readonly (string | null)[],
): Promise<PageSummary[]> {
    // The folders and the runtime reads start together.
    const present = existenceOf(anchorPaths, opts);
    const reads =
        runtime === null
            ? null
            : await Promise.all([
                  settled(() => opts.latestRuns(runtime.pool, ids), "the newest runs"),
                  settled(() => opts.profiles(runtime.pool, ids), "the data profiles"),
                  settled(() => opts.liveWork(runtime.pool, ids), "the live durable work"),
                  settled(() => ResultAsync.fromPromise(opts.pendingAsks(runtime), (cause) => cause), "the pending asks"),
              ]);
    const folderPresent = await present;

    const [runs, profiles, live, asks] = reads ?? [null, null, null, null];
    const runOf = new Map(runs?.map((run) => [run.analysisId, run]));
    const profileOf = new Map(profiles?.map((profile) => [profile.analysisId, profile]));
    const asksOf = new Map<string, number>();
    for (const ask of asks ?? []) asksOf.set(ask.analysisId, (asksOf.get(ask.analysisId) ?? 0) + 1);

    return ids.map((id, index): PageSummary => {
        const profile = profileOf.get(id);
        const run = runOf.get(id);
        const facts: BusyFacts = {
            turn: opts.hasRunningTurn(id),
            profileDrive: opts.profileWorkInFlight(id),
            profile: runtime === null ? "unknown" : profiles === null ? "unreadable" : profile?.status === "running" ? "running" : "idle",
            liveRuns: runtime === null ? "unknown" : live === null ? "unreadable" : (live.get(id)?.runs ?? 0),
        };
        return {
            // `existenceOf` gives one boolean for each anchor path, in the order of `ids`.
            folderPresent: folderPresent[index]!,
            profile: profile === undefined ? null : toProfileSummary(profile),
            latestRun: run === undefined ? null : toLatestRun(run),
            pendingAsks: asks === null ? null : (asksOf.get(id) ?? 0),
            busy: busyReasonsOf(facts),
        };
    });
}

/** Whether the anchor folder of each analysis exists, with a bounded width. A `null` path reads as absent. */
async function existenceOf(anchorPaths: readonly (string | null)[], opts: AnalysisListOpts): Promise<boolean[]> {
    const paths = anchorPaths.filter((path): path is string => path !== null);
    const exists = await opts.pathsExist(paths, DISK_READ_WIDTH);
    let next = 0;
    // `pathsExist` gives one boolean for each path that it got, in order, and `next` walks the non-null paths.
    return anchorPaths.map((path) => path !== null && exists[next++]!);
}

function toProfileSummary(profile: DataProfileSummary): AnalysisProfileSummary {
    return { status: profile.status, profiledFiles: profile.profiledFiles, completedAt: profile.completedAt };
}

function toLatestRun(run: LatestRunSummary): AnalysisLatestRun {
    return {
        runId: run.runId,
        status: run.status,
        planTitle: run.planTitle,
        doneSteps: run.doneSteps,
        totalSteps: run.totalSteps,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
    };
}

/**
 * The routes under `/api/v1/analyses/:analysisId` (draft 2.2): one analysis, its workspace folder, and its
 * inputs. Mount them AFTER the analysis guard, which gives 404 for an unknown id and takes the instance lock.
 */
export function analysisRoutes(boot: ServerBoot, opts: AnalysisRouteOpts = DEFAULT_ANALYSIS_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    // A GET is the open of the analysis, as the launch of a chat was: it records the sighting of the folder
    // and heals a moved one. The search for a moved folder starts in the folder of the client, the `cwd` query.
    // `touch=false` heals with no sighting: the poll of a chat reads the analysis at each tick, and a sighting
    // is a write of the anchor row.
    routes.get("/", async (c) => {
        const cwd = c.req.query("cwd");
        if (cwd !== undefined && !isAbsolute(cwd)) {
            return apiError(c, "validation_error", "`cwd` must be an absolute path.", { fieldErrors: { cwd: ["The path must be absolute."] } });
        }
        const touch = c.req.query("touch");
        if (touch !== undefined && touch !== "true" && touch !== "false") {
            return apiError(c, "validation_error", "`touch` must be `true` or `false`.", { fieldErrors: { touch: ["must be true or false"] } });
        }
        const analysis = loadAnalysis(c);
        if (analysis.isErr()) return analysis.error;
        return (
            await analysisDetail(analysis.value, boot.runtime(), opts, { touch: touch !== "false", searchRoots: cwd === undefined ? undefined : [cwd] })
        ).match(
            (detail) => c.json(detail),
            (e) => internalError(c, e, "read the analysis"),
        );
    });

    routes.patch("/", async (c) => {
        const body = await readBody(c, patchBody);
        if (body.isErr()) return body.error;
        const analysis = loadAnalysis(c);
        if (analysis.isErr()) return analysis.error;
        const a = analysis.value;

        // Each part is validated before the first write, thus a refused part changes nothing.
        let projectId: string | null | undefined;
        if (body.value.project === null) projectId = null;
        else if (body.value.project !== undefined) {
            const project = findProjectByRef(body.value.project);
            if (project.isErr()) return internalError(c, project.error, "resolve the project");
            if (project.value === null) return apiError(c, "not_found", `No project found matching "${body.value.project}".`);
            projectId = project.value.id;
        }
        let name: Str256 | undefined;
        if (body.value.name !== undefined) {
            const valid = validName(c, body.value.name);
            if (valid.isErr()) return valid.error;
            name = valid.value;
            const busy = await opts.busyReasons(a.id, boot.runtime());
            if (busy.length > 0) return apiError(c, "busy", `Cannot rename while ${describeBusyReason(busy[0]!)}.`, { reasons: busy });
        }

        let workspaceNotMoved: UpdateAnalysisResponse["workspaceNotMoved"];
        if (name !== undefined) {
            // The slug keys the workspace folder, thus the rename also moves `.inflexa/analyses/<old>/`.
            const renamed = await renameAnalysisAndMoveWorkspace(a, name);
            if (renamed.isErr()) return internalError(c, renamed.error, "rename the analysis");
            if (renamed.value.moveError !== undefined) {
                getLogger("server").warn({ err: renamed.value.moveError, analysisId: a.id }, "the rename could not move the workspace folder");
                workspaceNotMoved = { subdir: defaultOutputSubdir(a.slug) };
            }
        }
        if (projectId !== undefined) {
            const updated = updateAnalysisProject(a.id, projectId);
            if (updated.isErr()) return internalError(c, updated.error, "set the project of the analysis");
        }

        const after = getAnalysis(a.id);
        if (after.isErr()) return internalError(c, after.error, "read the analysis");
        if (after.value === null) return apiError(c, "not_found", "Analysis not found.");
        return (await analysisDetail(after.value, boot.runtime(), opts, { touch: false })).match(
            (detail) => c.json({ ...detail, ...(workspaceNotMoved === undefined ? {} : { workspaceNotMoved }) } satisfies UpdateAnalysisResponse),
            (e) => internalError(c, e, "read the analysis"),
        );
    });

    routes.delete("/", requireRuntime(boot), async (c) => {
        holdConnection(c);
        const disposalMode = disposalQuery.safeParse(c.req.query("workspace") ?? "keep");
        const exportFormat = exportQuery.safeParse(c.req.query("export") ?? "none");
        if (!disposalMode.success || !exportFormat.success) {
            return apiError(c, "validation_error", "`workspace` is keep or delete, and `export` is none, prov-json, or prov-n.");
        }
        const analysis = loadAnalysis(c);
        if (analysis.isErr()) return analysis.error;
        const busy = await opts.busyReasons(analysis.value.id, c.get("runtime"));
        if (busy.length > 0) return apiError(c, "busy", `Cannot delete while ${describeBusyReason(busy[0]!)}.`, { reasons: busy });
        return deleteLadder(c, analysis.value, disposalMode.data, exportFormat.data, c.get("runtime"), opts);
    });

    routes.post("/output-dir", async (c) => {
        const analysis = loadAnalysis(c);
        if (analysis.isErr()) return analysis.error;
        // An existing folder is given as it is: a folder that later went read-only must not block access to
        // the results that the user already has. Only an absent folder is made, which needs a writable anchor.
        return await locateExistingOutputDir(analysis.value)
            .andThen((existing) => (existing !== null ? okAsync(existing) : ensureOutputDir(analysis.value)))
            .match(
                (path) => c.json({ path } satisfies OutputDirView),
                (e) => (e.type === "workspace_unavailable" ? apiError(c, "conflict", e.message) : internalError(c, e, "make the workspace folder")),
            );
    });

    routes.get("/inputs", async (c) => {
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const analysisId = c.req.param("analysisId") ?? "";
        const listed = listAnalysisInputPage(analysisId, { limit: page.perPage, offset: page.page * page.perPage });
        if (listed.isErr()) return internalError(c, listed.error, "list the inputs");
        return c.json(listEnvelope("inputs", await inputViews(listed.value.items), listed.value.total, page));
    });

    routes.post("/inputs", async (c) => {
        const body = await readBody(c, addPathsBody);
        if (body.isErr()) return body.error;
        const missing = await refuseMissing(c, body.value.paths);
        if (missing !== null) return missing;
        const analysisId = c.req.param("analysisId") ?? "";
        // Each path is absolute, thus the folder that `addInputs` resolves a relative path against is never read.
        const added = await addInputs(analysisId, body.value.paths, "/");
        if (added.isErr()) return internalError(c, added.error, "add the inputs");
        return c.json({ added: await inputViews(added.value), removed: [], notInputs: [] } satisfies InputsChange);
    });

    routes.put("/inputs", async (c) => {
        const body = await readBody(c, addPathsBody);
        if (body.isErr()) return body.error;
        const analysisId = c.req.param("analysisId") ?? "";
        const current = listAnalysisInputs(analysisId);
        if (current.isErr()) return internalError(c, current.error, "read the inputs");

        // The diff runs in the canonical path space of the picker of a client. An input whose anchor folder
        // cannot be located has no absolute path, thus no client could show it, and the replacement keeps it.
        const absolute = await inputAbsolutePaths(current.value);
        const canonical = await mapBounded(body.value.paths, canonicalPathAsync);
        const wanted = new Set(canonical);
        const have = new Set([...absolute.values()].filter((p): p is string => p !== null));
        const toAdd = [...new Set(body.value.paths.filter((_, i) => !have.has(canonical[i] ?? "")))];
        const toRemove = current.value.filter((input) => {
            const abs = absolute.get(input) ?? null;
            return abs !== null && !wanted.has(abs);
        });
        const missing = await refuseMissing(c, toAdd);
        if (missing !== null) return missing;

        const outcome = await applyInputsDiff(analysisId, toAdd, toRemove, "/");
        const failure = outcome.failures[0];
        if (failure !== undefined) {
            getLogger("server").error({ err: failure.error, op: failure.op }, "an input change failed");
            return apiError(
                c,
                "internal_error",
                `The input ${failure.op === "add" ? "adds failed, thus nothing changed" : `removals failed after +${outcome.added.length} -${outcome.removed.length}`}.`,
            );
        }
        return c.json({ added: await inputViews(outcome.added), removed: await inputViews(outcome.removed), notInputs: [] } satisfies InputsChange);
    });

    routes.post("/inputs/remove", async (c) => {
        const body = await readBody(c, removePathsBody);
        if (body.isErr()) return body.error;
        const analysisId = c.req.param("analysisId") ?? "";
        const current = listAnalysisInputs(analysisId);
        if (current.isErr()) return internalError(c, current.error, "read the inputs");
        // A relative path matches a stored `path` only: no folder of the client is known here.
        const { matched, notInputs } = await matchInputRefs(current.value, body.value.paths, "/");
        const removed: AnalysisInput[] = [];
        const failed: AnalysisInput[] = [];
        // Each input is independent, thus a failed removal does not stop the removals after it.
        for (const target of matched) {
            const result = opts.removeInput(target);
            if (result.isErr()) {
                getLogger("server").error({ err: result.error, path: target.path }, "an input removal failed");
                failed.push(target);
            } else if (result.value !== null) {
                removed.push(result.value);
            }
        }
        if (failed.length > 0) {
            // Each removal that landed already emitted its provenance event, thus the message names them.
            const already = removed.length > 0 ? ` (removed: ${removed.map((i) => i.path).join(", ")})` : "";
            return apiError(c, "internal_error", `Failed to remove ${failed.map((i) => i.path).join(", ")}${already}.`);
        }
        return c.json({ added: [], removed: await inputViews(removed), notInputs } satisfies InputsChange);
    });

    return routes;
}

/** The wire form of an analysis row. */
function toAnalysisView(a: Analysis): AnalysisView {
    return {
        id: a.id,
        createdAt: new Date(a.createdAt).toISOString(),
        updatedAt: new Date(a.updatedAt).toISOString(),
        name: a.name,
        slug: a.slug,
        anchorId: a.anchorId,
        projectId: a.projectId,
    };
}

/** The wire form of a resolved context, with each candidate list capped at the newest {@link MAX_PER_PAGE}. */
function toContextView(ctx: ResolvedContext, others: { analysis: Analysis; anchorPath: string | null }[]): ResolvedContextView {
    const describe = describeContext(ctx);
    const views = (analyses: Analysis[]): AnalysisView[] => analyses.slice(0, MAX_PER_PAGE).map(toAnalysisView);
    switch (ctx.kind) {
        case "analysis":
            return {
                kind: "analysis",
                describe,
                analysis: toAnalysisView(ctx.analysis),
                anchorPath: ctx.anchorPath,
                others: others.slice(0, MAX_PER_PAGE).map((o) => ({ ...toAnalysisView(o.analysis), anchorPath: o.anchorPath })),
            };
        case "anchor":
            return { kind: "anchor", describe, anchorPath: ctx.anchorPath, analyses: views(ctx.analyses) };
        case "pick":
            return { kind: "pick", describe, analyses: views(ctx.analyses) };
        case "copy":
            return { kind: "copy", describe, cwd: ctx.cwd };
        case "empty":
            return { kind: "empty", describe, cwd: ctx.cwd };
        default: {
            const exhaustive: never = ctx;
            throw new Error(`unhandled context kind: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** The analysis of the path. The guard already gave 404 for an unknown id; a delete between the two gives 404 here. */
function loadAnalysis(c: Context<ServerEnv>): Result<Analysis, Response> {
    const found = getAnalysis(c.req.param("analysisId") ?? "");
    if (found.isErr()) return err(internalError(c, found.error, "read the analysis"));
    if (found.value === null) return err(apiError(c, "not_found", "Analysis not found."));
    return ok(found.value);
}

/** A name of 1 to 256 code points, trimmed, or the 400 `validation_error` response. */
function validName(c: Context<ServerEnv>, raw: string): Result<Str256, Response> {
    return str256(raw).mapErr((e) => {
        const reason = e === "empty" ? "must not be blank" : "must be at most 256 characters";
        return apiError(c, "validation_error", `Invalid analysis name: ${reason}.`, { fieldErrors: { name: [reason] } });
    });
}

/** The 400 `validation_error` response for the paths that do not exist, or `null` when each one exists. */
async function refuseMissing(c: Context<ServerEnv>, paths: readonly string[]): Promise<Response | null> {
    const exists = await pathsExistAsync(paths, DISK_READ_WIDTH);
    const missing = paths.filter((_, i) => !exists[i]);
    return missing.length === 0 ? null : apiError(c, "validation_error", `no such file: ${missing.join(", ")}`, { missing });
}

async function inputViews(inputs: readonly AnalysisInput[]): Promise<InputView[]> {
    const absolute = await inputAbsolutePaths(inputs);
    return inputs.map((input) => ({ path: input.path, isDir: input.isDir, anchorId: input.anchorId, absolutePath: absolute.get(input) ?? null }));
}

/**
 * One analysis with its scope. `touch` records a sighting of the anchor folder, as the open of an analysis
 * does. `searchRoots` are the folders where the search for a moved anchor folder starts.
 */
async function analysisDetail(
    analysis: Analysis,
    runtime: HarnessRuntime | null,
    opts: AnalysisRouteOpts,
    resolve: { touch: boolean; searchRoots?: string[] },
): Promise<Result<AnalysisDetail, DbError>> {
    const anchor = await resolveAnchor(analysis.anchorId, resolve);
    if (anchor.isErr()) return err(anchor.error);
    const inputCount = countAnalysisInputs(analysis.id);
    if (inputCount.isErr()) return err(inputCount.error);
    const project = projectForAnalysis(analysis);
    const outputDir = await resolveOutputDir(analysis).unwrapOr(null);
    const busy = await opts.busyReasons(analysis.id, runtime);
    const resolved = anchor.value;
    return ok({
        ...toAnalysisView(analysis),
        project: project === null ? null : toProjectView(project),
        anchor:
            resolved === null
                ? null
                : { id: resolved.anchor.id, path: resolved.path, cachedPath: resolved.anchor.cachedPath, markerWritten: resolved.anchor.markerWritten },
        outputDir,
        inputCount: inputCount.value,
        busy,
    });
}

/**
 * Delete an analysis: export its provenance, retire its workspace folder, reclaim its Postgres footprint,
 * and only then delete the row. Each step sits where its failure leaves the delete RETRYABLE instead of
 * half-done, and the order is what makes that true:
 *
 * - The SQLite row dies LAST because it holds the only copy of the analysis id, and the purge needs that
 *   id. A row deleted first strands the whole Postgres footprint beyond the reach of any retry, while it
 *   reports success.
 * - The purge follows the disposal because the folder move is the step that realistically fails
 *   (permissions, an open handle), so a failure there touches no store at all. It runs for both modes:
 *   the mode governs the folder, while Postgres holds the same class of state the row does.
 * - The export precedes the disposal because it writes into the LIVE workspace folder. After a disposal
 *   that path is gone, and an export would make `analyses/<slug>/` again with a single file in it. For the
 *   same reason it runs only when the folder already exists: a delete must not make anything.
 * - The flush precedes the export because the serializer reads the stored chain, not the memory of the
 *   recorder, and a delete right after work in the analysis is when the tail is still unwritten.
 *
 * A failed flush or export is stepped over: the user asked to delete the analysis, not to export
 * provenance. A failed disposal or purge stops with the row intact, and the message says that nothing
 * was lost, because a new delete archives an already-moved folder as `absent` and the purge is idempotent.
 */
async function deleteLadder(
    c: Context<ServerEnv>,
    a: Analysis,
    mode: "keep" | "delete",
    exportFormat: "none" | "prov-json" | "prov-n",
    runtime: HarnessRuntime,
    opts: AnalysisRouteOpts,
): Promise<Response> {
    let exportOutcome: DeleteExportOutcome = "none";
    if (mode === "keep" && exportFormat !== "none" && (await opts.hasWorkspaceOnDisk(a))) {
        const flushed = await opts.flushProvenance();
        const exported = await opts.exportProvenance(a, exportFormat === "prov-json" ? "json" : "provn");
        exportOutcome = !exported ? "failed" : flushed ? "written" : "written_unflushed";
    }

    const disposed = await opts.disposeWorkspace(a, mode === "keep" ? "archive" : "delete");
    if (disposed.isErr()) {
        const e = disposed.error;
        if (e.type === "workspace_unavailable") return apiError(c, "conflict", e.message);
        getLogger("server").error({ err: e, analysisId: a.id }, "could not retire the workspace folder");
        return apiError(c, "internal_error", `Could not retire the workspace folder (${e.type}) — the analysis was NOT deleted, so nothing was lost.`);
    }
    const workspace = disposed.value;

    const purged = await opts.purgeAnalysis(runtime.pool, a.id);
    if (purged.isErr()) {
        // The disposal already ran, so this is the LAST moment the archive path is known: a retry finds no
        // folder at the live location and reports `absent`.
        getLogger("server").error({ err: purged.error, analysisId: a.id }, "could not purge the analysis");
        const kept = workspace.kind === "archived" ? ` Its files are already at ${workspace.path}.` : "";
        return apiError(
            c,
            "internal_error",
            `Could not reclaim this analysis's stored conversations and run history (${purged.error.type} at ${purged.error.op}) — the analysis was NOT deleted, so nothing was lost.${kept} Try the delete again.`,
        );
    }

    const deleted = opts.deleteAnalysis(a.id);
    if (deleted.isErr()) {
        getLogger("server").error({ err: deleted.error, analysisId: a.id }, "could not delete the analysis row");
        return apiError(c, "internal_error", `Workspace and stored data were retired, but the analysis row could not be deleted (${deleted.error.type}).`);
    }
    if (deleted.value === 0) return apiError(c, "not_found", "Analysis not found.");

    // The farm dies with its analysis. The busy gate already showed that no live work holds it.
    void opts.removeFarm(a.id);
    // No later request can name the analysis, thus its lock goes now, not at exit.
    releaseInstanceLock(a.id);
    return c.json({ deleted: true, workspace, export: exportOutcome } satisfies DeleteAnalysisResponse);
}
