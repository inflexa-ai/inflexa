/**
 * Integration tests 10.6 + 10.13 — DBOS replay invariants.
 *
 * Test 10.6 — chaos recovery (tasks.md:102):
 *   "Kill mid-step after `runAgent` LLM call has cached its result but
 *    before `generateFileMetadata` runs. Verify: cached LLM result returns
 *    on replay (no re-issued API call), next `durableStep` runs forward."
 *
 * Test 10.13 — per-step sync, sequenced after registration + idempotent:
 *   "Runs inline in the child; a registration rejection still attempts it and
 *    its own failure is logged as a warning rather than displacing the
 *    registration error; idempotent on DBOS recovery."
 *
 * Pattern — DBOS-determinism-safe chaos:
 *
 *   DBOS replays a workflow with its ORIGINAL durable input and requires
 *   the STEP SEQUENCE (function name at each step-id) to be deterministic
 *   between attempts — a diverging sequence is rejected as
 *   `DBOSUnexpectedStepError`. That rules out the obvious "flip a
 *   module-level flag between runs" approach (which would skip a step on
 *   replay and change the sequence).
 *
 *   The body parks at `crashPoint()` mid-body, UNCONDITIONALLY. The test
 *   cancels the parked workflow from outside and resumes it
 *   (`recoverAtCrashPoint`): the body re-runs, cached step results return
 *   without re-invoking their closures, and any steps PAST the crash point
 *   run fresh.
 *
 *   Module-level counters incremented inside step closures stay at 1 for
 *   the steps that ran on the original attempt — proving the closure did
 *   NOT re-execute on replay. That is the load-bearing invariant
 *   production relies on for LLM-call deduplication across resume.
 *
 * Registration window:
 *
 *   DBOS is process-global: once `DBOS.launch()` runs (lazily inside
 *   `setupDbosForTests`, shared across the whole `bun test` invocation),
 *   further `registerWorkflow` calls are rejected with
 *   `DBOSConflictingRegistrationError`. Bun loads test files sequentially
 *   (load module → run `beforeAll` → run tests → next file), so this
 *   file's top-level registrations can fire AFTER an earlier file's
 *   launch. Every registration-heavy DBOS test file therefore self-heals:
 *   at module top it bounces an already-launched engine (a plain
 *   `DBOS.shutdown()` — no `deregister` — keeps every prior registration
 *   and reopens the registration window), then relaunches in `beforeAll`
 *   via `DBOS.launch()`, which reuses the config the rig already set.
 *   This makes the files order-independent within one bun process.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";

import { setupDbosForTests, waitForTerminal, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import { crashPoint, recoverAtCrashPoint, stepRecorded } from "../../../../__tests__/setup/dbos-crash.js";
import { silentLogger } from "../../../../__tests__/setup/logger.js";
import { captureMetrics } from "../../../../__tests__/setup/metrics.js";
import { recordRunCompleted, recordStepCompleted } from "../../../../lib/metrics.js";
import { errorOf } from "../../../../lib/thrown.js";

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine (see "Registration window" above).
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

// ── 10.6 — chaos mirror ─────────────────────────────────────────────────

let llmCallCounter = 0;
let metaCallCounter = 0;

/**
 * DBOS step caching, exercised in isolation. DBOS replays a workflow with
 * its ORIGINAL durable input and requires the step SEQUENCE (function
 * name at each step-id) to be deterministic between attempts — diverging
 * sequences surface as `DBOSUnexpectedStepError`.
 *
 * That rules out the obvious "flip a module-level flag between runs"
 * pattern: a conditional crash that's present on attempt 1 and absent on
 * attempt 2 changes the step sequence. The crash point is therefore
 * UNCONDITIONAL: the replay parks at the same point until the test releases it.
 */
const chaosMirror = DBOS.registerWorkflow(
    async (): Promise<{ llm: string; meta: string }> => {
        const llmResult = await DBOS.runStep(
            () => {
                llmCallCounter += 1;
                return Promise.resolve(`llm-${llmCallCounter}`);
            },
            { name: "llm:0:0" },
        );

        // The crash point is ALWAYS in the body so the step sequence on replay
        // matches the original — DBOS's determinism check rejects step sequences
        // that diverge between attempts.
        await crashPoint();

        const metaResult = await DBOS.runStep(
            () => {
                metaCallCounter += 1;
                return Promise.resolve(`meta-${metaCallCounter}`);
            },
            { name: "post-step.metadata" },
        );

        return { llm: llmResult, meta: metaResult };
    },
    { name: "chaos-mirror" },
);

// ── 10.6 — three-step mirror (defence-in-depth) ─────────────────────────

