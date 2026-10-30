import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import type { AnalysisPurgeOutcome, DataProfileSummary, DbError as PgError, LatestRunSummary, Pool } from "@inflexa-ai/harness";

import type {
    AnalysisDetail,
    AnalysisList,
    BusyReason,
    DeleteAnalysisResponse,
    InputList,
    InputsChange,
    OutputDirView,
    ResolvedContextView,
    UpdateAnalysisResponse,
} from "../../api/analyses.ts";
import type { ApiError } from "../../api/common.ts";
import type { ServerBootState } from "../../api/server.ts";
import { createProject, insertAnalysis, insertAnalysisInput, insertAnchor, recordAnalysisActivity, upsertLlmUsage } from "../../db/primary_mutation.ts";
import { getAnalysis, getAnchor, listAnalysisInputs } from "../../db/primary_query.ts";
import { Bus } from "../../lib/bus.ts";
import { instanceLockPath } from "../../lib/lock.ts";
import { asStr256 } from "../../lib/types.ts";
import { defaultOutputSubdir, disposeWorkspace, type WorkspaceDisposal, type WorkspaceError } from "../../modules/analysis/output.ts";
import { removeInput } from "../../modules/analysis/analysis.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { BusEvent } from "../../types/events.ts";
import { freshDb } from "../../test_support/db.ts";
import { idleBoot, idleLifecycle } from "../../test_support/server.ts";
import { buildApp } from "../app.ts";
import type { ServerBoot } from "../boot.ts";
import type { ServerEnv } from "../http.ts";
import { createPageGrantStore } from "../report_page_grants.ts";
import {
    analysisCollectionRoutes,
    analysisRoutes,
    DEFAULT_ANALYSIS_LIST_OPTS,
    DEFAULT_ANALYSIS_ROUTE_OPTS,
    type AnalysisListOpts,
    type AnalysisRouteOpts,
} from "./analyses.ts";

// The routes under their mount paths, with no bearer check and no guard, except the guard tests, which drive
// the whole app. Each `as` cast of a body below reads JSON that the route under test builds from the same
// `src/api/` type. The Postgres purge and the busy gate are fakes: the gate reads the turn registry, the
// profile queue, and Postgres.

const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;
// The delete only passes the pool to the injected purge, thus a stand-in object is enough.
const runtime = { pool: {} as unknown as Pool } as unknown as HarnessRuntime;
const readyBoot: ServerBoot = {
    state: (): ServerBootState => ({ ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "m" } }),
    runtime: () => runtime,
    start: async () => undefined,
};

const IDLE: AnalysisRouteOpts = { ...DEFAULT_ANALYSIS_ROUTE_OPTS, busyReasons: async () => [] };

function appWith(boot: ServerBoot, opts: AnalysisRouteOpts = IDLE, listOpts: AnalysisListOpts = DEFAULT_ANALYSIS_LIST_OPTS): Hono<ServerEnv> {
    const app = new Hono<ServerEnv>();
    app.route("/api/v1/analyses", analysisCollectionRoutes(boot, listOpts));
    app.route("/api/v1/analyses/:analysisId", analysisRoutes(boot, opts));
    return app;
}

