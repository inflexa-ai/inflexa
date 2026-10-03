import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import type { ResolvedArtifacts } from "../../api/artifacts.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import { invalidateWorkspaceRoot, workspaceRootForAnalysisId } from "../../modules/analysis/output.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import { freshDb } from "../../test_support/db.ts";
import type { OpenTarget } from "../../types/session.ts";
import type { ServerEnv } from "../http.ts";
import { artifactRoutes } from "./artifacts.ts";

// The route alone, mounted at its path with no bearer check and no analysis guard: `app.test.ts` covers
// those. Each `as` cast of a body below reads JSON that the route under test builds from the same
// `src/api/` type.
const app = new Hono<ServerEnv>().route("/api/v1/analyses/:analysisId/artifacts", artifactRoutes());

const created: string[] = [];

/** Seed a resolvable analysis (anchor marker + rows) and return its workspace root, made on disk. */
function seedAnalysis(analysisId: string): string {
    const home = mkdtempSync(join(tmpdir(), "inflexa-artifact-route-"));
    created.push(home);
    writeMarker(home, "A1")._unsafeUnwrap();
    insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    insertAnalysis({ id: analysisId, createdAt: 1, updatedAt: 1, name: asStr256("A"), slug: "a", anchorId: "A1", projectId: null })._unsafeUnwrap();
    const root = workspaceRootForAnalysisId(analysisId)._unsafeUnwrap();
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
        const root = seedAnalysis("ana-1");
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
        const root = seedAnalysis("ana-1");

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
        seedAnalysis("ana-1");

        for (const materialize of [false, true]) {
            const response = await resolve("ana-1", [{ kind: "workspace-file", path: "../../outside.txt" }], materialize);
            const [entry] = ((await response.json()) as ResolvedArtifacts).entries;
            expect(entry).toMatchObject({ path: null, degraded: true });
            if (materialize) expect(entry?.error?.type).toBe("unavailable");
        }
    });

    test("an analysis whose folder cannot be located resolves each entry to `unresolved`", async () => {
        const response = await resolve("no-such-analysis", [{ kind: "workspace-file", path: "runs/out.csv" }], true);

        const [entry] = ((await response.json()) as ResolvedArtifacts).entries;
        expect(entry).toEqual({ kind: "workspace-file", path: null, degraded: true, error: { type: "unresolved" } });
    });

    test("a presentation id that is not `pres-` and a digest is 400 `validation_error`, and writes nothing", async () => {
        const root = seedAnalysis("ana-1");

        const response = await resolve("ana-1", [{ kind: "svg", presId: "../../escape", markup: "<svg/>" }], true);

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error" });
        expect(existsSync(join(root, "presentations"))).toBe(false);
    });
});
