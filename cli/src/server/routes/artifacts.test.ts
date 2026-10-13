import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactPage, ArtifactPageQuery, Pool } from "@inflexa-ai/harness";
import { Hono } from "hono";
import { errAsync, okAsync } from "neverthrow";

import type { ArtifactList, ResolvedArtifacts } from "../../api/artifacts.ts";
import type { ServerBootState } from "../../api/server.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import { invalidateWorkspaceRoot, workspaceRootForAnalysisId } from "../../modules/analysis/output.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import { freshDb } from "../../test_support/db.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { ServerBoot } from "../boot.ts";
import type { OpenTarget } from "../../types/session.ts";
import type { ServerEnv } from "../http.ts";
import { artifactRoutes, type ArtifactRoutesOpts } from "./artifacts.ts";

// The route alone, mounted at its path with no bearer check and no analysis guard: `app.test.ts` covers
// those. Each `as` cast of a body below reads JSON that the route under test builds from the same
// `src/api/` type.
const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;
// The routes only pass the pool to the injected read, thus a stand-in object is enough.
const runtime = { pool: {} as Pool } as unknown as HarnessRuntime;

const readyBoot: ServerBoot = {
    state: () => ({ ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "m" } }),
    runtime: () => runtime,
    start: async () => undefined,
};

const startingState: ServerBootState = { ...identity, phase: "starting", boot: { attemptStartedAt: identity.startedAt, step: null, done: [] } };
const startingBoot: ServerBoot = { state: () => startingState, runtime: () => null, start: async () => undefined };

function appWith(opts: ArtifactRoutesOpts, boot: ServerBoot = readyBoot): Hono<ServerEnv> {
    return new Hono<ServerEnv>().route("/api/v1/analyses/:analysisId/artifacts", artifactRoutes(boot, opts));
}

const UNEXPECTED: ArtifactRoutesOpts = {
    listArtifacts: () => {
        throw new Error("the test did not expect a call of listArtifacts");
    },
};

// The resolve route needs no runtime and no harness read, thus a boot that never gets ready serves it.
const app = appWith(UNEXPECTED, startingBoot);

const created: string[] = [];

/** Seed a resolvable analysis (anchor marker + rows) and return its workspace root, made on disk. */
async function seedAnalysis(analysisId: string): Promise<string> {
    const home = mkdtempSync(join(tmpdir(), "inflexa-artifact-route-"));
    created.push(home);
    (await writeMarker(home, "A1"))._unsafeUnwrap();
    insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    insertAnalysis({ id: analysisId, createdAt: 1, updatedAt: 1, name: asStr256("A"), slug: "a", anchorId: "A1", projectId: null })._unsafeUnwrap();
    const root = (await workspaceRootForAnalysisId(analysisId))._unsafeUnwrap();
    mkdirSync(root, { recursive: true });
    return root;
}