let stepACalls = 0;
let stepBCalls = 0;
let stepCCalls = 0;

/**
 * The crash point is unconditional — DBOS's determinism check requires the step
 * sequence to be identical between original execution and replay. On the
 * resume, the body re-runs from the top: A and B return cached results, and C
 * runs fresh.
 */
const threeStepMirror = DBOS.registerWorkflow(
    async (): Promise<{ a: number; b: number; c: number }> => {
        const a = await DBOS.runStep(
            () => {
                stepACalls += 1;
                return Promise.resolve(stepACalls);
            },
            { name: "three-step.a" },
        );
        const b = await DBOS.runStep(
            () => {
                stepBCalls += 1;
                return Promise.resolve(stepBCalls);
            },
            { name: "three-step.b" },
        );
        await crashPoint();
        const c = await DBOS.runStep(
            () => {
                stepCCalls += 1;
                return Promise.resolve(stepCCalls);
            },
            { name: "three-step.c" },
        );
        return { a, b, c };
    },
    { name: "three-step-mirror" },
);

// ── Outcome metrics recorded inside the terminal step ───────────────────

let terminalStepCalls = 0;

/**
 * Mirror of the placement rule of `lib/metrics.ts`: an outcome metric is
 * recorded INSIDE the DBOS step that persists the terminal status. The
 * unconditional crash point after it forces a replay through `resumeWorkflow`;
 * the cached step returns without running its closure, so each counter reads one.
 */
const terminalMetricMirror = DBOS.registerWorkflow(
    async (): Promise<{ terminalCalls: number }> => {
        await DBOS.runStep(
            () => {
                terminalStepCalls += 1;
                recordStepCompleted({ agentId: "mirror-agent", status: "completed", durationMs: 1_500 });
                recordRunCompleted({ workflow: "analysis", status: "completed", durationMs: 30_000 });

                return Promise.resolve();
            },
            { name: "persist-final-status" },
        );
        await crashPoint();
        await DBOS.runStep(() => Promise.resolve(undefined), { name: "post-terminal.tail" });
        return { terminalCalls: terminalStepCalls };
    },
    { name: "terminal-metric-mirror" },
);

// ── 10.13 — sync attempted after a registration rejection ───────────────

const REGISTRATION_REJECTION = "external registration failed: 1 row(s) rejected";
const SYNC_UNREACHABLE = "artifact store reachability lost";

let rejectionRegisterCalls = 0;
let rejectionSyncCalls = 0;
let rejectionMarkFailedCalls = 0;

/** Stands in for `deps.artifactRegistry.sync`, which throws on a persistent failure. */
function unreachableSync(): Promise<void> {
    rejectionSyncCalls += 1;
    return Promise.reject(new Error(SYNC_UNREACHABLE));
}

const registrationRejectionMirror = DBOS.registerWorkflow(
    async (): Promise<never> => {
        // Mirror of `sandbox-step`'s lineage-attestation block. Registration and
        // the byte-sync are sequenced independently: a registration rejection
        // still attempts the sync (otherwise the rows that DID register are left
        // with `artifact_id` set and `file_id` NULL — bytes never uploaded), a
        // throw from that sync is warn-logged and swallowed, and the REGISTRATION
        // error is what fails the step.
        //
        // Neither operation is `DBOS.runStep`-wrapped in the body, so neither is
        // mirrored as one here. `failStep`'s `mark-failed-attestation` is the
        // block's only checkpoint, and the test below reads the recorded step
        // list to assert the added sync attempt took no function id.
        try {
            rejectionRegisterCalls += 1;
            throw new Error(REGISTRATION_REJECTION);
        } catch (registrationErr) {
            try {
                await unreachableSync();
            } catch (syncErr) {
                // This body mirrors `sandbox-step`'s; keep it on the seam so the mirror
                // stays faithful (and silent) rather than printing during the run.
                silentLogger
                    .named("mirror")
                    .named("post-step.sync")
                    .warn("failed after a registration rejection (non-fatal)", silentLogger.errorFields(syncErr));
            }
            await DBOS.runStep(
                () => {
                    rejectionMarkFailedCalls += 1;

                    return Promise.resolve();
                },
                { name: "mark-failed-attestation" },
            );
            throw registrationErr;
        }
    },
    { name: "registration-rejection-mirror" },
);

// ── 10.13 — a replayed sync moves no bytes ──────────────────────────────

/** One `cortex_artifacts` row, cut down to the columns the sync selection reads. */
type LedgerRow = {
    path: string;
    role: string;
    artifactId: string | null;
    fileId: string | null;
};

let syncLedger: LedgerRow[] = [];
let syncCalls = 0;
/** Rows uploaded by each `syncStepArtifacts` invocation, in call order. */
let syncUploads: number[] = [];

