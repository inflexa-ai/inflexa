import { afterEach, describe, expect, test } from "bun:test";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { makeLocalAuth, type DataProfileStatus, type DataProfileTriggerParams, type SignableInput, computeInputSignature } from "@inflexa-ai/harness";

import { ensureProfileAtParity, forceReprofile, reprofileForInputChange, seedProfileLedger, type ProfileParitySeams } from "./profile_trigger.ts";
import { __resetGaugeForTest } from "./agent_switch.ts";
import type { HarnessRuntime } from "./runtime.ts";
import { type StagedInput } from "../staging/staging.ts";
import type { Analysis } from "../../types/analysis.ts";

// The seed step feeds the agent-switch gauge (marks a data profile busy on dispatch); it mutates
// the shared gauge singleton, so drop that state between tests to keep it out of any later gauge read.
afterEach(() => __resetGaugeForTest());

// The parity ladder is exercised entirely offline: reconcile, enumerate, the ledger read, clear,
// the workspace data-dir resolution, staging, seed, trigger, and the force-only retry-claim/run edges
// are injected as fakes (no Postgres, no Docker, no model), mirroring the BootSeams/SendSeams pattern. The happy path uses the REAL
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
    return { status, error: null, startedAt: null, completedAt: null, result: null, workflowId: null, seedInputFileIds: null };
}

/**
 * One input file as the ledger records it. Defaults keep the drift tests readable: a test that only
 * cares about the id set writes `file("f1")`, and one that exercises an in-place edit overrides `size`
 * or `mtimeMs` on the same id.
 */
function file(fileId: string, size = 10, mtimeMs = 1000): SignableInput {
    return { fileId, size, mtimeMs };
}

/** The path set a fresh enumerate would return for `files` — the ladder's "are there inputs" gate. */
function enumerated(files: SignableInput[]): ReadonlySet<string> {
    return new Set(files.map((f) => `inputs/local/${f.fileId}`));
}

/** A `completed` status of the pre-signature era — a result carrying no drift comparand. */
function completedWith(): DataProfileStatus {
    return {
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        result: { summary: "s", files: [], profiledAt: "2026-01-01T00:00:00Z" },
        workflowId: null,
        seedInputFileIds: null,
    };
}