async function resolve(analysisId: string, entries: unknown[], materialize: boolean): Promise<Response> {
    return app.request(`/api/v1/analyses/${analysisId}/artifacts/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries, materialize }),
    });
}

beforeEach(() => {
    freshDb();
    // The workspace-root memo is process state that outlives freshDb(); each test makes its own anchor
    // under a new tmpdir, so a carried-over entry would resolve onto the home of an earlier test.
    invalidateWorkspaceRoot();
});

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("POST {A}/artifacts/resolve", () => {
    const chart: OpenTarget = { kind: "echart", presId: "pres-0123abcd", spec: { series: [{ type: "bar" }] } };

    test("without `materialize`, each entry gets its path and its degraded mark, in order, and nothing is written", async () => {
        const root = await seedAnalysis("ana-1");
        mkdirSync(join(root, "runs"), { recursive: true });
        writeFileSync(join(root, "runs", "out.csv"), "a,b\n");

        const response = await resolve(
            "ana-1",
            [
                { kind: "workspace-file", path: "runs/out.csv" },
                { kind: "workspace-file", path: "runs/gone.csv" },
                chart,
                { kind: "unavailable", reason: "preview failed" },
            ],
            false,
        );

        expect(response.status).toBe(200);
        expect(((await response.json()) as ResolvedArtifacts).entries).toEqual([
            { kind: "workspace-file", path: join(root, "runs", "out.csv"), degraded: false },
            { kind: "workspace-file", path: join(root, "runs", "gone.csv"), degraded: true },
            // An echart file is made on open, thus its absence is not a fault.
            { kind: "echart", path: join(root, "presentations", "pres-0123abcd.html"), degraded: false },
            { kind: "unavailable", path: null, degraded: true },
        ]);
        expect(existsSync(join(root, "presentations"))).toBe(false);
    });

    test("with `materialize`, the echart file is written, and an entry that cannot open names why", async () => {
        const root = await seedAnalysis("ana-1");

        const response = await resolve(
            "ana-1",
            [chart, { kind: "workspace-file", path: "runs/gone.csv" }, { kind: "unavailable", reason: "preview failed" }],
            true,
        );

        const { entries } = (await response.json()) as ResolvedArtifacts;
        expect(entries[0]).toEqual({ kind: "echart", path: join(root, "presentations", "pres-0123abcd.html"), degraded: false });
        expect(existsSync(join(root, "presentations", "pres-0123abcd.html"))).toBe(true);
        expect(entries[1]?.error).toEqual({ type: "missing", path: join(root, "runs", "gone.csv") });
        expect(entries[2]?.error).toEqual({ type: "unavailable", reason: "preview failed" });
    });

    test("a workspace path that leaves the workspace resolves nowhere and is degraded", async () => {
        await seedAnalysis("ana-1");

        for (const materialize of [false, true]) {
            const response = await resolve("ana-1", [{ kind: "workspace-file", path: "../../outside.txt" }], materialize);
            const [entry] = ((await response.json()) as ResolvedArtifacts).entries;
            expect(entry).toMatchObject({ path: null, degraded: true });
            if (materialize) expect(entry?.error?.type).toBe("unavailable");
        }
    });

    test("a symbolic link that leaves the workspace resolves nowhere and is degraded", async () => {
        const root = await seedAnalysis("ana-1");
        const outside = mkdtempSync(join(tmpdir(), "inflexa-artifact-outside-"));
        created.push(outside);
        writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
        mkdirSync(join(root, "runs", "R", "A"), { recursive: true });
        symlinkSync(join(outside, "secret.txt"), join(root, "runs", "R", "A", "leak.txt"));
        symlinkSync(outside, join(root, "runs", "R", "A", "linked"));

        for (const materialize of [false, true]) {
            const response = await resolve(
                "ana-1",
                [
                    { kind: "workspace-file", path: "runs/R/A/leak.txt" },
                    { kind: "workspace-file", path: "runs/R/A/linked/secret.txt" },
                ],
                materialize,
            );
            for (const entry of ((await response.json()) as ResolvedArtifacts).entries) {
                expect(entry).toMatchObject({ path: null, degraded: true });
                if (materialize) expect(entry.error).toEqual({ type: "unavailable", reason: "the path is not inside the analysis" });
            }
        }
    });

    test("a link that stays inside the workspace, a folder, and an absent file still resolve as before", async () => {
        const root = await seedAnalysis("ana-1");
        mkdirSync(join(root, "runs", "R", "A", "figures"), { recursive: true });
        writeFileSync(join(root, "runs", "R", "A", "real.csv"), "a\n");
        symlinkSync(join(root, "runs", "R", "A", "real.csv"), join(root, "runs", "R", "A", "alias.csv"));

        const response = await resolve(
            "ana-1",
            [
                { kind: "workspace-file", path: "runs/R/A/alias.csv" },
                { kind: "workspace-file", path: "runs/R/A/figures" },
                { kind: "workspace-file", path: "runs/R/A/gone.csv" },
            ],
            true,
        );

        const { entries } = (await response.json()) as ResolvedArtifacts;
        // The response keeps the joined path, not the real path.
        expect(entries[0]).toEqual({ kind: "workspace-file", path: join(root, "runs", "R", "A", "alias.csv"), degraded: false });
        expect(entries[1]).toEqual({ kind: "workspace-file", path: join(root, "runs", "R", "A", "figures"), degraded: false });
        expect(entries[2]).toEqual({
            kind: "workspace-file",
            path: join(root, "runs", "R", "A", "gone.csv"),
            degraded: true,
            error: { type: "missing", path: join(root, "runs", "R", "A", "gone.csv") },
        });
    });

    test("an analysis whose folder cannot be located resolves each entry to `unresolved`", async () => {
        const response = await resolve("no-such-analysis", [{ kind: "workspace-file", path: "runs/out.csv" }], true);

        const [entry] = ((await response.json()) as ResolvedArtifacts).entries;
        expect(entry).toEqual({ kind: "workspace-file", path: null, degraded: true, error: { type: "unresolved" } });
    });

    test("a presentation id that is not `pres-` and a digest is 400 `validation_error`, and writes nothing", async () => {
        const root = await seedAnalysis("ana-1");

        const response = await resolve("ana-1", [{ kind: "svg", presId: "../../escape", markup: "<svg/>" }], true);

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error" });
        expect(existsSync(join(root, "presentations"))).toBe(false);
    });
});

describe("GET {A}/artifacts", () => {
    const entry = {
        path: "runs/r1/s1/figures/Volcano.png",
        size: 2048,
        fileType: "figure",
        role: "step_output",
        runId: "r1",
        stepId: "s1",
        createdAt: "2026-10-01T00:00:00.000Z",
    } as const;

    /** The routes over a read that records its queries and gives `page`. */
    function listing(page: ArtifactPage = { entries: [entry], total: 1 }): { app: Hono<ServerEnv>; reads: { analysisId: string; query: ArtifactPageQuery }[] } {
        const reads: { analysisId: string; query: ArtifactPageQuery }[] = [];
        const routes = appWith({
            listArtifacts: (_pool, analysisId, query) => {
                reads.push({ analysisId, query });
                return okAsync(page);
            },
        });
        return { app: routes, reads };
    }

    test("gives the page in the list shape, and sends the filters with the default sort", async () => {
        const { app: routes, reads } = listing({ entries: [entry], total: 2 });

        const response = await routes.request("/api/v1/analyses/a1/artifacts?fileType=figure&q=volcano&runId=r1&stepId=s1");
        const list = (await response.json()) as ArtifactList;

        expect(response.status).toBe(200);
        expect(list).toEqual({ artifacts: [entry], total: 2, page: 0, perPage: 100, hasMore: false });
        expect(reads).toEqual([
            { analysisId: "a1", query: { fileType: "figure", q: "volcano", runId: "r1", stepId: "s1", sort: "path", limit: 100, offset: 0 } },
        ]);
    });

    test("sends one read with the limit and the offset of the page", async () => {
        const { app: routes, reads } = listing();

        await routes.request("/api/v1/analyses/a1/artifacts?page=2&perPage=50&sort=recent");

        expect(reads).toEqual([{ analysisId: "a1", query: { sort: "recent", limit: 50, offset: 100 } }]);
    });

    test("an empty filter value and an empty sort are no filter and the default sort", async () => {
        const { app: routes, reads } = listing();

        const response = await routes.request("/api/v1/analyses/a1/artifacts?runId=&stepId=&fileType=&q=&sort=");

        expect(response.status).toBe(200);
        expect(reads).toEqual([{ analysisId: "a1", query: { sort: "path", limit: 100, offset: 0 } }]);
    });

    test("400 `validation_error` for a sort value that is not path or recent, with no read", async () => {
        const response = await appWith(UNEXPECTED).request("/api/v1/analyses/a1/artifacts?sort=size");

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error", details: { fieldErrors: { sort: expect.any(Array) } } });
    });

    test("503 `unavailable` before the runtime is ready", async () => {
        const response = await appWith(UNEXPECTED, startingBoot).request("/api/v1/analyses/a1/artifacts");

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "unavailable", details: { phase: "starting" } });
    });

    test("500 `internal_error` when the ledger read fails", async () => {
        const failed = appWith({ listArtifacts: () => errAsync({ type: "query_failed", op: "test", cause: "down" }) });

        const response = await failed.request("/api/v1/analyses/a1/artifacts");

        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: "internal_error" });
    });
});
