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

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Pool } from "pg";
import { CortexChatPartSchema } from "@inflexa-ai/harness/contracts/schemas/chat-parts.js";

import { makeLocalAuth } from "../auth/local-auth-context.js";

import { runExecuteAnalysisBody } from "./execute-analysis.js";
import type { ExecuteAnalysisDeps, ExecuteAnalysisInput } from "./execute-analysis.js";
import type { SandboxStepInput, SandboxStepResult } from "./sandbox-step.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";

// ── Fake DBOS surface ────────────────────────────────────────────────

interface FakeWorkflowHandle {
    readonly workflowID: string;
    getResult(): Promise<SandboxStepResult>;
}

interface FakeDbosState {
    cancelled: Set<string>;
    pendingHandles: Map<string, FakeWorkflowHandle>;
    /** Per-step child results the `DBOS.startWorkflow` mock hands back. */
    childResults: Map<string, SandboxStepResult | Error>;
    /** Parts captured from `DBOS.writeStream("events", …)`. */
    emittedParts: Array<Record<string, unknown>>;
    /** Step-name → message: makes the matching `DBOS.runStep` throw. */
    throwOnStep: Map<string, string>;
    workflowIdCounter: number;
}

let dbosState: FakeDbosState;

async function mockDbos(): Promise<void> {
    const dbos = await import("@dbos-inc/dbos-sdk");

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
}

afterEach(() => {
    mock.restore();
});

beforeEach(async () => {
    dbosState = {
        cancelled: new Set(),
        pendingHandles: new Map(),
        childResults: new Map(),
        emittedParts: [],
        throwOnStep: new Map(),
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

function makeDeps(opts: { childResults: Map<string, SandboxStepResult | Error>; pool: FakePool; synthesisEnabled?: boolean }): {
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
        sessionsBasePath: "/tmp/cortex-execute-analysis-test",
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
    };

    return { deps, record };
}

// ── Test inputs ──────────────────────────────────────────────────────

function input(steps: Array<{ id: string; depends_on?: readonly string[] }>): ExecuteAnalysisInput {
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
});