/** A `completed` status written by a CURRENT harness: an input signature, and no per-file list. */
function completedWithSignature(files: SignableInput[]): DataProfileStatus {
    return {
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        result: { summary: "s", files: [], inputSignature: computeInputSignature(files), profiledAt: "2026-01-01T00:00:00Z" },
        workflowId: null,
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
        // A fixed workspace data dir — no real anchor exists offline, and the fake `stage` ignores it.
        dataDir: () => ok("/tmp/parity-data"),
        // Default: nothing on disk yet — the state every (re-)trigger path is in, and the one a failed
        // row must materialize out of. A test asserting the skip overrides this to `true`.
        materialized: () => ok(false),
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
        const { seams, ran } = trackingSeams({ enumerate: () => ok(new Set<string>()), loadStatus: () => okAsync(completedWith()) });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome).toEqual({ kind: "cleared", materialized: false });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("a clear skipped by the running guard (raced a live run) is already_running", async () => {
        const { seams } = trackingSeams({
            enumerate: () => ok(new Set<string>()),
            loadStatus: () => okAsync(completedWith()),
            clear: () => okAsync(false),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running", materialized: false });
    });

    test("a clear fault is failed", async () => {
        const { seams } = trackingSeams({
            enumerate: () => ok(new Set<string>()),
            loadStatus: () => okAsync(completedWith()),
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
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "no_inputs", materialized: false });
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
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running", materialized: false });
        expect(clearCalled).toBe(false);
    });
});

describe("ensureProfileAtParity — a completed row on a chat open", () => {
    test("a completed profile is left alone, even when the current input set has moved", async () => {
        // The ladder used to compare the enumerated set against the profile's recorded one and
        // re-profile on any difference. It no longer asks: a chat open is not evidence that anything
        // changed, and the party that would know re-profiles on its own edge.
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1"), file("f2"), file("f3")])),
            loadStatus: () => okAsync(completedWith()),
            materialized: () => ok(true),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_profiled", materialized: true });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("an in-place rewrite is not re-profiled either — nothing here claims the bytes moved", async () => {
        // `deriveFileId` hashes `anchorId|path`, so an edit at the same path moves only size and mtime.
        // Reading that as "the data changed" is what fired a full LLM re-profile on a `git checkout`,
        // an `rsync` without `-a`, or an unzip. `forceReprofile` remains the repair for a real edit.
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1", 999, 5000), file("f2")])),
            loadStatus: () => okAsync(completedWithSignature([file("f1"), file("f2")])),
            materialized: () => ok(true),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_profiled", materialized: true });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("a completed row whose tree is behind is re-materialized, still without re-profiling", async () => {
        // Materialization is not conditioned on the profile lifecycle: a workspace behind the database
        // withholds the user's files from the agent whatever the ledger says.
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1"), file("f2")])),
            loadStatus: () => okAsync(completedWith()),
            materialized: () => ok(false),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_profiled", materialized: true });
        expect(ran.stage).toBe(true);
        expect(ran).toMatchObject({ seed: false, trigger: false });
    });

    test("a completed row with a null result is not re-profiled on open", async () => {
        // `completed` with no result is the empty-manifest path. It used to read as drift and re-trigger
        // on every open; there is nothing here to establish that anything has changed since.
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1"), file("f2")])),
            loadStatus: () => okAsync(statusOf("completed")),
            materialized: () => ok(true),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_profiled", materialized: true });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("a failed row whose set is still materialized is skipped_failed — reported materialized, nothing written", async () => {
        // The failed attempt's own input set is the one on disk, so the failure IS evidence about it:
        // materialization has nothing to do, and re-running it unasked is the loop managed parity
        // refuses. Retry stays deliberate ({@link forceReprofile}).
        //
        // `materialized: true` alongside `{stage: false}` is the point of the field, not a contradiction: it
        // reports the materialization STATE the check finished in — the predicate just confirmed the
        // files are on disk — never whether this drive did the writing.
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(new Set(["f1", "f2"])),
            loadStatus: () => okAsync(statusOf("failed")),
            materialized: () => ok(true),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "skipped_failed", materialized: true });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("a failed row whose set is not materialized stages, retry-claims, and runs", async () => {
        // Issue #258 at the ladder level: a failed profile used to withhold materialization forever, so
        // every input registered afterwards existed only in the database. Now the files land first, and
        // the drift they represent — the tree no longer matching the set that failed — earns a retry via
        // the `failed → running` claim the trigger's pending/completed CAS cannot make.
        let claimed = false;
        let ranRun = false;
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(new Set(["f1", "f2", "f3"])),
            loadStatus: () => okAsync(statusOf("failed")),
            materialized: () => ok(false),
            retryClaim: () => {
                claimed = true;
                return okAsync(true);
            },
            run: async () => {
                ranRun = true;
            },
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: true, materialized: true });
        expect(ran.stage).toBe(true);
        expect(ran.seed).toBe(true);
        expect(claimed).toBe(true);
        expect(ranRun).toBe(true);
        // The trigger's CAS never claims a `failed` row, so parity must not spend a dispatch on it.
        expect(ran.trigger).toBe(false);
    });

    test("a failed row whose retry claim is lost is failed — the files are still materialized", async () => {
        // Another attempt moved the row on between our read and the claim. The profile decision fails,
        // but materialization already happened and is reported, so the caller can tell "the inputs are
        // on disk but profiling did not run" from "nothing happened".
        const { seams, ran } = trackingSeams({
            loadStatus: () => okAsync(statusOf("failed")),
            materialized: () => ok(false),
            retryClaim: () => okAsync(false),
        });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome.kind).toBe("failed");
        expect(outcome.materialized).toBe(true);
        expect(ran.stage).toBe(true);
    });

    test("a staging failure stops before the profile decision", async () => {
        const { seams, ran } = trackingSeams({
            stage: async () => {
                ran.stage = true;
                return err({ type: "staging_failed", cause: new Error("disk full") });
            },
        });
        const outcome = await ensureProfileAtParity(stubRuntime, ANALYSIS, seams);
        expect(outcome).toEqual({ kind: "failed", reason: "staging inputs failed (staging_failed)", materialized: false });
        // Materialization is a precondition for seeding: there is nothing coherent to decide about a
        // profile over a tree that did not materialize.
        expect(ran.seed).toBe(false);
        expect(ran.trigger).toBe(false);
    });

    test("a completed row asks whether it is materialized, and stops there when it is", async () => {
        // The steady-state chat open. The predicate is now consulted rather than inferred from parity:
        // the ladder no longer compares input sets, so "the profile covered this set" can no longer
        // stand in for "the set is on disk". It stays a stat/readdir walk — no hash, no staging.
        let askedMaterialized = false;
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1"), file("f2")])),
            loadStatus: () => okAsync(completedWith()),
            materialized: () => {
                askedMaterialized = true;
                return ok(true);
            },
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_profiled", materialized: true });
        expect(askedMaterialized).toBe(true);
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("a pending / never-profiled analysis triggers (not restarted)", async () => {
        const { seams, ran } = trackingSeams({ enumerate: () => ok(new Set(["f1", "f2"])), loadStatus: () => okAsync(null) });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: false, materialized: true });
        expect(ran.stage).toBe(true);
    });

    test("a running profile skips without staging", async () => {
        const { seams, ran } = trackingSeams({ enumerate: () => ok(new Set(["f1", "f2"])), loadStatus: () => okAsync(statusOf("running")) });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running", materialized: false });
        expect(ran.stage).toBe(false);
    });
});

