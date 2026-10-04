import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import type { AnalysisPurgeOutcome, DbError as PgError } from "@inflexa-ai/harness";

import type { BusyReason } from "../../api/analyses.ts";
import { runCliAsync } from "../../test_support/cli.ts";
import { freshDb } from "../../test_support/db.ts";
import { startTestServer, type TestServer } from "../../test_support/server.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { getAnchor, listAnalysesByAnchor } from "../../db/primary_query.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Anchor } from "../../types/anchor.ts";
import type { Str256 } from "../../lib/types.ts";
import { canonicalPath } from "../../lib/paths.ts";
import { reclaimDeadAnchors, type PurgeAnalysisFn } from "./backstop.ts";
import { writeMarker } from "./marker.ts";

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-repair-"));
    created.push(dir);
    return dir;
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

// `repair` is a client of the local server: the child sends the path to the server of this process, which
// reads the marker and writes the row of the sandboxed database.
describe("inflexa repair and prune (e2e)", () => {
    let server: TestServer;

    beforeEach(() => {
        server = startTestServer();
    });

    afterEach(async () => {
        await server.stop();
    });

    test("re-points an anchor's cached path to the marker's current location", async () => {
        const moved = tmp();
        writeMarker(moved, "A1")._unsafeUnwrap();
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: "/stale/old/path", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();

        const result = await runCliAsync(["repair", moved], { env: server.childEnv });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Repaired anchor A1");
        // Read back through the DB: the cached path now matches the marker's (canonical) location.
        expect(getAnchor("A1")._unsafeUnwrap()?.cachedPath).toBe(canonicalPath(moved));
    });

    test("prune with no dead anchor says so and asks nothing", async () => {
        const result = await runCliAsync(["prune"], { env: server.childEnv });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Nothing to prune.");
    });

    test("fails when there is no marker at the path", async () => {
        const empty = tmp();
        const result = await runCliAsync(["repair", empty], { env: server.childEnv });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("No marker");
    });
});