function json(method: string, body: unknown): RequestInit {
    return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const created: string[] = [];

/** A real folder under its physical path, so its canonical form equals the stored anchor path. */
function tmp(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-routes-")));
    created.push(dir);
    return dir;
}

/** A tracked folder with its marker and an analysis homed in it. */
async function seedAnalysis(dir: string, name = "Alpha", over: Partial<Analysis> = {}): Promise<Analysis> {
    const anchorId = randomUUIDv7();
    (await writeMarker(dir, anchorId))._unsafeUnwrap();
    insertAnchor({ id: anchorId, createdAt: 1, updatedAt: 1, cachedPath: dir, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    return insertAnalysis({
        id: randomUUIDv7(),
        createdAt: 1,
        updatedAt: 1,
        name: asStr256(name),
        slug: name.toLowerCase(),
        anchorId,
        projectId: null,
        ...over,
    })._unsafeUnwrap();
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("POST /api/v1/analyses/resolve", () => {
    test("a tracked folder with one analysis resolves to it, with the folder and the loud context line", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        const response = await appWith(idleBoot()).request("/api/v1/analyses/resolve", json("POST", { cwd: dir }));
        expect(response.status).toBe(200);
        const view = (await response.json()) as ResolvedContextView;
        expect(view).toMatchObject({ kind: "analysis", anchorPath: dir, others: [], analysis: { id: a.id, name: "Alpha" } });
        expect(view.describe).toBe(`context: analysis "Alpha" — ${dir}`);
    });

    test("a reference by name names the other analyses that share the name", async () => {
        const firstDir = tmp();
        const first = await seedAnalysis(firstDir, "Same");
        const second = await seedAnalysis(tmp(), "Same", { createdAt: 2 });
        const view = (await (
            await appWith(idleBoot()).request("/api/v1/analyses/resolve", json("POST", { cwd: tmp(), ref: "Same" }))
        ).json()) as ResolvedContextView;
        expect(view.kind).toBe("analysis");
        if (view.kind !== "analysis") return;
        expect(view.analysis.id).toBe(second.id);
        expect(view.others.map((a) => [a.id, a.anchorPath])).toEqual([[first.id, firstDir]]);
    });

    test("`touch: false` records no sighting of the anchor folder; the default does", async () => {
        const a = await seedAnalysis(tmp());
        await appWith(idleBoot()).request("/api/v1/analyses/resolve", json("POST", { cwd: tmp(), ref: a.id, touch: false }));
        expect(getAnchor(a.anchorId)._unsafeUnwrap()?.lastSeen).toBe(1);

        await appWith(idleBoot()).request("/api/v1/analyses/resolve", json("POST", { cwd: tmp(), ref: a.id }));
        expect(getAnchor(a.anchorId)._unsafeUnwrap()?.lastSeen).toBeGreaterThan(1);
    });

    test("an untracked folder resolves to `empty`, and a relative cwd is a 400", async () => {
        const dir = tmp();
        const empty = (await (await appWith(idleBoot()).request("/api/v1/analyses/resolve", json("POST", { cwd: dir }))).json()) as ResolvedContextView;
        expect(empty).toEqual({ kind: "empty", cwd: dir, describe: `context: empty — ${dir} (no analysis here; start one?)` });

        const relative = await appWith(idleBoot()).request("/api/v1/analyses/resolve", json("POST", { cwd: "here" }));
        expect(relative.status).toBe(400);
        expect(((await relative.json()) as ApiError).error).toBe("validation_error");
    });
});

describe("GET /api/v1/analyses", () => {
    test("pages the analyses newest first, with the cached folder and the usage of each one", async () => {
        const dir = tmp();
        const older = await seedAnalysis(dir, "Older", { createdAt: 1 });
        const newer = await seedAnalysis(tmp(), "Newer", { createdAt: 2 });
        upsertLlmUsage({
            recordKey: "k1",
            recordedAt: 1,
            agentId: "conversation",
            callPath: "conversation",
            scopeKind: "analysis",
            scopeId: older.id,
            usage: { inputTokens: 10, outputTokens: 5 },
        })._unsafeUnwrap();

        const first = (await (await appWith(idleBoot()).request("/api/v1/analyses?perPage=1")).json()) as AnalysisList;
        expect(first.analyses.map((a) => a.id)).toEqual([newer.id]);
        expect(first).toMatchObject({ total: 2, page: 0, perPage: 1, hasMore: true });

        const second = (await (await appWith(idleBoot()).request("/api/v1/analyses?page=1&perPage=1")).json()) as AnalysisList;
        expect(second.analyses[0]).toMatchObject({ id: older.id, anchorPath: dir, usage: { calls: 1, inputTokens: 10 } });
    });

    test("narrows to a project by name, and an unknown project is a 404", async () => {
        const project = createProject({ name: asStr256("Liver"), description: null, tags: [] })._unsafeUnwrap();
        const inProject = await seedAnalysis(tmp(), "In", { projectId: project.id });
        await seedAnalysis(tmp(), "Out");

        const list = (await (await appWith(idleBoot()).request("/api/v1/analyses?project=Liver")).json()) as AnalysisList;
        expect(list.analyses.map((a) => a.id)).toEqual([inProject.id]);

        const unknown = await appWith(idleBoot()).request("/api/v1/analyses?project=nope");
        expect(unknown.status).toBe(404);
        expect(((await unknown.json()) as ApiError).message).toBe('No project found matching "nope".');
    });
});

/** The list reads with no work to report. A test replaces the reads that it is about. */
function listOptsOf(over: Partial<AnalysisListOpts> = {}): AnalysisListOpts {
    return {
        ...DEFAULT_ANALYSIS_LIST_OPTS,
        latestRuns: () => okAsync([]),
        profiles: () => okAsync([]),
        liveWork: () => okAsync(new Map()),
        pendingAsks: async () => [],
        hasRunningTurn: () => false,
        profileWorkInFlight: () => false,
        ...over,
    };
}

async function listOf(boot: ServerBoot, listOpts: AnalysisListOpts, query = ""): Promise<{ status: number; list: AnalysisList }> {
    const response = await appWith(boot, IDLE, listOpts).request(`/api/v1/analyses${query}`);
    return { status: response.status, list: (await response.json()) as AnalysisList };
}

function runOf(analysisId: string, over: Partial<LatestRunSummary> = {}): LatestRunSummary {
    return {
        analysisId,
        runId: `run-${analysisId}`,
        status: "running",
        planTitle: "Differential expression",
        doneSteps: 2,
        totalSteps: 5,
        startedAt: "2026-10-05T10:00:00.000Z",
        completedAt: null,
        ...over,
    };
}

describe("GET /api/v1/analyses: the summary of each analysis", () => {
    test("`sort=activity` puts the analysis with the newest activity first, and the default stays the created order", async () => {
        const older = await seedAnalysis(tmp(), "Older", { createdAt: 1_000, updatedAt: 1_000 });
        const newer = await seedAnalysis(tmp(), "Newer", { createdAt: 2_000, updatedAt: 2_000 });
        recordAnalysisActivity(older.id, 9_000)._unsafeUnwrap();

        const byActivity = await listOf(idleBoot(), listOptsOf(), "?sort=activity");
        expect(byActivity.list.analyses.map((a) => a.id)).toEqual([older.id, newer.id]);
        expect(byActivity.list.analyses.map((a) => a.lastActivityAt)).toEqual([new Date(9_000).toISOString(), new Date(2_000).toISOString()]);

        for (const query of ["", "?sort=created", "?sort="]) {
            expect((await listOf(idleBoot(), listOptsOf(), query)).list.analyses.map((a) => a.id)).toEqual([newer.id, older.id]);
        }
    });

    test("a `sort` value that is not activity or created is a 400 with a field error under `sort`", async () => {
        const response = await appWith(idleBoot()).request("/api/v1/analyses?sort=name");

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error", details: { fieldErrors: { sort: [expect.any(String)] } } });
    });

    test("`sort=activity` keeps the project filter", async () => {
        const project = createProject({ name: asStr256("Liver"), description: null, tags: [] })._unsafeUnwrap();
        const inProject = await seedAnalysis(tmp(), "In", { projectId: project.id });
        await seedAnalysis(tmp(), "Out");

        const { list } = await listOf(idleBoot(), listOptsOf(), "?sort=activity&project=Liver");

        expect(list.analyses.map((a) => a.id)).toEqual([inProject.id]);
    });

    test("until the phase is ready, the runtime fields are null, the SQLite fields stay, and the busy rule keeps what it knows", async () => {
        const a = await seedAnalysis(tmp(), "Alpha");
        let runtimeReads = 0;
        const count = () => {
            runtimeReads += 1;
            return okAsync([]);
        };
        const listOpts = listOptsOf({ latestRuns: count, profiles: count, hasRunningTurn: () => true, profileWorkInFlight: () => true });

        const { status, list } = await listOf(idleBoot(), listOpts);

        expect(status).toBe(200);
        expect(list.analyses[0]).toMatchObject({
            id: a.id,
            lastActivityAt: new Date(1).toISOString(),
            folderPresent: true,
            profile: null,
            latestRun: null,
            pendingAsks: null,
            busy: ["chat_turn", "data_profile"],
        });
        expect(runtimeReads).toBe(0);
    });

    test("a ready server gives the profile, the newest run, the asks, and the busy reasons of each analysis", async () => {
        const live = await seedAnalysis(tmp(), "Live", { createdAt: 2 });
        const idle = await seedAnalysis(tmp(), "Idle", { createdAt: 1 });
        const listOpts = listOptsOf({
            latestRuns: () => okAsync([runOf(live.id)]),
            profiles: () =>
                okAsync<DataProfileSummary[]>([{ analysisId: live.id, status: "completed", completedAt: "2026-10-04T10:00:00.000Z", profiledFiles: 12 }]),
            liveWork: () => okAsync(new Map([[live.id, { runs: 1, profiles: 0, turns: 0 }]])),
            pendingAsks: async () => [{ analysisId: live.id }, { analysisId: live.id }, { analysisId: "someone-else" }],
        });

        const { list } = await listOf(readyBoot, listOpts);

        const [first, second] = list.analyses;
        expect(first).toMatchObject({
            id: live.id,
            profile: { status: "completed", profiledFiles: 12, completedAt: "2026-10-04T10:00:00.000Z" },
            latestRun: {
                runId: `run-${live.id}`,
                status: "running",
                planTitle: "Differential expression",
                doneSteps: 2,
                totalSteps: 5,
                startedAt: "2026-10-05T10:00:00.000Z",
                completedAt: null,
            },
            pendingAsks: 2,
            busy: ["run"],
        });
        expect(second).toMatchObject({ id: idle.id, profile: null, latestRun: null, pendingAsks: 0, busy: [] });
    });

    test("a running profile row reads as busy `data_profile`, as `GET {A}` does", async () => {
        const a = await seedAnalysis(tmp(), "Alpha");
        const listOpts = listOptsOf({
            profiles: () => okAsync<DataProfileSummary[]>([{ analysisId: a.id, status: "running", completedAt: null, profiledFiles: null }]),
        });

        const { list } = await listOf(readyBoot, listOpts);

        expect(list.analyses[0]).toMatchObject({ profile: { status: "running", profiledFiles: null, completedAt: null }, busy: ["data_profile"] });
    });

    test("a failed newest-run read leaves `latestRun` null and fails nothing", async () => {
        await seedAnalysis(tmp(), "Alpha");

        const { status, list } = await listOf(readyBoot, listOptsOf({ latestRuns: () => errAsync(new Error("boom")) }));

        expect(status).toBe(200);
        expect(list.analyses[0]).toMatchObject({ latestRun: null, busy: [] });
    });

    test("a failed profile read leaves `profile` null and adds `profile_state_unreadable`", async () => {
        await seedAnalysis(tmp(), "Alpha");

        const { status, list } = await listOf(readyBoot, listOptsOf({ profiles: () => errAsync(new Error("boom")) }));

        expect(status).toBe(200);
        expect(list.analyses[0]).toMatchObject({ profile: null, busy: ["profile_state_unreadable"] });
    });

    test("a failed live-work read adds `run_state_unreadable`", async () => {
        await seedAnalysis(tmp(), "Alpha");

        const { status, list } = await listOf(readyBoot, listOptsOf({ liveWork: () => errAsync(new Error("boom")) }));

        expect(status).toBe(200);
        expect(list.analyses[0]).toMatchObject({ busy: ["run_state_unreadable"] });
    });

    test("a rejected `askGateway.pending()` gives 200 with `pendingAsks` null on each item", async () => {
        await seedAnalysis(tmp(), "One", { createdAt: 1 });
        await seedAnalysis(tmp(), "Two", { createdAt: 2 });

        const { status, list } = await listOf(
            readyBoot,
            listOptsOf({
                pendingAsks: () => Promise.reject(new Error("the ask ledger is down")),
            }),
        );

        expect(status).toBe(200);
        expect(list.analyses.map((a) => a.pendingAsks)).toEqual([null, null]);
    });

    test("`folderPresent` is true for a folder on disk and false for a missing path", async () => {
        const present = await seedAnalysis(tmp(), "Here", { createdAt: 2 });
        const gone = tmp();
        const missing = await seedAnalysis(gone, "Gone", { createdAt: 1 });
        rmSync(gone, { recursive: true, force: true });

        const { list } = await listOf(idleBoot(), listOptsOf());

        expect(list.analyses.map((a) => [a.id, a.folderPresent])).toEqual([
            [present.id, true],
            [missing.id, false],
        ]);
    });

    test("the count of the reads does not depend on the page size", async () => {
        // Distinct activity times in an order that differs from the creation order: 7 and 25 share no factor.
        const activity = new Map<string, number>();
        for (let i = 0; i < 25; i++) {
            const a = await seedAnalysis(tmp(), `A${i}`, { createdAt: i + 1 });
            const at = 10_000 + ((i * 7) % 25);
            recordAnalysisActivity(a.id, at)._unsafeUnwrap();
            activity.set(a.id, at);
        }
        const newestByActivity = [...activity].sort((x, y) => y[1] - x[1]).map(([id]) => id);
        const reads = { runs: 0, profiles: 0, live: 0, asks: 0, paths: 0 };
        const listOpts = listOptsOf({
            latestRuns: () => {
                reads.runs += 1;
                return okAsync([]);
            },
            profiles: () => {
                reads.profiles += 1;
                return okAsync([]);
            },
            liveWork: () => {
                reads.live += 1;
                return okAsync(new Map());
            },
            pendingAsks: async () => {
                reads.asks += 1;
                return [];
            },
            pathsExist: (paths, width) => {
                reads.paths += 1;
                return DEFAULT_ANALYSIS_LIST_OPTS.pathsExist(paths, width);
            },
        });

        const one = await listOf(readyBoot, listOpts, "?sort=activity&perPage=1");
        const afterOne = { ...reads };
        const twenty = await listOf(readyBoot, listOpts, "?sort=activity&perPage=20");

        expect(one.list.analyses).toHaveLength(1);
        expect(one.list.analyses.map((a) => a.id)).toEqual(newestByActivity.slice(0, 1));
        expect(twenty.list.analyses.map((a) => a.id)).toEqual(newestByActivity.slice(0, 20));
        expect(afterOne).toEqual({ runs: 1, profiles: 1, live: 1, asks: 1, paths: 1 });
        expect({ runs: reads.runs - 1, profiles: reads.profiles - 1, live: reads.live - 1, asks: reads.asks - 1, paths: reads.paths - 1 }).toEqual(afterOne);
    });
});

describe("POST /api/v1/analyses", () => {
    test("201 with the new analysis: its anchor, its workspace folder, and its first inputs", async () => {
        const dir = tmp();
        writeFileSync(join(dir, "a.csv"), "x");
        const response = await appWith(idleBoot()).request(
            "/api/v1/analyses",
            json("POST", { name: " Liver RNA ", folder: dir, inputs: [join(dir, "a.csv")] }),
        );
        expect(response.status).toBe(201);
        const detail = (await response.json()) as AnalysisDetail;
        expect(detail).toMatchObject({ name: "Liver RNA", slug: "liver-rna", inputCount: 1, busy: [], project: null });
        expect(detail.anchor?.path).toBe(dir);
        expect(detail.outputDir).toBe(join(dir, ".inflexa", "analyses", "liver-rna"));
    });

    test("a missing input is a 400 that names it, and no analysis is made", async () => {
        const dir = tmp();
        const response = await appWith(idleBoot()).request("/api/v1/analyses", json("POST", { name: "x", folder: dir, inputs: [join(dir, "gone.csv")] }));
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).message).toBe(`no such file: ${join(dir, "gone.csv")}`);
        const list = (await (await appWith(idleBoot()).request("/api/v1/analyses")).json()) as AnalysisList;
        expect(list.total).toBe(0);
    });

    test("a blank name is a 400, and an unknown project is a 404", async () => {
        const blank = await appWith(idleBoot()).request("/api/v1/analyses", json("POST", { name: "  ", folder: tmp() }));
        expect(blank.status).toBe(400);
        expect(((await blank.json()) as ApiError).message).toBe("Invalid analysis name: must not be blank.");

        const unknown = await appWith(idleBoot()).request("/api/v1/analyses", json("POST", { name: "x", folder: tmp(), project: "nope" }));
        expect(unknown.status).toBe(404);
    });
});

describe("the analysis guard", () => {
    const TOKEN = "t".repeat(64);
    const auth = { Authorization: `Bearer ${TOKEN}` };

    test("404 `not_found` for an unknown analysis, for each `{A}` route", async () => {
        const app = buildApp({ token: TOKEN, boot: idleBoot(), lifecycle: idleLifecycle(), pageGrants: createPageGrantStore() });
        for (const path of ["/api/v1/analyses/nope", "/api/v1/analyses/nope/inputs"]) {
            const response = await app.request(path, { headers: auth });
            expect(response.status).toBe(404);
            expect(((await response.json()) as ApiError).error).toBe("not_found");
        }
    });

    test("409 `locked` while a different live process holds the instance lock of the analysis", async () => {
        const a = await seedAnalysis(tmp());
        // The parent of the test process is alive for the whole run, thus its pid is a live foreign holder.
        mkdirSync(join(instanceLockPath(a.id), ".."), { recursive: true });
        writeFileSync(instanceLockPath(a.id), String(process.ppid));
        try {
            const response = await buildApp({ token: TOKEN, boot: idleBoot(), lifecycle: idleLifecycle(), pageGrants: createPageGrantStore() }).request(
                `/api/v1/analyses/${a.id}`,
                {
                    headers: auth,
                },
            );
            expect(response.status).toBe(409);
            const body = (await response.json()) as ApiError;
            expect(body).toMatchObject({ error: "locked", details: { holderPid: process.ppid } });
            expect(body.message).toContain('"Alpha" is already open in another instance');
        } finally {
            rmSync(instanceLockPath(a.id), { force: true });
        }
    });

    test("the resolve route has no analysis id, thus the guard does not answer it", async () => {
        const response = await buildApp({ token: TOKEN, boot: idleBoot(), lifecycle: idleLifecycle(), pageGrants: createPageGrantStore() }).request(
            "/api/v1/analyses/resolve",
            {
                ...json("POST", { cwd: tmp() }),
                headers: { ...auth, "Content-Type": "application/json" },
            },
        );
        expect(response.status).toBe(200);
    });
});

describe("GET {A}", () => {
    test("the analysis with its anchor, its input count, and the busy reasons of the gate", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        insertAnalysisInput({ path: "in.csv", isDir: false, analysisId: a.id, anchorId: a.anchorId })._unsafeUnwrap();
        const busy: AnalysisRouteOpts = { ...IDLE, busyReasons: async () => ["data_profile"] };

        const detail = (await (await appWith(idleBoot(), busy).request(`/api/v1/analyses/${a.id}`)).json()) as AnalysisDetail;
        expect(detail).toMatchObject({
            id: a.id,
            inputCount: 1,
            busy: ["data_profile"],
            anchor: { id: a.anchorId, path: dir, cachedPath: dir, markerWritten: true },
        });
    });

    test("`cwd` reconciles a moved anchor folder from the folder of the client, not from the folder of the server", async () => {
        const before = tmp();
        const a = await seedAnalysis(before);
        const after = join(tmp(), "moved");
        renameSync(before, after);

        const detail = (await (await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}?cwd=${encodeURIComponent(after)}`)).json()) as AnalysisDetail;
        expect(detail.anchor?.path).toBe(after);
    });

    test("a relative `cwd` is a 400", async () => {
        const a = await seedAnalysis(tmp());
        const response = await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}?cwd=here`);
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error).toBe("validation_error");
    });

    test("`touch=false` records no sighting of the anchor folder; the default does", async () => {
        // The poll of a chat reads the analysis at each tick. A read of a poll is not an open of the folder.
        const a = await seedAnalysis(tmp());
        expect((await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}?touch=false`)).status).toBe(200);
        expect(getAnchor(a.anchorId)._unsafeUnwrap()?.lastSeen).toBe(1);

        expect((await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}`)).status).toBe(200);
        expect(getAnchor(a.anchorId)._unsafeUnwrap()?.lastSeen).toBeGreaterThan(1);
    });

    test("a `touch` that is not `true` or `false` is a 400", async () => {
        const a = await seedAnalysis(tmp());
        const response = await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}?touch=no`);
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error).toBe("validation_error");
    });
});

describe("PATCH {A}", () => {
    test("a rename while work holds the folder is a 409 `busy` that names the work, and nothing changes", async () => {
        const a = await seedAnalysis(tmp());
        const busy: AnalysisRouteOpts = { ...IDLE, busyReasons: async () => ["chat_turn", "run"] };
        const response = await appWith(idleBoot(), busy).request(`/api/v1/analyses/${a.id}`, json("PATCH", { name: "Beta" }));
        expect(response.status).toBe(409);
        expect((await response.json()) as ApiError).toEqual({
            error: "busy",
            message: "Cannot rename while a chat turn is running or paused.",
            details: { reasons: ["chat_turn", "run"] },
        });
        expect(getAnalysis(a.id)._unsafeUnwrap()?.name).toBe(asStr256("Alpha"));
    });

    test("a rename moves the workspace folder to the new slug", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        mkdirSync(join(dir, ".inflexa", "analyses", "alpha"), { recursive: true });
        const updated = (await (
            await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}`, json("PATCH", { name: "Beta" }))
        ).json()) as UpdateAnalysisResponse;
        expect(updated).toMatchObject({ name: "Beta", slug: "beta" });
        expect(updated.workspaceNotMoved).toBeUndefined();
        expect(existsSync(join(dir, ".inflexa", "analyses", "beta"))).toBe(true);
    });

    test("sets and clears the project by name, and an unknown project changes nothing", async () => {
        const project = createProject({ name: asStr256("Liver"), description: null, tags: [] })._unsafeUnwrap();
        const a = await seedAnalysis(tmp());
        const set = (await (await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}`, json("PATCH", { project: "Liver" }))).json()) as AnalysisDetail;
        expect(set.project?.id).toBe(project.id);

        const unknown = await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}`, json("PATCH", { project: "nope" }));
        expect(unknown.status).toBe(404);
        expect(getAnalysis(a.id)._unsafeUnwrap()?.projectId).toBe(project.id);

        const cleared = (await (await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}`, json("PATCH", { project: null }))).json()) as AnalysisDetail;
        expect(cleared.project).toBeNull();
    });
});

describe("DELETE {A} — the ordered delete", () => {
    const PURGED: AnalysisPurgeOutcome = { threads: 1, messages: 2, workflows: 0, vectorIndexDropped: true };
    const ARCHIVE = "/work/.inflexa/analyses_archived/alpha";

    /** The steps of the delete as fakes that record their order. */
    function ladder(
        out: { onDisk?: boolean; exported?: boolean; flushed?: boolean; disposalError?: WorkspaceError; purgeError?: PgError; busy?: BusyReason[] } = {},
    ): {
        opts: AnalysisRouteOpts;
        steps: string[];
    } {
        const steps: string[] = [];
        const opts: AnalysisRouteOpts = {
            busyReasons: async () => out.busy ?? [],
            hasWorkspaceOnDisk: async () => out.onDisk ?? true,
            flushProvenance: async () => {
                steps.push("flush");
                return out.flushed ?? true;
            },
            exportProvenance: async (_a, format) => {
                steps.push(`export:${format}`);
                return out.exported ?? true;
            },
            disposeWorkspace: (_a, mode) => {
                steps.push(`dispose:${mode}`);
                if (out.disposalError) return errAsync<WorkspaceDisposal, WorkspaceError>(out.disposalError);
                return okAsync<WorkspaceDisposal, WorkspaceError>(
                    mode === "archive" ? { kind: "archived", path: ARCHIVE } : { kind: "deleted", path: "/work/x" },
                );
            },
            purgeAnalysis: () => {
                steps.push("purge");
                return out.purgeError ? errAsync(out.purgeError) : okAsync(PURGED);
            },
            deleteAnalysis: (id) => {
                steps.push("delete-row");
                return DEFAULT_ANALYSIS_ROUTE_OPTS.deleteAnalysis(id);
            },
            removeFarm: async () => {
                steps.push("remove-farm");
            },
            removeInput: DEFAULT_ANALYSIS_ROUTE_OPTS.removeInput,
        };
        return { opts, steps };
    }

    test("keep: flush, export, archive, purge, then the row, then the farm", async () => {
        const a = await seedAnalysis(tmp());
        const l = ladder();
        const response = await appWith(readyBoot, l.opts).request(`/api/v1/analyses/${a.id}?workspace=keep&export=prov-json`, { method: "DELETE" });
        expect(response.status).toBe(200);
        expect((await response.json()) as DeleteAnalysisResponse).toEqual({ deleted: true, workspace: { kind: "archived", path: ARCHIVE }, export: "written" });
        expect(l.steps).toEqual(["flush", "export:json", "dispose:archive", "purge", "delete-row", "remove-farm"]);
        expect(getAnalysis(a.id)._unsafeUnwrap()).toBeNull();
    });

    test("delete: no export, and an export with no folder on disk is skipped", async () => {
        const deleted = ladder();
        const a = await seedAnalysis(tmp());
        await appWith(readyBoot, deleted.opts).request(`/api/v1/analyses/${a.id}?workspace=delete&export=prov-json`, { method: "DELETE" });
        expect(deleted.steps).toEqual(["dispose:delete", "purge", "delete-row", "remove-farm"]);

        const noFolder = ladder({ onDisk: false });
        const b = await seedAnalysis(tmp(), "Beta");
        const body = (await (
            await appWith(readyBoot, noFolder.opts).request(`/api/v1/analyses/${b.id}?export=prov-json`, { method: "DELETE" })
        ).json()) as DeleteAnalysisResponse;
        expect(body.export).toBe("none");
        expect(noFolder.steps[0]).toBe("dispose:archive");
    });

    test("a failed purge keeps the row, and the message names the archive path", async () => {
        const a = await seedAnalysis(tmp());
        const l = ladder({ purgeError: { type: "query_failed", op: "purgeAnalysis", cause: new Error("boom") } });
        const response = await appWith(readyBoot, l.opts).request(`/api/v1/analyses/${a.id}`, { method: "DELETE" });
        expect(response.status).toBe(500);
        const message = ((await response.json()) as ApiError).message;
        expect(message).toContain("the analysis was NOT deleted");
        expect(message).toContain(ARCHIVE);
        expect(l.steps).toEqual(["dispose:archive", "purge"]);
        expect(getAnalysis(a.id)._unsafeUnwrap()).not.toBeNull();
    });

    test("an unusable folder stops the delete before any store changes", async () => {
        const a = await seedAnalysis(tmp());
        const l = ladder({ disposalError: { type: "workspace_unavailable", message: "the folder is not writable" } });
        const response = await appWith(readyBoot, l.opts).request(`/api/v1/analyses/${a.id}`, { method: "DELETE" });
        expect(response.status).toBe(409);
        expect(l.steps).toEqual(["dispose:archive"]);
        expect(getAnalysis(a.id)._unsafeUnwrap()).not.toBeNull();
    });

    test("a slow remove of the workspace folder holds no other request", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        const b = await seedAnalysis(tmp(), "Beta");
        const root = join(dir, defaultOutputSubdir(a.slug));
        mkdirSync(root, { recursive: true });
        let release = (): void => undefined;
        const removing = new Promise<void>((resolve) => {
            release = resolve;
        });
        const removed: string[] = [];
        const opts: AnalysisRouteOpts = {
            ...IDLE,
            purgeAnalysis: () => okAsync(PURGED),
            removeFarm: async () => undefined,
            disposeWorkspace: (analysis, mode) =>
                disposeWorkspace(analysis, mode, (path) => {
                    removed.push(path);
                    return ResultAsync.fromSafePromise(removing);
                }),
        };
        const app = appWith(readyBoot, opts);
        let deleted = false;
        const deleting = Promise.resolve(app.request(`/api/v1/analyses/${a.id}?workspace=delete`, { method: "DELETE" })).then((response) => {
            deleted = true;
            return response;
        });

        expect((await app.request(`/api/v1/analyses/${b.id}`)).status).toBe(200);
        await Promise.sleep(20);
        expect(deleted).toBe(false);
        expect(removed).toEqual([root]);

        release();
        expect((await deleting).status).toBe(200);
    });

    test("a read of the workspace folder that does not end stops only its own request", async () => {
        const a = await seedAnalysis(tmp());
        const b = await seedAnalysis(tmp(), "Beta");
        let release = (): void => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const l = ladder();
        const app = appWith(readyBoot, {
            ...l.opts,
            hasWorkspaceOnDisk: async (analysis) => {
                await held;
                return DEFAULT_ANALYSIS_ROUTE_OPTS.hasWorkspaceOnDisk(analysis);
            },
        });
        const pending = Promise.resolve(app.request(`/api/v1/analyses/${a.id}?workspace=keep&export=prov-json`, { method: "DELETE" }));

        expect((await app.request(`/api/v1/analyses/${b.id}`)).status).toBe(200);
        expect(l.steps).toEqual([]);

        release();
        expect((await pending).status).toBe(200);
        // The real read finds no workspace folder, thus the delete steps over the export.
        expect(l.steps).toEqual(["dispose:archive", "purge", "delete-row", "remove-farm"]);
    });

    test("409 `busy` while work holds the folder, and 503 `unavailable` with no runtime", async () => {
        const a = await seedAnalysis(tmp());
        const busy = ladder({ busy: ["run"] });
        const refused = await appWith(readyBoot, busy.opts).request(`/api/v1/analyses/${a.id}`, { method: "DELETE" });
        expect(refused.status).toBe(409);
        expect(((await refused.json()) as ApiError).message).toBe("Cannot delete while a run is in flight.");
        expect(busy.steps).toEqual([]);

        const cold = ladder();
        const unavailable = await appWith(idleBoot(), cold.opts).request(`/api/v1/analyses/${a.id}`, { method: "DELETE" });
        expect(unavailable.status).toBe(503);
        expect(cold.steps).toEqual([]);
    });
});

describe("POST {A}/output-dir", () => {
    test("makes the workspace folder and gives its path", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        const view = (await (await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}/output-dir`, { method: "POST" })).json()) as OutputDirView;
        expect(view.path).toBe(join(dir, ".inflexa", "analyses", "alpha"));
        expect(existsSync(view.path)).toBe(true);
    });
});

