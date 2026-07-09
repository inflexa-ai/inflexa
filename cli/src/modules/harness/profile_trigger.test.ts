import { describe, expect, test } from "bun:test";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { makeLocalAuth, type DataProfileInputFile, type DataProfileStatus, type DataProfileTriggerParams } from "@inflexa-ai/harness";

import { ensureProfileAtParity, forceReprofile, type ProfileParitySeams } from "./profile_trigger.ts";
import { seedProfileLedger } from "./profile.ts";
import type { HarnessRuntime } from "./runtime.ts";
import { inputSignature, type StagedInput } from "../staging/staging.ts";
import type { Analysis } from "../../types/analysis.ts";

// The parity ladder is exercised entirely offline: reconcile, enumerate, the ledger read, clear,
// staging, seed, trigger, and the force-only retry-claim/run edges are injected as fakes (no Postgres,
// no Docker, no model), mirroring the BootSeams/SendSeams pattern. The happy path uses the REAL
// `seedProfileLedger` so the params reaching the trigger are exactly what `inflexa profile` builds —
// the seed's fileId mapping is verified via the fake pool's recorded query.

// Only `id`/`name` are read by the helper; the rest of the Analysis shape is inert here.
const ANALYSIS = { id: "a1", name: "My analysis" } as unknown as Analysis;

/** A staged manifest with two files, used for the (re-)trigger paths. */
const STAGED: StagedInput[] = [
    { fileId: "f1", mountName: "local", key: "a.csv", fileName: "a.csv", hash: "h1", size: 1, mtimeMs: 1000, relativePath: "inputs/local/a.csv" },
    { fileId: "f2", mountName: "local", key: "b.csv", fileName: "b.csv", hash: "h2", size: 2, mtimeMs: 2000, relativePath: "inputs/local/b.csv" },
];

/** A `DataProfileStatus` at the given lifecycle state with a null `result` (the drift-triggering shape). */
function statusOf(status: DataProfileStatus["status"]): DataProfileStatus {
    return { status, error: null, startedAt: null, completedAt: null, result: null, seedInputFileIds: null };
}

/**
 * One input file as the ledger records it. Defaults keep the drift tests readable: a test that only
 * cares about the id set writes `file("f1")`, and one that exercises an in-place edit overrides `size`
 * or `mtimeMs` on the same id.
 */
function file(fileId: string, size = 10, mtimeMs = 1000): DataProfileInputFile {
    return { fileId, size, mtimeMs };
}

/** The signature set a fresh enumerate would return for `files` — the drift comparand's left-hand side. */
function enumerated(files: DataProfileInputFile[]): ReadonlySet<string> {
    return new Set(files.map((f) => inputSignature(f.fileId, f.size, f.mtimeMs)));
}

/** A `completed` status whose profile was taken against exactly `files` — the drift comparand. */
function completedWith(files: DataProfileInputFile[]): DataProfileStatus {
    return {
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        result: { summary: "s", files: [], inputFileIds: files.map((f) => f.fileId), inputFiles: files, profiledAt: "2026-01-01T00:00:00Z" },
        seedInputFileIds: null,
    };
}

/**
 * A `completed` status written before `inputFiles` existed: it names WHICH files it covered but not
 * whether their bytes changed. It cannot prove parity, so the check must treat it as drift.
 */
function completedLegacy(fileIds: string[]): DataProfileStatus {
    return {
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        result: { summary: "s", files: [], inputFileIds: fileIds, profiledAt: "2026-01-01T00:00:00Z" },
        seedInputFileIds: null,
    };
}

/** A stub runtime whose pool/triggerDeps are never dereferenced (the seams stand in for every read). */
const stubRuntime = { pool: {}, triggerDeps: {} } as unknown as HarnessRuntime;

