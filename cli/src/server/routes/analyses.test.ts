import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { AnalysisPurgeOutcome, DbError as PgError, Pool } from "@inflexa-ai/harness";

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
import type { ServerState } from "../../api/server.ts";
import { createProject, insertAnalysis, insertAnalysisInput, insertAnchor, upsertLlmUsage } from "../../db/primary_mutation.ts";
import { getAnalysis, getAnchor, listAnalysisInputs } from "../../db/primary_query.ts";
import { instanceLockPath } from "../../lib/lock.ts";
import { asStr256 } from "../../lib/types.ts";
import { defaultOutputSubdir, disposeWorkspace, type WorkspaceDisposal, type WorkspaceError } from "../../modules/analysis/output.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Analysis } from "../../types/analysis.ts";
import { freshDb } from "../../test_support/db.ts";
import { idleBoot, idleLifecycle } from "../../test_support/server.ts";
import { buildApp } from "../app.ts";
import type { ServerBoot } from "../boot.ts";
import type { ServerEnv } from "../http.ts";
import { analysisCollectionRoutes, analysisRoutes, DEFAULT_ANALYSIS_ROUTE_OPTS, type AnalysisRouteOpts } from "./analyses.ts";

// The routes under their mount paths, with no bearer check and no guard, except the guard tests, which drive
// the whole app. Each `as` cast of a body below reads JSON that the route under test builds from the same
// `src/api/` type. The Postgres purge and the busy gate are fakes: the gate reads the turn registry, the
// profile queue, and Postgres.

const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;
// The delete only passes the pool to the injected purge, thus a stand-in object is enough.
const runtime = { pool: {} as unknown as Pool } as unknown as HarnessRuntime;
const readyBoot: ServerBoot = {
    state: (): ServerState => ({ ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "m" } }),
    runtime: () => runtime,
    start: async () => undefined,
};

const IDLE: AnalysisRouteOpts = { ...DEFAULT_ANALYSIS_ROUTE_OPTS, busyReasons: async () => [] };

function appWith(boot: ServerBoot, opts: AnalysisRouteOpts = IDLE): Hono<ServerEnv> {
    const app = new Hono<ServerEnv>();
    app.route("/api/v1/analyses", analysisCollectionRoutes());
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
function seedAnalysis(dir: string, name = "Alpha", over: Partial<Analysis> = {}): Analysis {
    const anchorId = randomUUIDv7();
    writeMarker(dir, anchorId)._unsafeUnwrap();
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
        const a = seedAnalysis(dir);
        const response = await appWith(idleBoot()).request("/api/v1/analyses/resolve", json("POST", { cwd: dir }));
        expect(response.status).toBe(200);
        const view = (await response.json()) as ResolvedContextView;
        expect(view).toMatchObject({ kind: "analysis", anchorPath: dir, others: [], analysis: { id: a.id, name: "Alpha" } });
        expect(view.describe).toBe(`context: analysis "Alpha" — ${dir}`);
    });

    test("a reference by name names the other analyses that share the name", async () => {
        const firstDir = tmp();
        const first = seedAnalysis(firstDir, "Same");
        const second = seedAnalysis(tmp(), "Same", { createdAt: 2 });
        const view = (await (
            await appWith(idleBoot()).request("/api/v1/analyses/resolve", json("POST", { cwd: tmp(), ref: "Same" }))
        ).json()) as ResolvedContextView;
        expect(view.kind).toBe("analysis");
        if (view.kind !== "analysis") return;
        expect(view.analysis.id).toBe(second.id);
        expect(view.others.map((a) => [a.id, a.anchorPath])).toEqual([[first.id, firstDir]]);
    });

    test("`touch: false` records no sighting of the anchor folder; the default does", async () => {
        const a = seedAnalysis(tmp());
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
        const older = seedAnalysis(dir, "Older", { createdAt: 1 });
        const newer = seedAnalysis(tmp(), "Newer", { createdAt: 2 });
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
        const inProject = seedAnalysis(tmp(), "In", { projectId: project.id });
        seedAnalysis(tmp(), "Out");

        const list = (await (await appWith(idleBoot()).request("/api/v1/analyses?project=Liver")).json()) as AnalysisList;
        expect(list.analyses.map((a) => a.id)).toEqual([inProject.id]);

        const unknown = await appWith(idleBoot()).request("/api/v1/analyses?project=nope");
        expect(unknown.status).toBe(404);
        expect(((await unknown.json()) as ApiError).message).toBe('No project found matching "nope".');
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
        const app = buildApp({ token: TOKEN, boot: idleBoot(), lifecycle: idleLifecycle() });
        for (const path of ["/api/v1/analyses/nope", "/api/v1/analyses/nope/inputs"]) {
            const response = await app.request(path, { headers: auth });
            expect(response.status).toBe(404);
            expect(((await response.json()) as ApiError).error).toBe("not_found");
        }
    });

    test("409 `locked` while a different live process holds the instance lock of the analysis", async () => {
        const a = seedAnalysis(tmp());
        // The parent of the test process is alive for the whole run, thus its pid is a live foreign holder.
        mkdirSync(join(instanceLockPath(a.id), ".."), { recursive: true });
        writeFileSync(instanceLockPath(a.id), String(process.ppid));
        try {
            const response = await buildApp({ token: TOKEN, boot: idleBoot(), lifecycle: idleLifecycle() }).request(`/api/v1/analyses/${a.id}`, {
                headers: auth,
            });
            expect(response.status).toBe(409);
            const body = (await response.json()) as ApiError;
            expect(body).toMatchObject({ error: "locked", details: { holderPid: process.ppid } });
            expect(body.message).toContain('"Alpha" is already open in another instance');
        } finally {
            rmSync(instanceLockPath(a.id), { force: true });
        }
    });

    test("the resolve route has no analysis id, thus the guard does not answer it", async () => {
        const response = await buildApp({ token: TOKEN, boot: idleBoot(), lifecycle: idleLifecycle() }).request("/api/v1/analyses/resolve", {
            ...json("POST", { cwd: tmp() }),
            headers: { ...auth, "Content-Type": "application/json" },
        });
        expect(response.status).toBe(200);
    });
});