describe("the inputs of an analysis", () => {
    test("POST adds, GET lists with the absolute path, and a missing path is a 400", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        writeFileSync(join(dir, "a.csv"), "x");
        const app = appWith(idleBoot());

        const added = (await (await app.request(`/api/v1/analyses/${a.id}/inputs`, json("POST", { paths: [join(dir, "a.csv")] }))).json()) as InputsChange;
        expect(added.added).toEqual([{ path: "a.csv", isDir: false, anchorId: a.anchorId, absolutePath: join(dir, "a.csv"), size: 1, kind: "table" }]);

        const list = (await (await app.request(`/api/v1/analyses/${a.id}/inputs`)).json()) as InputList;
        expect(list).toMatchObject({ total: 1, inputs: [{ path: "a.csv", absolutePath: join(dir, "a.csv") }] });

        const missing = await app.request(`/api/v1/analyses/${a.id}/inputs`, json("POST", { paths: [join(dir, "gone.csv")] }));
        expect(missing.status).toBe(400);
        expect(((await missing.json()) as ApiError).details).toEqual({ missing: [join(dir, "gone.csv")] });
    });

    test("GET gives the size and the kind of a file, a file with no mapped extension, a folder, and a missing path", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        writeFileSync(join(dir, "counts.csv"), "x".repeat(1204));
        writeFileSync(join(dir, "notes.zzz"), "x".repeat(12));
        mkdirSync(join(dir, "runs.csv"));
        const stored = [
            { path: "counts.csv", isDir: false },
            { path: "notes.zzz", isDir: false },
            // A folder whose name has a mapped extension: the stat decides, not the name.
            { path: "runs.csv", isDir: true },
            { path: "gone.csv", isDir: false },
            // With no stat, the stored isDir decides: a missing folder has no kind, although its name maps to one.
            { path: "gone-folder.csv", isDir: true },
        ];
        for (const input of stored) insertAnalysisInput({ ...input, analysisId: a.id, anchorId: a.anchorId })._unsafeUnwrap();

        const list = (await (await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}/inputs`)).json()) as InputList;
        const byPath = new Map(list.inputs.map((i) => [i.path, i]));
        expect(byPath.get("counts.csv")).toMatchObject({ size: 1204, kind: "table" });
        expect(byPath.get("notes.zzz")).toMatchObject({ size: 12, kind: null });
        expect(byPath.get("runs.csv")).toMatchObject({ size: null, kind: null });
        expect(byPath.get("gone.csv")).toMatchObject({ size: null, kind: "table" });
        expect(byPath.get("gone-folder.csv")).toMatchObject({ size: null, kind: null });
    });

    test("POST gives the size and the kind of the added input", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        writeFileSync(join(dir, "counts.csv"), "x".repeat(1204));

        const res = await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}/inputs`, json("POST", { paths: [join(dir, "counts.csv")] }));
        const change = (await res.json()) as InputsChange;
        expect(change.added).toMatchObject([{ path: "counts.csv", size: 1204, kind: "table" }]);
    });

    test("GET gives no size and no kind for the input of a folder that cannot be located", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        insertAnchor({ id: "lost", createdAt: 1, updatedAt: 1, cachedPath: "/gone/forever", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysisInput({ path: "far.csv", isDir: false, analysisId: a.id, anchorId: "lost" })._unsafeUnwrap();
        insertAnalysisInput({ path: "wide", isDir: true, analysisId: a.id, anchorId: "lost" })._unsafeUnwrap();

        const list = (await (await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}/inputs`)).json()) as InputList;
        const byPath = new Map(list.inputs.map((i) => [i.path, i]));
        expect(byPath.get("far.csv")).toMatchObject({ absolutePath: null, size: null, kind: "table" });
        expect(byPath.get("wide")).toMatchObject({ absolutePath: null, size: null, kind: null });
    });

    test("GET records no sighting of an anchor folder", async () => {
        // A listing is not a sighting. `resolveAnchor` writes a `lastSeen` heartbeat by default, and a
        // write for each row would make it measure the reads of a list.
        const dir = tmp();
        const a = await seedAnalysis(dir);
        insertAnalysisInput({ path: "a.csv", isDir: false, analysisId: a.id, anchorId: a.anchorId })._unsafeUnwrap();
        await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}/inputs`);
        expect(getAnchor(a.anchorId)._unsafeUnwrap()?.lastSeen).toBe(1);
    });

    test("POST remove records no sighting of an anchor folder", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        insertAnalysisInput({ path: "a.csv", isDir: false, analysisId: a.id, anchorId: a.anchorId })._unsafeUnwrap();
        insertAnalysisInput({ path: "b.csv", isDir: false, analysisId: a.id, anchorId: a.anchorId })._unsafeUnwrap();
        await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}/inputs/remove`, json("POST", { paths: [join(dir, "a.csv")] }));
        expect(
            listAnalysisInputs(a.id)
                ._unsafeUnwrap()
                .map((i) => i.path),
        ).toEqual(["b.csv"]);
        expect(getAnchor(a.anchorId)._unsafeUnwrap()?.lastSeen).toBe(1);
    });

    test("PUT replaces the set, and keeps an input whose folder cannot be located", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        writeFileSync(join(dir, "old.csv"), "x");
        writeFileSync(join(dir, "new.csv"), "x");
        insertAnalysisInput({ path: "old.csv", isDir: false, analysisId: a.id, anchorId: a.anchorId })._unsafeUnwrap();
        // An anchor whose folder is gone: its input has no absolute path, thus no client could show it.
        insertAnchor({ id: "lost", createdAt: 1, updatedAt: 1, cachedPath: "/gone/forever", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysisInput({ path: "far.csv", isDir: false, analysisId: a.id, anchorId: "lost" })._unsafeUnwrap();

        const change = (await (
            await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}/inputs`, json("PUT", { paths: [join(dir, "new.csv")] }))
        ).json()) as InputsChange;
        expect(change.added.map((i) => i.path)).toEqual(["new.csv"]);
        expect(change.removed.map((i) => i.path)).toEqual(["old.csv"]);
        expect(
            listAnalysisInputs(a.id)
                ._unsafeUnwrap()
                .map((i) => i.path)
                .toSorted(),
        ).toEqual(["far.csv", "new.csv"]);
    });

    test("PUT tries each removal after a failed one, then answers 500 that names each failed and each removed input", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        const names = ["one.csv", "two.csv", "three.csv", "four.csv"];
        for (const path of [...names, "keep.csv"]) {
            writeFileSync(join(dir, path), "x");
            insertAnalysisInput({ path, isDir: false, analysisId: a.id, anchorId: a.anchorId })._unsafeUnwrap();
        }
        const failing = new Set(["two.csv", "three.csv"]);
        const opts: AnalysisRouteOpts = {
            ...IDLE,
            removeInput: (input) => (failing.has(input.path) ? err({ type: "mutation_failed", op: "delete input", cause: "disk full" }) : removeInput(input)),
        };

        const res = await appWith(idleBoot(), opts).request(`/api/v1/analyses/${a.id}/inputs`, json("PUT", { paths: [join(dir, "keep.csv")] }));

        expect(res.status).toBe(500);
        const body = (await res.json()) as ApiError;
        expect(body.error).toBe("internal_error");
        expect(body.message).toContain("two.csv, three.csv");
        expect(body.message).toContain("one.csv, four.csv");
        expect(body.message).not.toContain("disk full");
        expect(
            listAnalysisInputs(a.id)
                ._unsafeUnwrap()
                .map((i) => i.path)
                .toSorted(),
        ).toEqual(["keep.csv", "three.csv", "two.csv"]);
    });

    test("POST remove tries each input after a failed removal, then answers 500 that names each outcome", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        const names = ["one.csv", "two.csv", "three.csv", "four.csv"];
        for (const path of names) insertAnalysisInput({ path, isDir: false, analysisId: a.id, anchorId: a.anchorId })._unsafeUnwrap();
        const failing = new Set(["two.csv", "three.csv"]);
        const opts: AnalysisRouteOpts = {
            ...IDLE,
            removeInput: (input) => (failing.has(input.path) ? err({ type: "mutation_failed", op: "delete input", cause: "disk full" }) : removeInput(input)),
        };
        const removedEvents: string[] = [];
        const onEvent = (event: BusEvent): void => {
            if (event.type === "prov.input_removed") removedEvents.push(event.input.path);
        };
        Bus.on("inflexa", onEvent);

        const res = await appWith(idleBoot(), opts).request(`/api/v1/analyses/${a.id}/inputs/remove`, json("POST", { paths: names }));
        Bus.off("inflexa", onEvent);

        expect(res.status).toBe(500);
        const body = (await res.json()) as ApiError;
        expect(body.error).toBe("internal_error");
        for (const name of names) expect(body.message).toContain(name);
        expect(body.message).toContain("two.csv, three.csv");
        expect(body.message).toContain("one.csv, four.csv");
        expect(body.message).not.toContain("disk full");
        expect(
            listAnalysisInputs(a.id)
                ._unsafeUnwrap()
                .map((i) => i.path)
                .toSorted(),
        ).toEqual(["three.csv", "two.csv"]);
        expect(removedEvents).toEqual(["one.csv", "four.csv"]);
    });

    test("POST remove matches the absolute path or the stored path, and names the paths that match nothing", async () => {
        const dir = tmp();
        const a = await seedAnalysis(dir);
        insertAnalysisInput({ path: "a.csv", isDir: false, analysisId: a.id, anchorId: a.anchorId })._unsafeUnwrap();
        insertAnchor({ id: "lost", createdAt: 1, updatedAt: 1, cachedPath: "/gone/forever", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysisInput({ path: "far.csv", isDir: false, analysisId: a.id, anchorId: "lost" })._unsafeUnwrap();

        const change = (await (
            await appWith(idleBoot()).request(
                `/api/v1/analyses/${a.id}/inputs/remove`,
                json("POST", { paths: [join(dir, "a.csv"), "far.csv", join(dir, "nope.csv")] }),
            )
        ).json()) as InputsChange;
        expect(change.removed.map((i) => i.path).toSorted()).toEqual(["a.csv", "far.csv"]);
        expect(change.notInputs).toEqual([join(dir, "nope.csv")]);
        expect(listAnalysisInputs(a.id)._unsafeUnwrap()).toEqual([]);
    });
});