describe("reprofileForInputChange", () => {
    test("re-profiles a completed row — the input mutation IS the evidence", async () => {
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1"), file("f2"), file("f3")])),
            loadStatus: () => okAsync(completedWith()),
            trigger: async () => "restarted",
        });
        expect(await reprofileForInputChange(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: true, materialized: true });
        expect(ran.stage).toBe(true);
        expect(ran.seed).toBe(true);
    });

    test("re-profiles a completed row even when the tree is already materialized", async () => {
        // The materialized predicate answers "is the tree current", never "should this re-profile".
        // Removing an input the workspace never held would otherwise leave the profile describing it.
        const { seams } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1")])),
            loadStatus: () => okAsync(completedWith()),
            materialized: () => ok(true),
            trigger: async () => "restarted",
        });
        expect((await reprofileForInputChange(stubRuntime, ANALYSIS, seams)).kind).toBe("triggered");
    });

    test("retries a failed row instead of skipping it — that set is not the one that failed", async () => {
        let claimed = false;
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1"), file("f2")])),
            loadStatus: () => okAsync(statusOf("failed")),
            // Deliberately `true`: the open drive would short-circuit to `skipped_failed` here, and an
            // input mutation must not, because the set demonstrably moved.
            materialized: () => ok(true),
            retryClaim: () => {
                claimed = true;
                return okAsync(true);
            },
            run: async () => {},
        });
        expect(await reprofileForInputChange(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: true, materialized: true });
        expect(claimed).toBe(true);
        expect(ran.stage).toBe(true);
    });

    test("an emptied input set clears the profile rather than re-profiling nothing", async () => {
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(new Set<string>()),
            loadStatus: () => okAsync(completedWith()),
        });
        expect(await reprofileForInputChange(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "cleared", materialized: false });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
    });

    test("defers to a live run — staging would delete the tree its sandbox is reading", async () => {
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(enumerated([file("f1")])),
            loadStatus: () => okAsync(statusOf("running")),
        });
        expect(await reprofileForInputChange(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running", materialized: false });
        expect(ran).toEqual({ stage: false, seed: false, trigger: false });
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
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running", materialized: true });
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
            dataDir: () => ok("/tmp/parity-data"),
            materialized: () => ok(false),
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

        expect(outcome).toEqual({ kind: "triggered", restarted: false, materialized: true });
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
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: false, materialized: true });
    });

    test("a reconcile fault is swallowed (best-effort) — parity still proceeds", async () => {
        const { seams } = trackingSeams({
            reconcile: () => errAsync({ type: "query_failed", op: "reconcileOrphanedDataProfile", cause: new Error("db blip") }),
        });
        expect(await ensureProfileAtParity(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: false, materialized: true });
    });
});

describe("forceReprofile", () => {
    test("a completed profile at parity still re-profiles (force ignores the drift gate)", async () => {
        const { seams, ran } = trackingSeams({
            enumerate: () => ok(new Set(["f1", "f2"])),
            loadStatus: () => okAsync(completedWith()),
            trigger: async () => "restarted",
        });
        expect(await forceReprofile(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: true, materialized: true });
        expect(ran.stage).toBe(true);
    });

    test("an already-materialized set is re-staged anyway — force never consults the predicate", async () => {
        // Deliberate acts keep materializing unconditionally: that is what makes force the repair path
        // for a tree the predicate misjudges (a hand-edited or half-deleted staged tree it reads as
        // current), and it keeps the predicate on the one call path that needed it.
        let askedMaterialized = false;
        const { seams, ran } = trackingSeams({
            materialized: () => {
                askedMaterialized = true;
                return ok(true);
            },
        });
        expect((await forceReprofile(stubRuntime, ANALYSIS, seams)).kind).toBe("triggered");
        expect(askedMaterialized).toBe(false);
        expect(ran.stage).toBe(true);
    });

    test("an empty input set is no_inputs — nothing staged", async () => {
        const { seams, ran } = trackingSeams({ enumerate: () => ok(new Set<string>()) });
        expect(await forceReprofile(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "no_inputs", materialized: false });
        expect(ran.stage).toBe(false);
    });

    test("a live run is already_running — nothing staged", async () => {
        const { seams, ran } = trackingSeams({ loadStatus: () => okAsync(statusOf("running")) });
        expect(await forceReprofile(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running", materialized: false });
        expect(ran.stage).toBe(false);
    });

    test("a trigger CAS lost passes through as already_running", async () => {
        const { seams } = trackingSeams({ trigger: async () => "already_running" });
        expect(await forceReprofile(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "already_running", materialized: true });
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
        expect(await forceReprofile(stubRuntime, ANALYSIS, seams)).toEqual({ kind: "triggered", restarted: true, materialized: true });
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