describe("GET {A}", () => {
    test("the analysis with its anchor, its input count, and the busy reasons of the gate", async () => {
        const dir = tmp();
        const a = seedAnalysis(dir);
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
        const a = seedAnalysis(before);
        const after = join(tmp(), "moved");
        renameSync(before, after);

        const detail = (await (await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}?cwd=${encodeURIComponent(after)}`)).json()) as AnalysisDetail;
        expect(detail.anchor?.path).toBe(after);
    });

    test("a relative `cwd` is a 400", async () => {
        const a = seedAnalysis(tmp());
        const response = await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}?cwd=here`);
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error).toBe("validation_error");
    });

    test("`touch=false` records no sighting of the anchor folder; the default does", async () => {
        // The poll of a chat reads the analysis at each tick. A read of a poll is not an open of the folder.
        const a = seedAnalysis(tmp());
        expect((await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}?touch=false`)).status).toBe(200);
        expect(getAnchor(a.anchorId)._unsafeUnwrap()?.lastSeen).toBe(1);

        expect((await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}`)).status).toBe(200);
        expect(getAnchor(a.anchorId)._unsafeUnwrap()?.lastSeen).toBeGreaterThan(1);
    });

    test("a `touch` that is not `true` or `false` is a 400", async () => {
        const a = seedAnalysis(tmp());
        const response = await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}?touch=no`);
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error).toBe("validation_error");
    });
});

describe("PATCH {A}", () => {
    test("a rename while work holds the folder is a 409 `busy` that names the work, and nothing changes", async () => {
        const a = seedAnalysis(tmp());
        const busy: AnalysisRouteOpts = { ...IDLE, busyReasons: async () => ["chat_turn", "run"] };
        const response = await appWith(idleBoot(), busy).request(`/api/v1/analyses/${a.id}`, json("PATCH", { name: "Beta" }));
        expect(response.status).toBe(409);
        expect((await response.json()) as ApiError).toEqual({
            error: "busy",
            message: "Cannot rename while a chat turn is running.",
            details: { reasons: ["chat_turn", "run"] },
        });
        expect(getAnalysis(a.id)._unsafeUnwrap()?.name).toBe(asStr256("Alpha"));
    });

    test("a rename moves the workspace folder to the new slug", async () => {
        const dir = tmp();
        const a = seedAnalysis(dir);
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
        const a = seedAnalysis(tmp());
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
            hasWorkspaceOnDisk: () => out.onDisk ?? true,
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
        };
        return { opts, steps };
    }

    test("keep: flush, export, archive, purge, then the row, then the farm", async () => {
        const a = seedAnalysis(tmp());
        const l = ladder();
        const response = await appWith(readyBoot, l.opts).request(`/api/v1/analyses/${a.id}?workspace=keep&export=prov-json`, { method: "DELETE" });
        expect(response.status).toBe(200);
        expect((await response.json()) as DeleteAnalysisResponse).toEqual({ deleted: true, workspace: { kind: "archived", path: ARCHIVE }, export: "written" });
        expect(l.steps).toEqual(["flush", "export:json", "dispose:archive", "purge", "delete-row", "remove-farm"]);
        expect(getAnalysis(a.id)._unsafeUnwrap()).toBeNull();
    });

    test("delete: no export, and an export with no folder on disk is skipped", async () => {
        const deleted = ladder();
        const a = seedAnalysis(tmp());
        await appWith(readyBoot, deleted.opts).request(`/api/v1/analyses/${a.id}?workspace=delete&export=prov-json`, { method: "DELETE" });
        expect(deleted.steps).toEqual(["dispose:delete", "purge", "delete-row", "remove-farm"]);

        const noFolder = ladder({ onDisk: false });
        const b = seedAnalysis(tmp(), "Beta");
        const body = (await (
            await appWith(readyBoot, noFolder.opts).request(`/api/v1/analyses/${b.id}?export=prov-json`, { method: "DELETE" })
        ).json()) as DeleteAnalysisResponse;
        expect(body.export).toBe("none");
        expect(noFolder.steps[0]).toBe("dispose:archive");
    });

    test("a failed purge keeps the row, and the message names the archive path", async () => {
        const a = seedAnalysis(tmp());
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
        const a = seedAnalysis(tmp());
        const l = ladder({ disposalError: { type: "workspace_unavailable", message: "the folder is not writable" } });
        const response = await appWith(readyBoot, l.opts).request(`/api/v1/analyses/${a.id}`, { method: "DELETE" });
        expect(response.status).toBe(409);
        expect(l.steps).toEqual(["dispose:archive"]);
        expect(getAnalysis(a.id)._unsafeUnwrap()).not.toBeNull();
    });

    test("a slow remove of the workspace folder holds no other request", async () => {
        const dir = tmp();
        const a = seedAnalysis(dir);
        const b = seedAnalysis(tmp(), "Beta");
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

    test("409 `busy` while work holds the folder, and 503 `unavailable` with no runtime", async () => {
        const a = seedAnalysis(tmp());
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
        const a = seedAnalysis(dir);
        const view = (await (await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}/output-dir`, { method: "POST" })).json()) as OutputDirView;
        expect(view.path).toBe(join(dir, ".inflexa", "analyses", "alpha"));
        expect(existsSync(view.path)).toBe(true);
    });
});

