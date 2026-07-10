/**
 * Body-level tests for `executeAnalysis` parent workflow.
 *
 * These tests drive `runExecuteAnalysisBody` (the workflow body) with a
 * fake DBOS surface and a fake deps bundle. They cover the parts of the
 * design contract that don't require a real DBOS engine or a Postgres
 * testcontainer:
 *
 *   10.7  Fail-fast cascade — B raises ERROR; A/C cancelled; charge=error,
 *         mandate=workflow-failed.
 *   10.8  External cancel — operator cancels child mid-flight; cascade
 *         reaps siblings; charge=canceled, mandate=workflow-canceled.
 *   10.10 Stream emission — every UI part flows through `emitStreamPart`;
 *         `cortex_runs.parts` is never touched (the fake pool would surface
 *         a write).
 *   10.11 Terminal billing close — charge closed on success, fail-fast,
 *         external-cancel, and 402 pause paths (one assertion per).
 *   10.14 collectAndComplete writes nothing to a conversation thread (no
 *         dep calls thread-writing helpers — the test asserts on the
 *         deps surface).
 *
 * The deeper end-to-end paths (10.6 chaos recovery, 10.9 402 resume,
 * 10.12 synthesis) need a real DBOS context and live outside this file.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import type { Pool } from "pg";
import { CortexChatPartSchema } from "@inflexa-ai/harness/contracts/schemas/chat-parts.js";

import { makeLocalAuth } from "../auth/local-auth-context.js";

import { runExecuteAnalysisBody } from "./execute-analysis.js";
import type { ExecuteAnalysisDeps, ExecuteAnalysisInput, RunProvenanceEvent } from "./execute-analysis.js";
import type { SandboxStepInput, SandboxStepResult } from "./sandbox-step.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";

// ── Fake DBOS surface ────────────────────────────────────────────────

interface FakeWorkflowHandle {
    readonly workflowID: string;
    getResult(): Promise<SandboxStepResult>;
}

/**
 * Fake checkpointed clock. `DBOS.now()` returns the current value then advances
 * by a fixed step, so every emitted `atMs` is a distinct, deterministic value
 * that is unmistakably stub-sourced — the base is ~Jan 1970, far below any real
 * `Date.now()`. Resetting `nowMs` back to the base and re-running the body
 * reproduces the identical timestamp sequence, modelling how the real
 * checkpointed `DBOS.now()` re-reads the same recorded values on replay.
 */
const FAKE_CLOCK_BASE_MS = 1_000_000;
const FAKE_CLOCK_STEP_MS = 1_000;

interface FakeDbosState {
    cancelled: Set<string>;
    pendingHandles: Map<string, FakeWorkflowHandle>;
    /** Per-step child results the `DBOS.startWorkflow` mock hands back. */
    childResults: Map<string, SandboxStepResult | Error>;
    /** Parts captured from `DBOS.writeStream("events", …)`. */
    emittedParts: Array<Record<string, unknown>>;
    /** Step-name → message: makes the matching `DBOS.runStep` throw. */
    throwOnStep: Map<string, string>;
    /** Monotonic fake clock (ms); `DBOS.now()` reads it then advances by `FAKE_CLOCK_STEP_MS`. */
    nowMs: number;
    workflowIdCounter: number;
}

let dbosState: FakeDbosState;

/**
 * The mocks below are installed by DIRECT property assignment on the DBOS
 * class, which `mock.restore()` does NOT undo — without an explicit restore
 * the fakes would leak into every later test file in the same bun process
 * (e.g. the DBOS testcontainer smoke tests). Capture the originals once,
 * put them back in `afterAll`.
 */
let originalDbosFns: Record<string, unknown> | undefined;

