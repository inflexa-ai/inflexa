import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import type { AnalysisPurgeOutcome, DbError as PgError, Pool } from "@inflexa-ai/harness";

import type { BusyReason } from "../../api/analyses.ts";
import type { PruneAnchorsResponse, RelocateAnchorResponse, RepairAnchorResponse } from "../../api/anchors.ts";
import type { ApiError } from "../../api/common.ts";
import type { ServerState } from "../../api/server.ts";
import { insertAnalysis, insertAnalysisInput, insertAnchor } from "../../db/primary_mutation.ts";
import { getAnchor, listAnalysesByAnchor, listAnalysisInputs } from "../../db/primary_query.ts";
import { asStr256 } from "../../lib/types.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { freshDb } from "../../test_support/db.ts";
import { idleBoot } from "../../test_support/server.ts";
import type { ServerBoot } from "../boot.ts";
import { anchorRoutes, type AnchorRouteOpts } from "./anchors.ts";

// The routes alone, with no app and no bearer check: `app.test.ts` covers those. The purge and the busy gate
// are fakes, because each needs Postgres. Each `as` cast of a body below reads JSON that the route under test
// builds from the same `src/api/` type.

const runtime = { pool: {} as unknown as Pool } as unknown as HarnessRuntime;
const readyBoot: ServerBoot = {
    state: (): ServerState => ({
        version: "0.0.0-test",
        apiVersion: 1,
        startedAt: "2026-10-02T00:00:00.000Z",
        phase: "ready",
        connection: { provider: "a", mode: "cliproxy", model: "m" },
    }),
    runtime: () => runtime,
    start: async () => undefined,
};
const PURGED: AnalysisPurgeOutcome = { threads: 0, messages: 0, workflows: 0, vectorIndexDropped: false };

function opts(busy: (analysisId: string) => BusyReason[] = () => []): { opts: AnchorRouteOpts; purged: string[] } {
    const purged: string[] = [];
    return {
        purged,
        opts: {
            busyReasons: async (analysisId) => busy(analysisId),
            purgeFor: () => (analysisId) => {
                purged.push(analysisId);
                return okAsync<AnalysisPurgeOutcome, PgError>(PURGED);
            },
        },
    };
}