/** Seams recording whether each expensive edge ran, so a skip can assert the ladder stopped early. */
function trackingSeams(over: Partial<ProfileParitySeams>): { seams: ProfileParitySeams; ran: { stage: boolean; seed: boolean; trigger: boolean } } {
    const ran = { stage: false, seed: false, trigger: false };
    const seams: ProfileParitySeams = {
        // Default: no orphaned row (the common case) — `false` = nothing reset.
        reconcile: () => okAsync(false),
        // Default: a non-empty set equal to STAGED's file ids — the common (re-)trigger left-hand side.
        enumerate: () => ok(new Set(["f1", "f2"])),
        loadStatus: () => okAsync(null),
        clear: () => okAsync(true),
        stage: async () => {
            ran.stage = true;
            return ok(STAGED);
        },
        seed: () => {
            ran.seed = true;
            return okAsync({ auth: makeLocalAuth(), analysisId: ANALYSIS.id, stagedInputs: STAGED });
        },
        trigger: async () => {
            ran.trigger = true;
            return "started";
        },
        retryClaim: () => okAsync(false),
        run: async () => {},
        ...over,
    };
    return { seams, ran };
}

describe("ensureProfileAtParity — empty input set", () => {
    test("a settled profile over an emptied input set is cleared", async () => {
        const { seams, ran } = trackingSeams({ enumerate: () => ok(new Set<string>()), loadStatus: () => okAsync(completedWith([file("f1")])) });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome).toEqual({ kind: "cleared" });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("a clear skipped by the running guard (raced a live run) is already_running", async () => {
        const { seams } = trackingSeams({
            enumerate: () => ok(new Set<string>()),
            loadStatus: () => okAsync(completedWith([file("f1")])),
            clear: () => okAsync(false),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running" });
    });

    test("a clear fault is failed", async () => {
        const { seams } = trackingSeams({
            enumerate: () => ok(new Set<string>()),
            loadStatus: () => okAsync(completedWith([file("f1")])),
            clear: () => errAsync({ type: "query_failed", op: "clearDataProfile", cause: new Error("db down") }),
        });
        expect((await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).kind).toBe("failed");
    });

    test("an emptied set that was never profiled is no_inputs (no clear)", async () => {
        let clearCalled = false;
        const { seams } = trackingSeams({
            enumerate: () => ok(new Set<string>()),
            loadStatus: () => okAsync(null),
            clear: () => {
                clearCalled = true;
                return okAsync(true);
            },
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "no_inputs" });
        expect(clearCalled).toBe(false);
    });

    test("an emptied set never clears while a profile runs — already_running (no clear)", async () => {
        let clearCalled = false;
        const { seams } = trackingSeams({
            enumerate: () => ok(new Set<string>()),
            loadStatus: () => okAsync(statusOf("running")),
            clear: () => {
                clearCalled = true;
                return okAsync(true);
            },
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running" });
        expect(clearCalled).toBe(false);
    });
});

describe("ensureProfileAtParity — non-empty drift branch", () => {
    test("a completed profile covering the current set skips without staging", async () => {
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1"), file("f2")])),
            loadStatus: () => okAsync(completedWith([file("f1"), file("f2")])),
        });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome).toEqual({ kind: "already_profiled" });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("the set comparison is order-insensitive (same ids, different order → already_profiled)", async () => {
        const { seams } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1"), file("f2")])),
            loadStatus: () => okAsync(completedWith([file("f2"), file("f1")])),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_profiled" });
    });

    test("a completed profile whose set drifted re-profiles (restarted)", async () => {
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(new Set(["f1", "f2", "f3"])),
            loadStatus: () => okAsync(completedWith([file("f1"), file("f2")])),
            trigger: async () => "restarted",
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: true });
        expect(ran.stage).toBe(true);
    });

    test("a completed row with a null result is treated as drift (re-profiles)", async () => {
        const { seams, ran } = trackingSeams({ enumerate: () => ok(new Set(["f1", "f2"])), loadStatus: () => okAsync(statusOf("completed")) });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome.kind).toBe("triggered");
        expect(ran.stage).toBe(true);
    });

    test("an input rewritten in place is drift, even though its fileId is unchanged", async () => {
        // The defect this comparand exists to close: `deriveFileId` hashes `anchorId|path`, so editing
        // a file's bytes at the same path leaves the id set identical. Only size/mtime move.
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1", 999, 5000), file("f2")])),
            loadStatus: () => okAsync(completedWith([file("f1", 10, 1000), file("f2")])),
            trigger: async () => "restarted",
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: true });
        expect(ran.stage).toBe(true);
    });

    test("a same-size input touched to a new mtime is drift", async () => {
        const { seams } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1", 10, 9999)])),
            loadStatus: () => okAsync(completedWith([file("f1", 10, 1000)])),
            trigger: async () => "restarted",
        });
        expect((await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).kind).toBe("triggered");
    });

    test("a same-mtime input whose size changed is drift", async () => {
        const { seams } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1", 4096, 1000)])),
            loadStatus: () => okAsync(completedWith([file("f1", 10, 1000)])),
            trigger: async () => "restarted",
        });
        expect((await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).kind).toBe("triggered");
    });

    test("a completed row predating the signature field re-profiles once (never trusted)", async () => {
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1"), file("f2")])),
            loadStatus: () => okAsync(completedLegacy(["f1", "f2"])),
            trigger: async () => "restarted",
        });
        expect((await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).kind).toBe("triggered");
        expect(ran.stage).toBe(true);
    });

    test("a failed row is skipped_failed — never staged, seeded, or triggered", async () => {
        const { seams, ran } = trackingSeams({ enumerate: () => ok(new Set(["f1", "f2"])), loadStatus: () => okAsync(statusOf("failed")) });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "skipped_failed" });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("a pending / never-profiled analysis triggers (not restarted)", async () => {
        const { seams, ran } = trackingSeams({ enumerate: () => ok(new Set(["f1", "f2"])), loadStatus: () => okAsync(null) });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: false });
        expect(ran.stage).toBe(true);
    });

    test("a running profile skips without staging", async () => {
        const { seams, ran } = trackingSeams({ enumerate: () => ok(new Set(["f1", "f2"])), loadStatus: () => okAsync(statusOf("running")) });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running" });
        expect(ran.stage).toBe(false);
    });
});

