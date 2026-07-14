import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { testRender } from "@opentui/solid";
import type { CortexRunRow, DbError, StepExecutionRow } from "@inflexa-ai/harness";

import { RunDetailDialog, type RunDetailDialogProps } from "./run_detail_dialog.tsx";
import { GLYPHS } from "../../../lib/design_system.ts";

// The dialog's render-only contract: which metadata lines paint, that the FULL step list renders
// (no window — every state incl. the seeded pending→queued hollow glyph), and that a failed step
// fetch degrades to the muted line instead of crashing. `runDetailLines` and `stepStateOf` are
// covered as pure functions elsewhere; only the painted ladder needs a frame.

/**
 * Render the dialog and return its text frame. `settle` extra passes let the `onMount` step fetch
 * resolve — a `ResultAsync.match` lands on a microtask, after the first paint — so a test asserting
 * on loaded steps must ask for at least one.
 */
async function frameOf(run: CortexRunRow, loadSteps: RunDetailDialogProps["loadSteps"], settle = 0): Promise<string> {
    const setup = await testRender(() => <RunDetailDialog run={run} loadSteps={loadSteps} onClose={() => {}} />, {
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
        sandboxRef: null,
        execId: null,
        childWorkflowId: null,
    };
}

describe("RunDetailDialog", () => {
    test("paints metadata and the full step list with per-state glyphs", async () => {
        const steps = [step("s1_load", "completed"), step("s2_assoc", "failed"), step("s3_report", "pending")];
        const frame = await frameOf(run(), () => okAsync<StepExecutionRow[], DbError>(steps), 2);

        expect(frame).toContain("status: completed");
        expect(frame).toContain("started ");
        expect(frame).toContain("duration ");
        expect(frame).toContain("1/3");
        expect(frame).toContain("s1_load");
        expect(frame).toContain("s2_assoc");
        expect(frame).toContain("s3_report");
        // The seeded `pending` row paints the queued hollow glyph; the failure paints the cross.
        expect(frame).toContain(GLYPHS.circleHollow);
        expect(frame).toContain(GLYPHS.cross);
    });

    test("a failed run paints its error lines", async () => {
        const frame = await frameOf(run({ status: "failed", error: "step s2 blew up" }), () => okAsync<StepExecutionRow[], DbError>([]), 2);
        expect(frame).toContain("status: failed");
        expect(frame).toContain("step s2 blew up");
    });

    test("a failed step fetch degrades to the muted line, never a crash", async () => {
        const frame = await frameOf(run(), () => errAsync<StepExecutionRow[], DbError>({ type: "query_failed", op: "test", cause: new Error("boom") }), 2);
        expect(frame).toContain("steps unavailable");
    });
});