/**
 * Stands in for `deps.artifactRegistry.sync`, over the selection the harness
 * hands it: `queryUnsyncedStepArtifacts` returns step-output rows with
 * `artifact_id IS NOT NULL AND file_id IS NULL`. A row is therefore in the
 * queue only until an upload stamps it with a `file_id`; a row the registry
 * rejected never enters it at all, having no `artifact_id`.
 */
function syncStepArtifacts(): Promise<void> {
    syncCalls += 1;
    const unsynced = syncLedger.filter((r) => r.role === "step_output" && r.artifactId !== null && r.fileId === null);
    for (const row of unsynced) row.fileId = `file-${row.path}`;
    syncUploads.push(unsynced.length);

    return Promise.resolve();
}

const idempotentSyncMirror = DBOS.registerWorkflow(
    async (): Promise<{ uploads: number[]; tail: string }> => {
        // A bare await, as in `sandbox-step`: the sync takes no DBOS function id,
        // so replay re-executes it rather than replaying a cached result. What
        // keeps the second pass from re-uploading is the selection it runs over —
        // the first pass gave every row it uploaded a `file_id`, and a row
        // carrying one is no longer unsynced.
        await syncStepArtifacts();

        // Unconditional crash point — see threeStepMirror's note on DBOS's
        // determinism requirement for step sequences across replay.
        await crashPoint();

        const tail = await DBOS.runStep(() => Promise.resolve("tail-ok"), { name: "post-step.tail" });

        return { uploads: [...syncUploads], tail };
    },
    { name: "idempotent-sync-mirror" },
);

// ── Helpers ─────────────────────────────────────────────────────────────

// ── Lifecycle ───────────────────────────────────────────────────────────

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("workflow_replay");
    // Relaunch when the module-top registration-window bounce stopped the
    // engine; a no-op when the rig's lazy launch above did the launching.
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("Integration test 10.6 — chaos recovery", () => {
    it("cached LLM step returns its cached result on replay; downstream step runs forward", async () => {
        llmCallCounter = 0;
        metaCallCounter = 0;

        const wfId = rig.nextWorkflowId("chaos-");

        // Run #1 parks at the crash point after step 1, and the test cancels it there.
        const handle1 = await DBOS.startWorkflow(chaosMirror, {
            workflowID: wfId,
        })();
        handle1.getResult().catch(() => {});

        // Resume the same workflow ID. DBOS replays the body — `llm:0:0`
        // returns its cached value, then `post-step.metadata` runs fresh.
        const handle2 = await recoverAtCrashPoint<{ llm: string; meta: string }>(wfId, () => stepRecorded(wfId, "llm:0:0"));
        const result = await handle2.getResult();

        // Load-bearing assertion: the step's CLOSURE did not run a second
        // time. The cached value (`llm-1`, NOT `llm-2`) is what the body
        // observed on replay.
        expect(result.llm).toBe("llm-1");
        expect(llmCallCounter).toBe(1);

        expect(result.meta).toBe("meta-1");
        expect(metaCallCounter).toBe(1);

        const status2 = await DBOS.getWorkflowStatus(wfId);
        expect(status2?.status).toBe("SUCCESS");
    });

    it("multi-step caching: a crash between any two steps preserves all prior cached results", async () => {
        stepACalls = 0;
        stepBCalls = 0;
        stepCCalls = 0;

        const wfId = rig.nextWorkflowId("chaos-3-");

        const handle1 = await DBOS.startWorkflow(threeStepMirror, {
            workflowID: wfId,
        })();
        handle1.getResult().catch(() => {});

        const handle2 = await recoverAtCrashPoint<{ a: number; b: number; c: number }>(wfId, () => stepRecorded(wfId, "three-step.b"));
        const result = await handle2.getResult();

        // A and B returned cached values; C ran fresh.
        expect(result).toEqual({ a: 1, b: 1, c: 1 });
        expect(stepACalls).toBe(1);
        expect(stepBCalls).toBe(1);
        expect(stepCCalls).toBe(1);
    });
});

