import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, ok, okAsync, err } from "neverthrow";
import type { AnalysisPurgeOutcome, DbError as PgError, Pool } from "@inflexa-ai/harness";

import { runCli } from "../../test_support/cli.ts";
import { closeDb } from "../../db/primary.ts";
import { freshDb } from "../../test_support/db.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { getAnchor, listAnalysesByAnchor } from "../../db/primary_query.ts";
import type { PostgresConnection, PostgresError } from "../infra/postgres_types.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Anchor } from "../../types/anchor.ts";
import type { Str256 } from "../../lib/types.ts";
import { reclaimDeadAnchors, type PruneSeams } from "./backstop.ts";
import { canonicalPath, writeMarker } from "./marker.ts";

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

describe("inflexa repair (e2e)", () => {
    test("re-points an anchor's cached path to the marker's current location", () => {
        const moved = tmp();
        writeMarker(moved, "A1")._unsafeUnwrap();
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: "/stale/old/path", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        closeDb();

        const result = runCli(["repair", moved]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Repaired anchor A1");
        // Read back through the DB: the cached path now matches the marker's (canonical) location.
        expect(getAnchor("A1")._unsafeUnwrap()?.cachedPath).toBe(canonicalPath(moved));
    });

    test("fails when there is no marker at the path", () => {
        const empty = tmp();
        closeDb();
        const result = runCli(["repair", empty]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("No marker");
    });
});

// The reclaim stage's contract IS its order: the SQLite rows hold the only copy of the analysis ids
// the purge is addressed by, so deleting them first strands every footprint beyond any retry — in
// bulk, and while reporting success. These drive the REAL SQLite store and have each purge read it
// back, so "the rows were still there when the purge ran" is observed rather than inferred from a
// recorded call order. Only the Postgres side is faked; there is no container engine in a test.
describe("prune reclaims Postgres before it touches SQLite", () => {
    const DEAD_ANCHOR = "anchor-dead";
    const CONN: PostgresConnection = { host: "localhost", port: 8432, database: "inflexa", user: "inflexa", password: "pw" };
    // The seams never touch the pool, so a stand-in cast keeps every case offline. Mirrors the fake
    // pool the TUI's session and delete-ladder suites use.
    const fakePool = {} as unknown as Pool;
    const PURGED: AnalysisPurgeOutcome = { threads: 2, messages: 40, workflows: 3, vectorIndexDropped: true };
    const pgErr: PgError = { type: "query_failed", op: "purgeAnalysis", cause: new Error("boom") };

    /** Seed a dead anchor with `count` analyses homed in it, and hand back the anchor row. */
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

    /** Ids still homed at the dead anchor, newest-first as the query returns them. */
    function survivingAnalysisIds(): string[] {
        return listAnalysesByAnchor(DEAD_ANCHOR)
            ._unsafeUnwrap()
            .map((a) => a.id);
    }

    /**
     * Postgres-side seams over a fixed outcome, recording what each purge saw. `sqliteAtPurge` is the
     * order proof: it captures the live SQLite row set at the instant of each call, so a reclaim that
     * deleted first would record an empty store here even though every call still happened.
     */
    function seams(over: Partial<PruneSeams> = {}): { seams: PruneSeams; purged: string[]; sqliteAtPurge: string[][]; drains: number } {
        const purged: string[] = [];
        const sqliteAtPurge: string[][] = [];
        const state = { drains: 0 };
        const base: PruneSeams = {
            ensurePostgres: async () => ok<PostgresConnection, PostgresError>(CONN),
            openPool: () => fakePool,
            purgeAnalysis: (_pool, analysisId) => {
                purged.push(analysisId);
                sqliteAtPurge.push(survivingAnalysisIds());
                return okAsync<AnalysisPurgeOutcome, PgError>(PURGED);
            },
            drainPool: async () => {
                state.drains += 1;
            },
            ...over,
        };
        return {
            seams: base,
            purged,
            sqliteAtPurge,
            get drains() {
                return state.drains;
            },
        };
    }

    test("every analysis is purged while its SQLite row is still present, and only then deleted", async () => {
        const seeded = seedDeadAnchor(2);
        const t = seams();

        const outcome = await reclaimDeadAnchors([deadAnchor()!], t.seams);

        expect(outcome.isOk()).toBe(true);
        expect(t.purged.toSorted()).toEqual(seeded.map((a) => a.id).toSorted());
        // The whole point: at BOTH purges the store still held BOTH rows. A reclaim that deleted an
        // anchor's rows as it went would show the set shrinking here while every call still happened.
        for (const seen of t.sqliteAtPurge) expect(seen.toSorted()).toEqual(seeded.map((a) => a.id).toSorted());
        // And afterwards the rows and the anchor are gone, so the prune did complete.
        expect(survivingAnalysisIds()).toEqual([]);
        expect(deadAnchor()).toBeNull();
        expect(t.drains).toBe(1);
    });

    test("a Postgres that cannot be provisioned deletes nothing at all", async () => {
        const seeded = seedDeadAnchor(2);
        const pgDown: PostgresError = { type: "runtime_not_ready", message: "no container engine found" };
        const t = seams({ ensurePostgres: async () => err<PostgresConnection, PostgresError>(pgDown) });

        const outcome = await reclaimDeadAnchors([deadAnchor()!], t.seams);

        expect(outcome._unsafeUnwrapErr()).toEqual({ type: "postgres_unavailable", cause: pgDown });
        expect(t.purged).toEqual([]);
        // Nothing was lost — that is what the abort notice claims, and it has to be true.
        expect(survivingAnalysisIds().toSorted()).toEqual(seeded.map((a) => a.id).toSorted());
        expect(deadAnchor()).not.toBeNull();
        // No pool was ever opened, so there is nothing to drain.
        expect(t.drains).toBe(0);
    });

    test("a failed purge leaves every row standing, and the re-run completes", async () => {
        const seeded = seedDeadAnchor(2);
        let attempts = 0;
        // Fails on the SECOND analysis: a failure on the first could pass with the deletes running
        // ahead of the purges for every analysis but that one.
        const failing = seams({
            purgeAnalysis: () => {
                attempts += 1;
                return attempts === 1 ? okAsync<AnalysisPurgeOutcome, PgError>(PURGED) : errAsync<AnalysisPurgeOutcome, PgError>(pgErr);
            },
        });

        const aborted = await reclaimDeadAnchors([deadAnchor()!], failing.seams);

        expect(aborted._unsafeUnwrapErr()).toMatchObject({ type: "purge_failed", cause: pgErr });
        // Including the analysis whose purge DID succeed: the anchor is deleted as a unit, so keeping
        // one of its rows and dropping the other would leave a half-pruned anchor no retry can finish.
        expect(survivingAnalysisIds().toSorted()).toEqual(seeded.map((a) => a.id).toSorted());
        expect(deadAnchor()).not.toBeNull();
        expect(failing.drains).toBe(1); // the pool it opened is released even on the abort

        // The recovery the abort notice promises: the anchor is still dead, the analyses are still
        // listed, and the purge is idempotent — so running it again is all it takes.
        const retry = seams();
        const outcome = await reclaimDeadAnchors([deadAnchor()!], retry.seams);

        expect(outcome.isOk()).toBe(true);
        expect(retry.purged.toSorted()).toEqual(seeded.map((a) => a.id).toSorted());
        expect(survivingAnalysisIds()).toEqual([]);
        expect(deadAnchor()).toBeNull();
    });
});