describe("ensureProfileAtParity — faults", () => {
    test("an enumerate fault is failed before any ledger read", async () => {
        let statusRead = false;
        const { seams, ran } = trackingSeams({
            enumerate: () => err({ type: "query_failed", op: "enumerateInputSignatures", cause: new Error("db down") }),
            loadStatus: () => {
                statusRead = true;
                return okAsync(null);
            },
        });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome.kind).toBe("failed");
        expect(statusRead).toBe(false);
        expect(ran.stage).toBe(false);
    });

    test("a ledger read fault is failed (parity cannot be judged)", async () => {
        const { seams, ran } = trackingSeams({
            loadStatus: () => errAsync({ type: "query_failed", op: "loadDataProfileStatus", cause: new Error("db down") }),
        });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome.kind).toBe("failed");
        expect(ran.stage).toBe(false);
    });

    test("a seed fault is failed — no trigger", async () => {
        const { seams, ran } = trackingSeams({
            seed: () => errAsync({ type: "query_failed", op: "analyses.upsertAnalysis", cause: new Error("db down") }),
        });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome.kind).toBe("failed");
        expect(ran.trigger).toBe(false);
    });

    test("a trigger CAS lost to another attempt is already_running", async () => {
        const { seams } = trackingSeams({ trigger: async () => "already_running" });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running" });
    });

    test("a trigger failure is failed with a reason (parity never retries)", async () => {
        const { seams } = trackingSeams({ trigger: async () => "failed" });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed") expect(outcome.reason.length).toBeGreaterThan(0);
    });
});

describe("ensureProfileAtParity — trigger path (real seed)", () => {
    test("happy path triggers with the exact params inflexa profile builds", async () => {
        let capturedParams: DataProfileTriggerParams | null = null;
        const queries: { text: string; values: readonly unknown[] }[] = [];
        // A pool whose query resolves ok, so the REAL seedProfileLedger's upsert succeeds offline and
        // the fileId mapping it sends is observable.
        const runtime = {
            pool: {
                query: async (q: { text: string; values: readonly unknown[] }) => {
                    queries.push(q);
                    return { rows: [] };
                },
            },
            triggerDeps: {},
        } as unknown as HarnessRuntime;
        const seams: ProfileParitySeams = {
            reconcile: () => okAsync(false),
            enumerate: () => ok(new Set(["f1", "f2"])),
            loadStatus: () => okAsync(null),
            clear: () => okAsync(true),
            stage: async () => ok(STAGED),
            // The real shared core — this is the whole point of the assertion below.
            seed: seedProfileLedger,
            trigger: async (_deps, params) => {
                capturedParams = params;
                return "started";
            },
            retryClaim: () => okAsync(false),
            run: async () => {},
        };

        const outcome = await ensureProfileAtParity(runtime, ANALYSIS, seams);

        expect(outcome).toEqual({ kind: "triggered", restarted: false });
        expect(capturedParams).not.toBeNull();
        // The params profile.ts builds: local auth, the cli analysis id, the manifest verbatim.
        expect(capturedParams!.analysisId).toBe(ANALYSIS.id);
        expect(capturedParams!.stagedInputs).toBe(STAGED);
        expect(capturedParams!.auth).toEqual(makeLocalAuth());
        // The seed upserted with exactly the staged file ids (the ledger contract's inputFileIds).
        const seedQuery = queries.find((q) => q.text.includes("cortex_analysis_state"));
        expect(seedQuery).toBeDefined();
        expect(seedQuery!.values).toContain(JSON.stringify(["f1", "f2"]));
    });
});