// The reclaim stage's contract IS its order: the SQLite rows hold the only copy of the analysis ids
// the purge is addressed by, so deleting them first strands every footprint beyond any retry — in
// bulk, and while reporting success. These drive the REAL SQLite store and have each purge read it
// back, so "the rows were still there when the purge ran" is observed rather than inferred from a
// recorded call order. Only the Postgres purge is faked; the server passes the purge over its own pool.
describe("prune reclaims Postgres before it touches SQLite", () => {
    const DEAD_ANCHOR = "anchor-dead";
    const PURGED: AnalysisPurgeOutcome = { threads: 2, messages: 40, workflows: 3, vectorIndexDropped: true };
    const pgErr: PgError = { type: "query_failed", op: "purgeAnalysis", cause: new Error("boom") };

    /** Seed a dead anchor with `count` analyses homed in it, and hand back the analyses. */
    function seedDeadAnchor(count: number): Analysis[] {
        insertAnchor({ id: DEAD_ANCHOR, createdAt: 1, updatedAt: 1, cachedPath: "/gone/forever", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        const analyses: Analysis[] = [];
        for (let i = 0; i < count; i += 1) {
            analyses.push(
                insertAnalysis({
                    id: `analysis-${i}`,
                    createdAt: 1,
                    updatedAt: 1,
                    // The brand is a `str256` boundary check on user input; these literals are fixed,
                    // short, and non-empty, so the cast asserts what the constructor would verify.
                    name: `Analysis ${i}` as Str256,
                    slug: `analysis-${i}`,
                    anchorId: DEAD_ANCHOR,
                    projectId: null,
                })._unsafeUnwrap(),
            );
        }
        return analyses;
    }

    /** The dead anchor row, read back through the store the prune actually deletes from. */
    function deadAnchor(): Anchor | null {
        return getAnchor(DEAD_ANCHOR)._unsafeUnwrap();
    }

    /** The busy gate of an analysis that no work holds. */
    const idle = async (): Promise<BusyReason[]> => [];

    /** Ids still homed at the dead anchor, newest-first as the query returns them. */
    function survivingAnalysisIds(): string[] {
        return listAnalysesByAnchor(DEAD_ANCHOR)
            ._unsafeUnwrap()
            .map((a) => a.id);
    }

    /**
     * A purge over a fixed outcome, recording what each call saw. `sqliteAtPurge` is the order proof: it
     * captures the live SQLite row set at the instant of each call, so a reclaim that deleted first would
     * record an empty store here even though every call still happened.
     */
    function recordingPurge(fail?: (attempt: number) => boolean): { purge: PurgeAnalysisFn; purged: string[]; sqliteAtPurge: string[][] } {
        const purged: string[] = [];
        const sqliteAtPurge: string[][] = [];
        const purge: PurgeAnalysisFn = (analysisId) => {
            purged.push(analysisId);
            sqliteAtPurge.push(survivingAnalysisIds());
            return fail?.(purged.length) ? errAsync<AnalysisPurgeOutcome, PgError>(pgErr) : okAsync<AnalysisPurgeOutcome, PgError>(PURGED);
        };
        return { purge, purged, sqliteAtPurge };
    }

    test("every analysis is purged while its SQLite row is still present, and only then deleted", async () => {
        const seeded = seedDeadAnchor(2);
        const t = recordingPurge();

        const outcome = await reclaimDeadAnchors([deadAnchor()!], t.purge, idle);

        expect(outcome.isOk()).toBe(true);
        expect(t.purged.toSorted()).toEqual(seeded.map((a) => a.id).toSorted());
        // The whole point: at BOTH purges the store still held BOTH rows. A reclaim that deleted an
        // anchor's rows as it went would show the set shrinking here while every call still happened.
        for (const seen of t.sqliteAtPurge) expect(seen.toSorted()).toEqual(seeded.map((a) => a.id).toSorted());
        // And afterwards the rows and the anchor are gone, so the prune did complete.
        expect(survivingAnalysisIds()).toEqual([]);
        expect(deadAnchor()).toBeNull();
        expect(outcome._unsafeUnwrap()).toEqual({ purged: seeded.length });
    });

    test("an anchor that held no analyses is pruned with no purge at all", async () => {
        insertAnchor({ id: DEAD_ANCHOR, createdAt: 1, updatedAt: 1, cachedPath: "/gone/forever", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        const t = recordingPurge();

        const outcome = await reclaimDeadAnchors([deadAnchor()!], t.purge, idle);

        // Nothing to reclaim ⇒ the purge, and with it the need for a booted runtime, never comes.
        expect(t.purged).toEqual([]);
        // The anchor is still pruned; skipping the reclaim skips only the reclaim.
        expect(outcome._unsafeUnwrap()).toEqual({ purged: 0 });
        expect(deadAnchor()).toBeNull();
    });

    test("a failed purge leaves every row standing, and the re-run completes", async () => {
        const seeded = seedDeadAnchor(2);
        // Fails on the SECOND analysis: a failure on the first could pass with the deletes running
        // ahead of the purges for every analysis but that one.
        const failing = recordingPurge((attempt) => attempt === 2);

        const aborted = await reclaimDeadAnchors([deadAnchor()!], failing.purge, idle);

        expect(aborted._unsafeUnwrapErr()).toMatchObject({ type: "purge_failed", cause: pgErr });
        // Including the analysis whose purge DID succeed: the anchor is deleted as a unit, so keeping
        // one of its rows and dropping the other would leave a half-pruned anchor no retry can finish.
        expect(survivingAnalysisIds().toSorted()).toEqual(seeded.map((a) => a.id).toSorted());
        expect(deadAnchor()).not.toBeNull();

        // The recovery the abort promises: the anchor is still dead, the analyses are still listed, and
        // the purge is idempotent — so running it again is all it takes.
        const retry = recordingPurge();
        const outcome = await reclaimDeadAnchors([deadAnchor()!], retry.purge, idle);

        expect(outcome.isOk()).toBe(true);
        expect(retry.purged.toSorted()).toEqual(seeded.map((a) => a.id).toSorted());
        expect(survivingAnalysisIds()).toEqual([]);
        expect(deadAnchor()).toBeNull();
    });
});