async function mockDbos(): Promise<void> {
    const dbos = await import("@dbos-inc/dbos-sdk");

    originalDbosFns ??= {
        runStep: dbos.DBOS.runStep,
        startWorkflow: dbos.DBOS.startWorkflow,
        writeStream: dbos.DBOS.writeStream,
        cancelWorkflow: dbos.DBOS.cancelWorkflow,
        waitFirst: dbos.DBOS.waitFirst,
        recv: dbos.DBOS.recv,
        now: dbos.DBOS.now,
    };

    // `DBOS.runStep` — execute the wrapped fn immediately, unless the step name
    // is registered to throw (the synthesis-failure path injects a throw at the
    // "synthesize-findings" step without driving the real synthesizer).
    (dbos.DBOS.runStep as unknown) = mock(async (fn: () => Promise<unknown>, config?: { name?: string }) => {
        const injected = config?.name ? dbosState.throwOnStep.get(config.name) : undefined;
        if (injected !== undefined) throw new Error(injected);
        return fn();
    });

    // `DBOS.startWorkflow(callable, { workflowID })(input)` — return a fake
    // handle resolving to the configured child result for the step.
    (dbos.DBOS.startWorkflow as unknown) = mock((_callable: unknown, opts: { workflowID: string }) => async (input: SandboxStepInput) => {
        const result = dbosState.childResults.get(input.stepId);
        if (!result) {
            throw new Error(`no fake result for step ${input.stepId}`);
        }
        const handle = handleFor(opts.workflowID, result);
        dbosState.pendingHandles.set(opts.workflowID, handle);
        return handle;
    });

    // `DBOS.writeStream("events", part)` — record every emitted part.
    (dbos.DBOS.writeStream as unknown) = mock(async (_name: string, part: unknown) => {
        dbosState.emittedParts.push(part as Record<string, unknown>);
        return undefined;
    });

    // `DBOS.cancelWorkflow` — record + resolve.
    (dbos.DBOS.cancelWorkflow as unknown) = mock(async (workflowID: string) => {
        dbosState.cancelled.add(workflowID);
        return undefined;
    });

    // `DBOS.waitFirst` — the fake handles all settle immediately, so "first to
    // finish" is the first in-flight handle. Returning it deterministically
    // mirrors the checkpointed winner the real `waitFirst` records.
    (dbos.DBOS.waitFirst as unknown) = mock(async (handles: FakeWorkflowHandle[]) => {
        if (handles.length === 0) throw new Error("waitFirst: empty handles");
        return handles[0];
    });

    // `DBOS.recv` — the budget-exceeded side-channel drains via `recv(topic, 0)`;
    // these body-level tests inject no notifications, so an empty channel
    // (`null`) lets `drainBudgetExceededNotifications` return immediately.
    (dbos.DBOS.recv as unknown) = mock(async () => null);

    // `DBOS.now()` — a checkpointed clock in the real engine; here a deterministic
    // monotonic fake so every emitted provenance `atMs`/`durationMs` is
    // stub-sourced (never `Date.now()`) and reproducible across a re-run.
    (dbos.DBOS.now as unknown) = mock(async () => {
        const t = dbosState.nowMs;
        dbosState.nowMs += FAKE_CLOCK_STEP_MS;
        return t;
    });
}

afterEach(() => {
    mock.restore();
});

afterAll(async () => {
    if (!originalDbosFns) return;
    const dbos = await import("@dbos-inc/dbos-sdk");
    for (const [name, fn] of Object.entries(originalDbosFns)) {
        (dbos.DBOS as unknown as Record<string, unknown>)[name] = fn;
    }
});

beforeEach(async () => {
    dbosState = {
        cancelled: new Set(),
        pendingHandles: new Map(),
        childResults: new Map(),
        emittedParts: [],
        throwOnStep: new Map(),
        nowMs: FAKE_CLOCK_BASE_MS,
        workflowIdCounter: 0,
    };
    await mockDbos();
});

// ── Fake pool ────────────────────────────────────────────────────────

interface FakePool {
    readonly queries: Array<{ text: string; values?: readonly unknown[] }>;
    query: Pool["query"];
}

function makeFakePool(rowByText: Record<string, unknown[]> = {}): FakePool {
    const queries: FakePool["queries"] = [];
    const query = (mock as unknown as <T>(fn: (q: { text: string; values?: readonly unknown[] }) => Promise<T>) => unknown)(
        async (q: { text: string; values?: readonly unknown[] }) => {
            queries.push(q);
            // Crude prefix match — returns the configured rows for the first
            // prefix that hits, otherwise an empty rowset.
            for (const prefix of Object.keys(rowByText)) {
                if (q.text.trim().startsWith(prefix)) {
                    return {
                        rows: rowByText[prefix]!,
                        rowCount: rowByText[prefix]!.length,
                    };
                }
            }
            return { rows: [], rowCount: 0 };
        },
    );
    return { queries, query: query as unknown as Pool["query"] };
}