function post(routes: ReturnType<typeof anchorRoutes>, path: string, body: unknown): Promise<Response> {
    return Promise.resolve(routes.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

const created: string[] = [];

function tmp(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-anchors-")));
    created.push(dir);
    return dir;
}

/** A dead anchor: it wrote a marker, and its folder is gone. */
function seedDead(id: string, analyses: string[] = []): void {
    insertAnchor({ id, createdAt: 1, updatedAt: 1, cachedPath: `/gone/${id}`, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    for (const analysisId of analyses) {
        insertAnalysis({
            id: analysisId,
            createdAt: 1,
            updatedAt: 1,
            name: asStr256(analysisId),
            slug: analysisId,
            anchorId: id,
            projectId: null,
        })._unsafeUnwrap();
    }
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("POST /api/v1/anchors/repair", () => {
    test("points the anchor of the marker at the folder, then reports nothing to repair", async () => {
        const dir = tmp();
        writeMarker(dir, "A1")._unsafeUnwrap();
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: "/stale", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        const routes = anchorRoutes(idleBoot());

        const repaired = (await (await post(routes, "/repair", { path: dir })).json()) as RepairAnchorResponse;
        expect(repaired).toEqual({ outcome: "repaired", anchorId: "A1", before: "/stale", after: dir });
        const again = (await (await post(routes, "/repair", { path: dir })).json()) as RepairAnchorResponse;
        expect(again.outcome).toBe("unchanged");
    });

    test("404 with no marker, and 400 for a relative path", async () => {
        const dir = tmp();
        const routes = anchorRoutes(idleBoot());
        const none = await post(routes, "/repair", { path: dir });
        expect(none.status).toBe(404);
        expect(((await none.json()) as ApiError).message).toBe(`No marker at ${dir}. Nothing to repair.`);
        expect((await post(routes, "/repair", { path: "here" })).status).toBe(400);
    });
});

describe("POST /api/v1/anchors/relocate", () => {
    test("one folder: a dry run reports the missing marker and changes nothing, then the change applies", async () => {
        const target = tmp();
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: "/old/place", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        const routes = anchorRoutes(idleBoot());

        const preview = (await (await post(routes, "/relocate", { fromPath: "/old/place", toPath: target, dryRun: true })).json()) as RelocateAnchorResponse;
        expect(preview).toEqual({ dryRun: true, relocated: [{ anchorId: "A1", before: "/old/place", after: target }], rawInputs: 0, markerMissing: true });
        expect(getAnchor("A1")._unsafeUnwrap()?.cachedPath).toBe("/old/place");

        await post(routes, "/relocate", { fromPath: "/old/place", toPath: target });
        expect(getAnchor("A1")._unsafeUnwrap()?.cachedPath).toBe(target);
    });

    test("one folder: 404 when no anchor is tracked there", async () => {
        const response = await post(anchorRoutes(idleBoot()), "/relocate", { fromPath: "/nowhere", toPath: tmp() });
        expect(response.status).toBe(404);
    });

    test("a prefix: each anchor under the tree, and the absolute inputs under it", async () => {
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: "/old/tree/a", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnchor({ id: "A2", createdAt: 1, updatedAt: 1, cachedPath: "/elsewhere", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis({ id: "X", createdAt: 1, updatedAt: 1, name: asStr256("x"), slug: "x", anchorId: "A2", projectId: null })._unsafeUnwrap();
        insertAnalysisInput({ path: "/old/tree/raw.csv", isDir: false, analysisId: "X", anchorId: null })._unsafeUnwrap();
        const routes = anchorRoutes(idleBoot());

        const preview = (await (await post(routes, "/relocate", { from: "/old/tree", to: "/new/tree", dryRun: true })).json()) as RelocateAnchorResponse;
        expect(preview.relocated).toEqual([{ anchorId: "A1", before: "/old/tree/a", after: "/new/tree/a" }]);

        const applied = (await (await post(routes, "/relocate", { from: "/old/tree", to: "/new/tree" })).json()) as RelocateAnchorResponse;
        expect(applied.rawInputs).toBe(1);
        expect(getAnchor("A1")._unsafeUnwrap()?.cachedPath).toBe("/new/tree/a");
        expect(listAnalysisInputs("X")._unsafeUnwrap()[0]?.path).toBe("/new/tree/raw.csv");
    });
});

describe("POST /api/v1/anchors/prune", () => {
    test("a dry run lists the dead anchors with their analysis counts and changes nothing", async () => {
        seedDead("D1", ["a1", "a2"]);
        const t = opts();
        const response = (await (await post(anchorRoutes(readyBoot, t.opts), "/prune", { dryRun: true })).json()) as PruneAnchorsResponse;
        expect(response).toEqual({ dryRun: true, dead: [{ anchorId: "D1", path: "/gone/D1", analysisCount: 2 }], pruned: [], skipped: [], purged: 0 });
        expect(t.purged).toEqual([]);
        expect(getAnchor("D1")._unsafeUnwrap()).not.toBeNull();
    });

    test("an anchor folder that moved under the folder of the client is not dead", async () => {
        const moved = tmp();
        writeMarker(moved, "M1")._unsafeUnwrap();
        insertAnchor({ id: "M1", createdAt: 1, updatedAt: 1, cachedPath: "/gone/M1", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();

        const response = (await (await post(anchorRoutes(readyBoot, opts().opts), "/prune", { dryRun: true, cwd: moved })).json()) as PruneAnchorsResponse;
        expect(response.dead).toEqual([]);
    });

    test("prunes only the named anchors, and keeps an anchor whose analysis is busy", async () => {
        seedDead("D1", ["a1"]);
        seedDead("D2", ["b1"]);
        seedDead("D3", ["c1"]);
        const t = opts((analysisId) => (analysisId === "b1" ? ["chat_turn"] : []));
        const response = (await (await post(anchorRoutes(readyBoot, t.opts), "/prune", { anchorIds: ["D1", "D2"] })).json()) as PruneAnchorsResponse;

        expect(response.pruned).toEqual(["D1"]);
        expect(response.skipped).toEqual([{ anchorId: "D2", analysisId: "b1", reasons: ["chat_turn"] }]);
        expect(response.purged).toBe(1);
        expect(t.purged).toEqual(["a1"]);
        expect(getAnchor("D1")._unsafeUnwrap()).toBeNull();
        expect(
            listAnalysesByAnchor("D2")
                ._unsafeUnwrap()
                .map((a) => a.id),
        ).toEqual(["b1"]);
        expect(getAnchor("D3")._unsafeUnwrap()).not.toBeNull();
    });

    test("work that starts after the check stops the prune before the purge of its analysis, with each row present", async () => {
        seedDead("D1", ["a1", "a2"]);
        // The purge of the first analysis starts a chat turn on the other one: the check of each analysis
        // passed before the first purge, thus only a check again before each purge can see the turn.
        const busyNow = new Set<string>();
        const purged: string[] = [];
        const raceOpts: AnchorRouteOpts = {
            busyReasons: async (analysisId) => (busyNow.has(analysisId) ? ["chat_turn"] : []),
            purgeFor: () => (analysisId) => {
                purged.push(analysisId);
                for (const other of ["a1", "a2"]) if (other !== analysisId) busyNow.add(other);
                return okAsync<AnalysisPurgeOutcome, PgError>(PURGED);
            },
        };

        const response = await post(anchorRoutes(readyBoot, raceOpts), "/prune", { anchorIds: ["D1"] });

        expect(response.status).toBe(409);
        const body = (await response.json()) as ApiError;
        expect(body.error).toBe("busy");
        expect(purged).toHaveLength(1);
        expect(body.message).toContain(purged[0] === "a1" ? "a2" : "a1");
        expect(
            listAnalysesByAnchor("D1")
                ._unsafeUnwrap()
                .map((a) => a.id)
                .toSorted(),
        ).toEqual(["a1", "a2"]);
        expect(getAnchor("D1")._unsafeUnwrap()).not.toBeNull();
    });

    test("503 `unavailable` with no runtime when a purge is necessary; an anchor with no analyses still goes", async () => {
        seedDead("D1", ["a1"]);
        const t = opts();
        const refused = await post(anchorRoutes(idleBoot(), t.opts), "/prune", { anchorIds: ["D1"] });
        expect(refused.status).toBe(503);
        expect(getAnchor("D1")._unsafeUnwrap()).not.toBeNull();

        seedDead("D2");
        const empty = (await (await post(anchorRoutes(idleBoot(), t.opts), "/prune", { anchorIds: ["D2"] })).json()) as PruneAnchorsResponse;
        expect(empty.pruned).toEqual(["D2"]);
        expect(t.purged).toEqual([]);
    });
});