describe("the inputs of an analysis", () => {
    test("POST adds, GET lists with the absolute path, and a missing path is a 400", async () => {
        const dir = tmp();
        const a = seedAnalysis(dir);
        writeFileSync(join(dir, "a.csv"), "x");
        const app = appWith(idleBoot());

        const added = (await (await app.request(`/api/v1/analyses/${a.id}/inputs`, json("POST", { paths: [join(dir, "a.csv")] }))).json()) as InputsChange;
        expect(added.added).toEqual([{ path: "a.csv", isDir: false, anchorId: a.anchorId, absolutePath: join(dir, "a.csv") }]);

        const list = (await (await app.request(`/api/v1/analyses/${a.id}/inputs`)).json()) as InputList;
        expect(list).toMatchObject({ total: 1, inputs: [{ path: "a.csv", absolutePath: join(dir, "a.csv") }] });

        const missing = await app.request(`/api/v1/analyses/${a.id}/inputs`, json("POST", { paths: [join(dir, "gone.csv")] }));
        expect(missing.status).toBe(400);
        expect(((await missing.json()) as ApiError).details).toEqual({ missing: [join(dir, "gone.csv")] });
    });

    test("GET records no sighting of an anchor folder", async () => {
        // A listing is not a sighting. `resolveAnchor` writes a `lastSeen` heartbeat by default, and a
        // write for each row would make it measure the reads of a list.
        const dir = tmp();
        const a = seedAnalysis(dir);
        insertAnalysisInput({ path: "a.csv", isDir: false, analysisId: a.id, anchorId: a.anchorId })._unsafeUnwrap();
        await appWith(idleBoot()).request(`/api/v1/analyses/${a.id}/inputs`);
        expect(getAnchor(a.anchorId)._unsafeUnwrap()?.lastSeen).toBe(1);
    });

    test("POST remove records no sighting of an anchor folder", async () => {
        const dir = tmp();
        const a = seedAnalysis(dir);
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
        const a = seedAnalysis(dir);
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

    test("POST remove matches the absolute path or the stored path, and names the paths that match nothing", async () => {
        const dir = tmp();
        const a = seedAnalysis(dir);
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