describe("Integration test 10.13 — per-step sync (registration rejection + idempotent)", () => {
    it("a registration rejection still attempts the sync, and is the error the workflow fails with", async () => {
        rejectionRegisterCalls = 0;
        rejectionSyncCalls = 0;
        rejectionMarkFailedCalls = 0;

        const wfId = rig.nextWorkflowId("reg-reject-");
        const handle = await DBOS.startWorkflow(registrationRejectionMirror, {
            workflowID: wfId,
        })();
        handle.getResult().catch(() => {});
        const status = await waitForTerminal(wfId);

        expect(status?.status).toBe("ERROR");
        expect(rejectionRegisterCalls).toBe(1);
        // The load-bearing assertion: registration throwing does not skip the
        // byte-sync. Skipping it is what strands rows registered-but-byteless.
        expect(rejectionSyncCalls).toBe(1);
        expect(rejectionMarkFailedCalls).toBe(1);

        // The sync's own failure does not displace the registration rejection.
        const err = status?.error;
        const syncError = err === undefined ? undefined : errorOf(err);
        if (err !== undefined && syncError === undefined) throw new Error("the sync failure is not an Error");
        expect(syncError?.message).toContain(REGISTRATION_REJECTION);
        expect(syncError?.message).not.toContain(SYNC_UNREACHABLE);

        // The sync attempt is a bare await, so it takes no DBOS function id: the
        // block's checkpoint sequence is what it would be without it.
        const steps = await DBOS.listWorkflowSteps(wfId);
        expect(steps?.map((s) => s.name)).toEqual(["mark-failed-attestation"]);
    });

    it("a replayed sync re-runs and uploads nothing — the unsynced selection skips rows that already carry a file_id", async () => {
        syncCalls = 0;
        syncUploads = [];
        syncLedger = [
            { path: "output/results.csv", role: "step_output", artifactId: "art-1", fileId: null },
            { path: "figures/volcano.png", role: "step_output", artifactId: "art-2", fileId: null },
            // Rejected by the registry: no `artifact_id`, so never selected.
            { path: "logs/run.log", role: "step_output", artifactId: null, fileId: null },
            // A data input, born-synced — outside the step-output selection.
            { path: "data/expr.csv", role: "input", artifactId: "art-0", fileId: "file-0" },
        ];

        const wfId = rig.nextWorkflowId("sync-idem-");

        const handle1 = await DBOS.startWorkflow(idempotentSyncMirror, {
            workflowID: wfId,
        })();
        handle1.getResult().catch(() => {});

        // The sync takes no step, thus its own count marks the crash point.
        const handle2 = await recoverAtCrashPoint<{ uploads: number[]; tail: string }>(wfId, () => syncCalls === 1);
        const result = await handle2.getResult();

        // The bare await DOES re-run on replay — it holds no cached result to
        // return — and the load-bearing assertion is that it moves no bytes:
        // both registered rows were stamped with a `file_id` on the first pass.
        expect(syncCalls).toBe(2);
        expect(result.uploads).toEqual([2, 0]);

        // The rejected row is still byteless and the born-synced input untouched.
        expect(syncLedger.find((r) => r.path === "logs/run.log")?.fileId).toBeNull();
        expect(syncLedger.find((r) => r.path === "data/expr.csv")?.fileId).toBe("file-0");
        expect(result.tail).toBe("tail-ok");

        // No checkpoint is spent on the sync: it never appears in the recorded
        // step list, so the body's function-ID sequence is what it would be
        // without it.
        const steps = await DBOS.listWorkflowSteps(wfId);
        expect(steps?.map((s) => s.name)).not.toContain("post-step.sync");

        const status2 = await DBOS.getWorkflowStatus(wfId);
        expect(status2?.status).toBe("SUCCESS");
    });
});

describe("run and step outcome metrics across a DBOS replay", () => {
    it("a recovered workflow records each outcome once: the terminal step is cached, its closure never re-runs", async () => {
        const capture = captureMetrics();
        try {
            terminalStepCalls = 0;
            const wfId = rig.nextWorkflowId("metric-replay-");
            const handle1 = await DBOS.startWorkflow(terminalMetricMirror, { workflowID: wfId })();
            handle1.getResult().catch(() => {});

            const result = await (await recoverAtCrashPoint<{ terminalCalls: number }>(wfId, () => stepRecorded(wfId, "persist-final-status"))).getResult();

            // The body ran twice; the terminal step's closure ran once, and so did each record in it.
            expect(result.terminalCalls).toBe(1);
            expect(await capture.sums("cortex.run.completed")).toEqual([[{ status: "completed", workflow: "analysis" }, 1]]);
            expect(await capture.histograms("cortex.run.duration")).toEqual([
                [
                    { status: "completed", workflow: "analysis" },
                    { count: 1, sum: 30_000 },
                ],
            ]);
            expect(await capture.sums("cortex.step.completed")).toEqual([[{ status: "completed", agent_id: "mirror-agent" }, 1]]);
            expect(await capture.histograms("cortex.step.duration")).toEqual([
                [
                    { status: "completed", agent_id: "mirror-agent" },
                    { count: 1, sum: 1_500 },
                ],
            ]);
        } finally {
            await capture.dispose();
        }
    });
});