describe("ensureProfileAtParity — orphaned-profile reconcile (S2)", () => {
    test("a wedged running row is reconciled before the status read, then re-triggers", async () => {
        // Before reconcile the ledger shows `running` (the orphaned row); reconcile resets it, so the
        // status read AFTER it sees no active profile and the ladder proceeds to trigger. This asserts
        // both the ordering (reconcile precedes the status read) and the self-heal it enables — the
        // same behaviour `inflexa profile` gets from `reconcileOrphanedDataProfile` in profile.ts.
        let reconciled = false;
        const { seams } = trackingSeams({
            reconcile: () => {
                reconciled = true;
                return okAsync(true);
            },
            loadStatus: () => (reconciled ? okAsync(null) : okAsync(statusOf("running"))),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: false });
    });

    test("a reconcile fault is swallowed (best-effort) — parity still proceeds", async () => {
        const { seams } = trackingSeams({
            reconcile: () => errAsync({ type: "query_failed", op: "reconcileOrphanedDataProfile", cause: new Error("db blip") }),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: false });
    });
});

describe("forceReprofile", () => {
    test("a completed profile at parity still re-profiles (force ignores the drift gate)", async () => {
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(new Set(["f1", "f2"])),
            loadStatus: () => okAsync(completedWith([file("f1"), file("f2")])),
            trigger: async () => "restarted",
        });
        expect(await forceReprofile(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: true });
        expect(ran.stage).toBe(true);
    });

    test("an empty input set is no_inputs — nothing staged", async () => {
        const { seams, ran } = trackingSeams({ enumerate: () => ok(new Set<string>()) });
        expect(await forceReprofile(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "no_inputs" });
        expect(ran.stage).toBe(false);
    });

    test("a live run is already_running — nothing staged", async () => {
        const { seams, ran } = trackingSeams({ loadStatus: () => okAsync(statusOf("running")) });
        expect(await forceReprofile(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running" });
        expect(ran.stage).toBe(false);
    });

    test("a trigger CAS lost passes through as already_running", async () => {
        const { seams } = trackingSeams({ trigger: async () => "already_running" });
        expect(await forceReprofile(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running" });
    });

    test("a failed row is retry-claimed and re-run → triggered (restarted)", async () => {
        let ranRun = false;
        const { seams } = trackingSeams({
            trigger: async () => "failed",
            retryClaim: () => okAsync(true),
            run: async () => {
                ranRun = true;
            },
        });
        expect(await forceReprofile(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: true });
        expect(ranRun).toBe(true);
    });

    test("a failed row whose retry claim is lost is failed — never re-run", async () => {
        let ranRun = false;
        const { seams } = trackingSeams({
            trigger: async () => "failed",
            retryClaim: () => okAsync(false),
            run: async () => {
                ranRun = true;
            },
        });
        expect((await forceReprofile(stubRuntime, ANALYSIS, seams)).kind).toBe("failed");
        expect(ranRun).toBe(false);
    });

    test("a claimed retry whose start rejects is failed", async () => {
        const { seams } = trackingSeams({
            trigger: async () => "failed",
            retryClaim: () => okAsync(true),
            run: async () => {
                throw new Error("start rejected");
            },
        });
        expect((await forceReprofile(stubRuntime, ANALYSIS, seams)).kind).toBe("failed");
    });
});