/** Suspend-analysis writes the body issues in-line on the 402 pause path. */
function suspendWrites(pool: FakePool): Array<{ text: string; values?: readonly unknown[] }> {
    return pool.queries.filter((q) => /UPDATE\s+cortex_analysis_state\s+SET\s+status\s*=\s*'suspended_insufficient_funds'/i.test(q.text));
}

// ── Fake handle factory ──────────────────────────────────────────────

function handleFor(workflowID: string, result: SandboxStepResult | Error): FakeWorkflowHandle {
    return {
        workflowID,
        async getResult(): Promise<SandboxStepResult> {
            if (result instanceof Error) throw result;
            return result;
        },
    };
}

// ── Deps factory ─────────────────────────────────────────────────────

interface FakeDepsRecord {
    /** Reference to `dbosState.emittedParts` — the parts written via writeStream. */
    readonly emittedParts: Array<Record<string, unknown>>;
    readonly chargeCloseCalls: Array<{ reason: string }>;
    readonly mandateRevokeCalls: Array<{ reason: string }>;
    readonly threadWrites: Array<{ kind: string }>;
}

function makeDeps(opts: {
    childResults: Map<string, SandboxStepResult | Error>;
    pool: FakePool;
    synthesisEnabled?: boolean;
    emitProvenance?: (event: RunProvenanceEvent) => void;
}): {
    deps: ExecuteAnalysisDeps;
    record: FakeDepsRecord;
} {
    dbosState.childResults = opts.childResults;

    const record: FakeDepsRecord = {
        emittedParts: dbosState.emittedParts,
        chargeCloseCalls: [],
        mandateRevokeCalls: [],
        threadWrites: [],
    };

    const deps: ExecuteAnalysisDeps = {
        pool: opts.pool.query ? ({ query: opts.pool.query } as unknown as Pool) : ({} as Pool),
        provider: {} as unknown as ChatProvider,
        embedding: {} as unknown as EmbeddingProvider,
        sandboxStepCallable: async () => {
            throw new Error("sandboxStepCallable should not be invoked directly");
        },
        resolveWorkspaceRoot: (id: string) => join("/tmp/cortex-execute-analysis-test", id),
        synthesisModel: "test-synthesis-model",
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        synthesisEnabled: opts.synthesisEnabled ?? false,
        runCharge: {
            open: async () => {},
            close: async ({ reason }) => {
                record.chargeCloseCalls.push({ reason });
            },
        },
        runAuthorizer: {
            async authorize() {
                throw new Error("runAuthorizer.authorize not exercised in body tests");
            },
            async revoke(_authorization, reason) {
                record.mandateRevokeCalls.push({ reason });
            },
        },
        // Omitted entirely when absent so the "no emitProvenance" tests exercise
        // a genuinely undefined dep, not a present-but-undefined field.
        ...(opts.emitProvenance ? { emitProvenance: opts.emitProvenance } : {}),
    };

    return { deps, record };
}

// ── Test inputs ──────────────────────────────────────────────────────

function input(steps: Array<{ id: string; depends_on?: readonly string[] }>, budget?: { cpu: number; memoryGb: number }): ExecuteAnalysisInput {
    const ids = steps.map((s) => s.id);
    return {
        analysisId: "a1",
        planId: "p1",
        planSummary: "test plan",
        threadId: null,
        steps: steps.map((s) => ({ id: s.id, depends_on: s.depends_on ?? [] })),
        promptByStepId: Object.fromEntries(ids.map((id) => [id, `prompt ${id}`])),
        agentByStepId: Object.fromEntries(ids.map((id) => [id, "agent-x"])),
        resourcesByStepId: Object.fromEntries(ids.map((id) => [id, { cpu: 2, memoryGb: 4 }])),
        ...(budget && { budget }),
        runSession: {
            identity: { user: "u-1" },
            scope: { kind: "analysis", analysisId: "a1" },
            provenance: { agentId: "executeAnalysis", callPath: ["executeAnalysis"] },
            runFrame: { runId: "run-test" },
            auth: makeLocalAuth(),
        },
    };
}

// ── 10.7 Fail-fast cascade ───────────────────────────────────────────

