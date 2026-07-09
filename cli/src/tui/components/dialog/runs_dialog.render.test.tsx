import { describe, expect, test } from "bun:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { Result } from "neverthrow";
import { testRender } from "@opentui/solid";
import type { CortexRunRow, DbError, StepExecutionRow } from "@inflexa-ai/harness";

import { RunsDialog, type RunsDialogProps } from "./runs_dialog.tsx";
import type { RunsSnapshot } from "../../hooks/sidebar_live.ts";

// The dialog's whole job is to degrade rather than crash: every arm of its `Switch` ladder is a state
// the ledger can genuinely be in (the runtime has not booted, the query failed, the analysis has never
// run), and the step fetch is a second, independent failure axis layered on top. `stepStateOf` is
// covered as a pure function in runs_dialog.test.ts; what is only observable through a render is WHICH
// arm paints — the ladder is the JSX, with no seam between "which state" and "what is drawn".

/**
 * Render the dialog and return its text frame. `settle` extra passes let the `onMount` step fetch
 * resolve — a `ResultAsync.match` lands on a microtask, after the first paint — so a test asserting on
 * loaded steps must ask for at least one.
 */
async function frameOf(runs: RunsSnapshot, loadSteps: RunsDialogProps["loadSteps"], settle = 0): Promise<string> {
    const setup = await testRender(() => <RunsDialog title="runs — demo" runs={runs} loadSteps={loadSteps} onClose={() => {}} />, {
        width: 90,
        height: 36,
    });
    try {
        await setup.renderOnce();
        for (let i = 0; i < settle; i++) {
            await Promise.resolve();
            await setup.renderOnce();
        }
        return setup
            .captureCharFrame()
            .split("\n")
            .map((line) => line.trimEnd())
            .join("\n")
            .trimEnd();
    } finally {
        // A leaked renderer holds native handles open and can segfault a later render (CLAUDE.md).
        setup.renderer.destroy();
    }
}

function run(overrides: Partial<CortexRunRow> = {}): CortexRunRow {
    return {
        runId: "11111111-2222-3333-4444-5555aabbccdd",
        analysisId: "an-1",
        threadId: null,
        workflowName: "executeAnalysis",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:05:00.000Z",
        error: null,
        parts: null,
        mandateJti: null,
        mandateExpiresAt: null,
        planId: null,
        attemptCount: 0,
        ...overrides,
    };
}

function step(stepId: string, status: StepExecutionRow["status"]): StepExecutionRow {
    return {
        runId: "11111111-2222-3333-4444-5555aabbccdd",
        stepId,
        analysisId: "an-1",
        wave: 0,
        agentId: "agent",
        status,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
        attempts: 1,
        lastErrorClass: null,
        finishReason: null,
        hitMaxSteps: false,
        blockedReason: null,
        execId: null,
        childWorkflowId: null,
        sandboxRef: null,
    };
}

/**
 * A seam that must never be called. Every degraded snapshot has no latest run, so issuing a step query
 * against one would be a bug the frame alone could not reveal — this turns it into a test failure.
 */
const neverLoads: RunsDialogProps["loadSteps"] = () => {
    throw new Error("loadSteps must not be called without a loaded, non-empty runs snapshot");
};

/** A query that never settles, so the pre-resolution paint is observable. No timer, nothing to reap. */
function parkedLoad(): ResultAsync<StepExecutionRow[], DbError> {
    return new ResultAsync(new Promise<Result<StepExecutionRow[], DbError>>(() => {}));
}

describe("RunsDialog snapshot ladder", () => {
    test("not_ready → the muted pre-boot line, and no step query is issued", async () => {
        const frame = await frameOf({ kind: "not_ready" }, neverLoads);
        expect(frame).toContain("runtime not ready");
        expect(frame).not.toContain("RECENT RUNS");
    });

    test("unavailable → a DbError degrades to a line, never a crash", async () => {
        const frame = await frameOf({ kind: "unavailable" }, neverLoads);
        expect(frame).toContain("runs unavailable");
        expect(frame).not.toContain("RECENT RUNS");
    });

    test("loaded but empty → `no runs`, and no step query is issued", async () => {
        const frame = await frameOf({ kind: "loaded", runs: [] }, neverLoads);
        expect(frame).toContain("no runs");
        expect(frame).not.toContain("RECENT RUNS");
    });

    test("loaded → the run list, keyed by the id tail and the status", async () => {
        const rows = [run(), run({ runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000", status: "failed" })];
        const frame = await frameOf({ kind: "loaded", runs: rows }, parkedLoad);
        expect(frame).toContain("RECENT RUNS");
        expect(frame).toContain("bbccdd"); // the first run's id tail: dashes stripped, last six
        expect(frame).toContain("ff0000");
        expect(frame).toContain("completed");
        expect(frame).toContain("failed");
    });
});

describe("RunsDialog step fetch (onMount, latest run only)", () => {
    test("fetches exactly once, for the newest run", async () => {
        const asked: string[] = [];
        const seam: RunsDialogProps["loadSteps"] = (runId) => {
            asked.push(runId);
            return okAsync([step("qc", "completed")]);
        };
        await frameOf({ kind: "loaded", runs: [run({ runId: "newest" }), run({ runId: "older" })] }, seam, 2);
        expect(asked).toEqual(["newest"]);
    });

    test("before it resolves, the steps section reads `loading steps`", async () => {
        const frame = await frameOf({ kind: "loaded", runs: [run()] }, parkedLoad);
        expect(frame).toContain("loading steps");
        expect(frame).not.toContain("steps unavailable");
    });

    test("resolved → the RunBlock renders the fetched steps", async () => {
        const frame = await frameOf({ kind: "loaded", runs: [run()] }, () => okAsync([step("qc", "completed"), step("align", "running")]), 3);
        expect(frame).toContain("qc");
        expect(frame).toContain("align");
        expect(frame).not.toContain("loading steps");
        expect(frame).not.toContain("steps unavailable");
    });

    test("a DbError degrades to `steps unavailable` — the run list still renders", async () => {
        const failing: RunsDialogProps["loadSteps"] = () => errAsync({ type: "query_failed", op: "queryStepsByRun", cause: new Error("connection reset") });
        const frame = await frameOf({ kind: "loaded", runs: [run()] }, failing, 3);
        expect(frame).toContain("steps unavailable");
        expect(frame).toContain("RECENT RUNS"); // the failure is scoped to the steps section
        expect(frame).not.toContain("loading steps");
    });
});