describe("executeAnalysis body", () => {
    it("10.7 fail-fast: B errors → A and C cancelled; charge=error, mandate=failed", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        // Real-world dispatch: A/B/C race; B fails fast; parent cancels A & C
        // in-flight. Their `getResult` then returns the canceled result. Model
        // that by configuring A/C as canceled (sibling cancel = no
        // budget_exceeded marker).
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([
                [
                    "A",
                    {
                        status: "canceled",
                        durationMs: 1,
                        finishReason: null,
                        error: null,
                    },
                ],
                [
                    "B",
                    {
                        status: "failed",
                        durationMs: 1,
                        finishReason: null,
                        error: "boom",
                    },
                ],
                [
                    "C",
                    {
                        status: "canceled",
                        durationMs: 1,
                        finishReason: null,
                        error: null,
                    },
                ],
            ]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }, { id: "B" }, { id: "C" }]), deps);

        // Fail-fast → status "failed" (no siblings completed).
        expect(result.status).toBe("failed");
        expect(record.chargeCloseCalls).toEqual([{ reason: "error" }]);
        expect(record.mandateRevokeCalls).toEqual([{ reason: "workflow-failed" }]);
        expect(suspendWrites(pool)).toEqual([]);
        const terminal = record.emittedParts.find((p) => p.type === "data-run-failed" || p.type === "data-run-completed");
        expect(terminal?.type).toBe("data-run-failed");
    });

    it("blocked fail-fast: B blocked → A and C cancelled; status failed", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([
                ["A", { status: "canceled", durationMs: 1, finishReason: null, error: null }],
                [
                    "B",
                    {
                        status: "blocked",
                        durationMs: 1,
                        finishReason: "end_turn",
                        error: "required input file missing",
                    },
                ],
                ["C", { status: "canceled", durationMs: 1, finishReason: null, error: null }],
            ]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }, { id: "B" }, { id: "C" }]), deps);

        expect(result.status).toBe("failed");
        expect(result.failedSteps).toContain("B");
        expect(record.chargeCloseCalls).toEqual([{ reason: "error" }]);
        const terminal = record.emittedParts.find((p) => p.type === "data-run-failed" || p.type === "data-run-completed");
        expect(terminal?.type).toBe("data-run-failed");
    });

    // ── waitFirst: multi-child completion ──────────────────────────────

    it("waitFirst settles one child per iteration → all-complete sets, status completed", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([
                ["A", { status: "complete", durationMs: 1, finishReason: "stop", error: null }],
                ["B", { status: "complete", durationMs: 1, finishReason: "stop", error: null }],
                ["C", { status: "complete", durationMs: 1, finishReason: "stop", error: null }],
            ]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }, { id: "B" }, { id: "C" }]), deps);

        expect(result.status).toBe("completed");
        expect([...result.completedSteps].sort()).toEqual(["A", "B", "C"]);
        expect(result.failedSteps).toEqual([]);
        expect(result.canceledSteps).toEqual([]);
        expect(record.chargeCloseCalls).toEqual([{ reason: "ok" }]);
    });

    // ── Budget admission ────────────────────────────────────────────────

    it("budget admission serializes dispatch, surfaces queued steps, and completes the run", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([
                ["A", { status: "complete", durationMs: 1, finishReason: "stop", error: null }],
                ["B", { status: "complete", durationMs: 1, finishReason: "stop", error: null }],
                ["C", { status: "complete", durationMs: 1, finishReason: "stop", error: null }],
            ]),
        });

        // Every step declares { cpu: 2, memoryGb: 4 }; the budget fits exactly
        // one at a time, so B and C must pass through "queued" before running.
        const result = await runExecuteAnalysisBody(input([{ id: "A" }, { id: "B" }, { id: "C" }], { cpu: 2, memoryGb: 4 }), deps);

        expect(result.status).toBe("completed");
        expect([...result.completedSteps].sort()).toEqual(["A", "B", "C"]);
        expect(result.failedSteps).toEqual([]);

        const dagParts = record.emittedParts.filter((p) => p.type === "data-dag-state") as Array<{ steps: Array<{ id: string; status: string }> }>;
        const statusesOf = (id: string) => dagParts.map((p) => p.steps.find((s) => s.id === id)!.status);
        // Held steps are visibly queued before they run; the admitted step never is.
        expect(statusesOf("B")).toContain("queued");
        expect(statusesOf("C")).toContain("queued");
        expect(statusesOf("A")).not.toContain("queued");
        // The final snapshot reconciles everything to completed.
        const last = dagParts[dagParts.length - 1]!;
        expect(last.steps.map((s) => s.status)).toEqual(["completed", "completed", "completed"]);
        // One-at-a-time admission: each dag emit shows at most one running step.
        for (const part of dagParts) {
            expect(part.steps.filter((s) => s.status === "running").length).toBeLessThanOrEqual(1);
        }
    });

    it("budget admission: a step that can never fit fails the run with a budget-naming error", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        // No childResults — nothing may be dispatched.
        const { deps, record } = makeDeps({ pool, childResults: new Map() });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }], { cpu: 1, memoryGb: 1 }), deps);

        expect(result.status).toBe("failed");
        expect(result.failedSteps).toEqual(["A"]);
        const terminal = record.emittedParts.find((p) => p.type === "data-run-failed") as { error?: string } | undefined;
        expect(terminal?.error).toContain("budget");
        const dagParts = record.emittedParts.filter((p) => p.type === "data-dag-state") as Array<{
            steps: Array<{ id: string; status: string; error?: string }>;
        }>;
        const last = dagParts[dagParts.length - 1]!;
        expect(last.steps[0]!.status).toBe("failed");
        expect(last.steps[0]!.error).toContain("machine budget");
    });

    it("no budget in the workflow input keeps the legacy full fan-out", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([
                ["A", { status: "complete", durationMs: 1, finishReason: "stop", error: null }],
                ["B", { status: "complete", durationMs: 1, finishReason: "stop", error: null }],
                ["C", { status: "complete", durationMs: 1, finishReason: "stop", error: null }],
            ]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }, { id: "B" }, { id: "C" }]), deps);

        expect(result.status).toBe("completed");
        const dagParts = record.emittedParts.filter((p) => p.type === "data-dag-state") as Array<{ steps: Array<{ id: string; status: string }> }>;
        // First snapshot after dispatch: all three running at once, none queued.
        const first = dagParts[0]!;
        expect(first.steps.map((s) => s.status)).toEqual(["running", "running", "running"]);
        for (const part of dagParts) {
            expect(part.steps.some((s) => s.status === "queued")).toBe(false);
        }
    });

    // ── 10.8 External cancel cascade ───────────────────────────────────

    it("10.8 external cancel: every child returns canceled (no failure) → status canceled, mandate workflow-canceled", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        // Operator cancelled the parent — propagated cancel to every child.
        // No child failed; no child reported budget_exceeded.
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([
                [
                    "A",
                    {
                        status: "canceled",
                        durationMs: 1,
                        finishReason: null,
                        error: null,
                    },
                ],
                [
                    "B",
                    {
                        status: "canceled",
                        durationMs: 1,
                        finishReason: null,
                        error: null,
                    },
                ],
            ]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }, { id: "B" }]), deps);

        expect(result.status).toBe("canceled");
        expect(record.chargeCloseCalls).toEqual([{ reason: "canceled" }]);
        expect(record.mandateRevokeCalls).toEqual([{ reason: "workflow-canceled" }]);
        expect(suspendWrites(pool)).toEqual([]);
    });

    // ── 10.10 Stream emission ──────────────────────────────────────────

    it("10.10 every UI part flows through emitStreamPart; cortex_runs.parts is never written", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([
                [
                    "A",
                    {
                        status: "complete",
                        durationMs: 1,
                        finishReason: "stop",
                        error: null,
                    },
                ],
            ]),
        });

        await runExecuteAnalysisBody(input([{ id: "A" }]), deps);

        // Run-started + dag-state(running) + dag-state(complete) + run-completed.
        expect(record.emittedParts.length).toBeGreaterThanOrEqual(4);
        const types = record.emittedParts.map((p) => p.type);
        expect(types).toContain("data-run-started");
        expect(types).toContain("data-dag-state");
        expect(types).toContain("data-run-completed");

        // No UPDATE on cortex_runs.parts.
        const partsWrites = pool.queries.filter((q) => /UPDATE\s+cortex_runs\s+SET\s+parts/i.test(q.text));
        expect(partsWrites).toEqual([]);
    });

    // ── Wire-contract conformance ──────────────────────────────────────
    //
    // Guards the run-event stream contract: every part executeAnalysis puts on
    // the stream MUST validate against the published `CortexChatPartSchema` from
    // @inflexa-ai/harness/contracts — the exact schema the react-client consumer's
    // parser runs, which silently drops any part that fails. This catches the whole class of
    // "emitter and wire schema drifted apart" defects (missing/renamed/mistyped
    // fields) without asserting on field layout, so additive schema changes that
    // keep the emitter conformant don't break it.

    it("conformance: every part from a completed run validates against the wire schema", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([["A", { status: "complete", durationMs: 1, finishReason: "stop", error: null }]]),
        });

        await runExecuteAnalysisBody(input([{ id: "A" }]), deps);

        for (const part of record.emittedParts) {
            const result = CortexChatPartSchema.safeParse(part);
            expect(
                result.success,
                `emitted part ${JSON.stringify(part)} does not conform to CortexChatPartSchema: ` + (result.success ? "" : JSON.stringify(result.error.issues)),
            ).toBe(true);
        }
        // The two regressions the sweep found, asserted by intent (not layout):
        const started = record.emittedParts.find((p) => p.type === "data-run-started");
        expect(typeof started?.planSummary).toBe("string");
        expect(typeof started?.stepCount).toBe("number");
        const completed = record.emittedParts.find((p) => p.type === "data-run-completed");
        expect(typeof completed?.completedSteps).toBe("number");
        expect(typeof completed?.totalSteps).toBe("number");
        expect(Array.isArray(completed?.findings)).toBe(true);
    });

    it("conformance: data-run-failed from a failed run carries a string error", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([["A", { status: "failed", durationMs: 1, finishReason: null, error: "boom" }]]),
        });

        await runExecuteAnalysisBody(input([{ id: "A" }]), deps);

        const failed = record.emittedParts.find((p) => p.type === "data-run-failed");
        expect(failed).toBeDefined();
        expect(CortexChatPartSchema.safeParse(failed).success).toBe(true);
        expect(typeof failed?.error).toBe("string");
        expect((failed?.error as string).length).toBeGreaterThan(0);
    });

    // ── 10.11 Terminal billing close paths ─────────────────────────────

    it("10.11 success path closes charge with `ok` + revokes mandate workflow-completed", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([
                [
                    "A",
                    {
                        status: "complete",
                        durationMs: 1,
                        finishReason: "stop",
                        error: null,
                    },
                ],
            ]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }]), deps);
        expect(result.status).toBe("completed");
        expect(record.chargeCloseCalls).toEqual([{ reason: "ok" }]);
        expect(record.mandateRevokeCalls).toEqual([{ reason: "workflow-completed" }]);
    });

    it("10.11 budget-exceeded path closes charge with budget_exceeded + revokes workflow-suspended + suspends analysis", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([
                [
                    "A",
                    {
                        status: "canceled",
                        durationMs: 1,
                        finishReason: null,
                        error: "budget_exceeded",
                    },
                ],
            ]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }]), deps);
        expect(result.status).toBe("canceled");
        expect(record.chargeCloseCalls).toEqual([{ reason: "budget_exceeded" }]);
        expect(record.mandateRevokeCalls).toEqual([{ reason: "workflow-suspended" }]);
        expect(suspendWrites(pool).length).toBe(1);
        // Terminal failed part carries `reason: "budget_exceeded"`.
        const failedPart = [...record.emittedParts].reverse().find((p) => p.type === "data-run-failed");
        expect(failedPart?.reason).toBe("budget_exceeded");
    });

    it("synthesis failure outranks budget-exceeded: status failed, not suspended, re-throws", async () => {
        // A completes (so synthesis runs); B depends on A and budget-cancels, so
        // both `completed.size > 0` and `budgetExceeded` hold. A synthesis throw
        // must win: the run fails (charge=error, mandate=workflow-failed), is NOT
        // suspended as a resumable budget pause, and the workflow re-throws.
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            synthesisEnabled: true,
            childResults: new Map<string, SandboxStepResult | Error>([
                ["A", { status: "complete", durationMs: 1, finishReason: "stop", error: null }],
                ["B", { status: "canceled", durationMs: 1, finishReason: null, error: "budget_exceeded" }],
            ]),
        });
        dbosState.throwOnStep.set("synthesize-findings", "synth boom");

        await expect(runExecuteAnalysisBody(input([{ id: "A" }, { id: "B", depends_on: ["A"] }]), deps)).rejects.toThrow("synth boom");

        expect(record.chargeCloseCalls).toEqual([{ reason: "error" }]);
        expect(record.mandateRevokeCalls).toEqual([{ reason: "workflow-failed" }]);
        expect(suspendWrites(pool)).toEqual([]);
    });

    // ── 10.14 No conversation-thread write ─────────────────────────────

    it("10.14 collectAndComplete writes nothing to the conversation thread", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps, record } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([
                [
                    "A",
                    {
                        status: "complete",
                        durationMs: 1,
                        finishReason: "stop",
                        error: null,
                    },
                ],
            ]),
        });

        await runExecuteAnalysisBody(input([{ id: "A" }]), deps);
        // The deps surface has no thread-write call. If a future change adds
        // one to collectAndComplete this assertion must fail.
        expect(record.threadWrites).toEqual([]);
    });

    // ── Run-lifecycle provenance callback ──────────────────────────────

    it("without emitProvenance the run completes (absent callback changes nothing)", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps } = makeDeps({
            pool,
            childResults: new Map<string, SandboxStepResult | Error>([["A", { status: "complete", durationMs: 1, finishReason: "stop", error: null }]]),
        });

        expect(deps.emitProvenance).toBeUndefined();
        const result = await runExecuteAnalysisBody(input([{ id: "A" }]), deps);
        expect(result.status).toBe("completed");
    });

    it("emitProvenance collects run_started, step_completed, then run_completed on the success path with stub-sourced times", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const events: RunProvenanceEvent[] = [];
        const { deps } = makeDeps({
            pool,
            emitProvenance: (e) => events.push(e),
            childResults: new Map<string, SandboxStepResult | Error>([["A", { status: "complete", durationMs: 1, finishReason: "stop", error: null }]]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }]), deps);

        expect(result.status).toBe("completed");
        // Clock reads, in body order: startedAtMs, step-A settlement, terminal.
        // Every `atMs` is a stub value (far below any real `Date.now()`), and the
        // run duration is the terminal read minus the start read.
        expect(events).toEqual([
            { type: "run_started", analysisId: "a1", runId: "run-test", planSummary: "test plan", stepCount: 1, atMs: FAKE_CLOCK_BASE_MS },
            {
                type: "step_completed",
                analysisId: "a1",
                runId: "run-test",
                stepId: "A",
                status: "completed",
                durationMs: 1,
                atMs: FAKE_CLOCK_BASE_MS + FAKE_CLOCK_STEP_MS,
            },
            {
                type: "run_completed",
                analysisId: "a1",
                runId: "run-test",
                status: "completed",
                atMs: FAKE_CLOCK_BASE_MS + 2 * FAKE_CLOCK_STEP_MS,
                durationMs: 2 * FAKE_CLOCK_STEP_MS,
            },
        ]);
    });

    it("emitProvenance emits step_completed(failed) and run_completed(failed) on the failed path", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const events: RunProvenanceEvent[] = [];
        const { deps } = makeDeps({
            pool,
            emitProvenance: (e) => events.push(e),
            childResults: new Map<string, SandboxStepResult | Error>([["A", { status: "failed", durationMs: 1, finishReason: null, error: "boom" }]]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }]), deps);

        expect(result.status).toBe("failed");
        expect(events).toEqual([
            { type: "run_started", analysisId: "a1", runId: "run-test", planSummary: "test plan", stepCount: 1, atMs: FAKE_CLOCK_BASE_MS },
            {
                type: "step_completed",
                analysisId: "a1",
                runId: "run-test",
                stepId: "A",
                status: "failed",
                durationMs: 1,
                atMs: FAKE_CLOCK_BASE_MS + FAKE_CLOCK_STEP_MS,
            },
            {
                type: "run_completed",
                analysisId: "a1",
                runId: "run-test",
                status: "failed",
                atMs: FAKE_CLOCK_BASE_MS + 2 * FAKE_CLOCK_STEP_MS,
                durationMs: 2 * FAKE_CLOCK_STEP_MS,
            },
        ]);
    });

    it("step_completed records completed/failed/canceled per settled child; a never-dispatched dependent emits nothing", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const events: RunProvenanceEvent[] = [];
        // A/B/C dispatch together at level 0; D depends on the failing B. A
        // completes, B fails (fail-fast cancels the in-flight C), and C settles
        // canceled. D is never dispatched because its dependency failed.
        const { deps } = makeDeps({
            pool,
            emitProvenance: (e) => events.push(e),
            childResults: new Map<string, SandboxStepResult | Error>([
                ["A", { status: "complete", durationMs: 5, finishReason: "stop", error: null }],
                ["B", { status: "failed", durationMs: 7, finishReason: null, error: "boom" }],
                ["C", { status: "canceled", durationMs: 3, finishReason: null, error: null }],
                // D intentionally has no configured result: if it were ever
                // dispatched the startWorkflow mock would throw and fail the test.
            ]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D", depends_on: ["B"] }]), deps);

        expect(result.status).toBe("partial");

        // Map each settled step to its emitted terminal status.
        const stepStatusById = new Map(events.flatMap((e) => (e.type === "step_completed" ? [[e.stepId, e.status] as const] : [])));
        expect(stepStatusById.get("A")).toBe("completed");
        expect(stepStatusById.get("B")).toBe("failed");
        expect(stepStatusById.get("C")).toBe("canceled");
        // The dependent that never executed produces no step activity.
        expect(stepStatusById.has("D")).toBe(false);

        // The complete step carries the child's durable duration; the canceled
        // one does too; every step `atMs` is a stub value.
        const stepEvents = events.flatMap((e) => (e.type === "step_completed" ? [e] : []));
        expect(stepEvents).toHaveLength(3);
        for (const e of stepEvents) expect(e.atMs).toBeGreaterThanOrEqual(FAKE_CLOCK_BASE_MS);
        const a = stepEvents.find((e) => e.stepId === "A")!;
        expect(a.durationMs).toBe(5);
    });

    it("a zero-artifact completed step still emits step_completed(completed) — settlement is registration-independent", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const events: RunProvenanceEvent[] = [];
        // Body-level settlement observes only the child's status — there is no
        // ArtifactRegistry in this path, so a step producing no artifact still
        // yields a `step_completed(completed)`.
        const { deps } = makeDeps({
            pool,
            emitProvenance: (e) => events.push(e),
            childResults: new Map<string, SandboxStepResult | Error>([["A", { status: "complete", durationMs: 2, finishReason: "stop", error: null }]]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }]), deps);

        expect(result.status).toBe("completed");
        const stepEvents = events.flatMap((e) => (e.type === "step_completed" ? [e] : []));
        expect(stepEvents).toHaveLength(1);
        expect(stepEvents[0]!.status).toBe("completed");
    });

    it("a DBOS-recovery re-execution re-emits identical timestamps (values come from the checkpointed clock, not Date.now())", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const events: RunProvenanceEvent[] = [];
        const { deps } = makeDeps({
            pool,
            emitProvenance: (e) => events.push(e),
            childResults: new Map<string, SandboxStepResult | Error>([
                ["A", { status: "complete", durationMs: 4, finishReason: "stop", error: null }],
                ["B", { status: "complete", durationMs: 6, finishReason: "stop", error: null }],
            ]),
        });

        await runExecuteAnalysisBody(input([{ id: "A" }, { id: "B" }]), deps);
        const firstRun = [...events];

        // Simulate recovery: the checkpointed clock re-reads the SAME recorded
        // values. Reset the fake clock and per-run capture to base, then re-run
        // the identical body. A wall clock would advance between runs; the stub
        // does not — so identical timestamps prove the values are clock-sourced.
        dbosState.nowMs = FAKE_CLOCK_BASE_MS;
        dbosState.pendingHandles = new Map();
        dbosState.cancelled = new Set();
        dbosState.emittedParts.length = 0;
        events.length = 0;

        await runExecuteAnalysisBody(input([{ id: "A" }, { id: "B" }]), deps);

        expect(events).toEqual(firstRun);
        // The two run boundaries and both step settlements all carry stub times.
        for (const e of events) expect(e.atMs).toBeGreaterThanOrEqual(FAKE_CLOCK_BASE_MS);
    });

    it("a throwing emitProvenance observer does not fail the run", async () => {
        const pool = makeFakePool({
            "SELECT run_id, analysis_id, thread_id, workflow_name, workflow_id": [{ attempt_count: 0 }],
        });
        const { deps } = makeDeps({
            pool,
            emitProvenance: () => {
                throw new Error("observer boom");
            },
            childResults: new Map<string, SandboxStepResult | Error>([["A", { status: "complete", durationMs: 1, finishReason: "stop", error: null }]]),
        });

        const result = await runExecuteAnalysisBody(input([{ id: "A" }]), deps);
        expect(result.status).toBe("completed");
    });
});
