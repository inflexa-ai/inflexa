import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { testRender } from "@opentui/solid";

import type { RunDetail, RunStepSummary, RunSummary } from "../../../api/runs.ts";
import type { UsageTotals } from "../../../api/usage.ts";
import type { ClientError } from "../../../client/api.ts";
import { RunDetailDialog, type RunDetailDialogProps } from "./run_detail_dialog.tsx";
import { GLYPHS } from "../../../lib/design_system.ts";

// The dialog's render-only contract: which metadata lines paint, that the FULL step list renders
// (no window — every state incl. the seeded pending→queued hollow glyph), and that a failed detail
// fetch degrades to the muted line instead of crashing. `runDetailLines` and `stepStateOf` are
// covered as pure functions elsewhere; only the painted ladder needs a frame.

/**
 * Render the dialog and return its text frame. `settle` extra passes let the `onMount` detail fetch
 * resolve — a `ResultAsync.match` lands on a microtask, after the first paint — so a test asserting
 * on loaded steps must ask for at least one.
 */
async function frameOf(run: RunSummary, loadDetail: RunDetailDialogProps["loadDetail"], settle = 0): Promise<string> {
    const setup = await testRender(() => <RunDetailDialog run={run} loadDetail={loadDetail} onClose={() => {}} />, {
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

function run(overrides: Partial<RunSummary> = {}): RunSummary {
    return {
        runId: "11111111-2222-3333-4444-5555aabbccdd",
        threadId: null,
        workflowName: "executeAnalysis",
        workflowId: "11111111-2222-3333-4444-5555aabbccdd",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:05:00.000Z",
        error: null,
        ...overrides,
    };
}

function step(stepId: string, status: RunStepSummary["status"], usage?: UsageTotals): RunStepSummary {
    return {
        stepId,
        agentId: "agent",
        status,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
        attempts: 1,
        blockedReason: null,
        ...(usage === undefined ? {} : { usage }),
    };
}

/** A detail fetch that answers with `steps` and the run's step-less calls. */
function detailOf(steps: RunStepSummary[], unattributedUsage: UsageTotals | null = null): RunDetailDialogProps["loadDetail"] {
    return () => okAsync<RunDetail, ClientError>({ ...run(), steps, unattributedUsage });
}

describe("RunDetailDialog", () => {
    test("paints metadata and the full step list with per-state glyphs", async () => {
        const steps = [step("s1_load", "completed"), step("s2_assoc", "failed"), step("s3_report", "pending")];
        const frame = await frameOf(run(), detailOf(steps), 2);

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
        const frame = await frameOf(run({ status: "failed", error: "step s2 blew up" }), detailOf([]), 2);
        expect(frame).toContain("status: failed");
        expect(frame).toContain("step s2 blew up");
    });

    test("the run's figures paint beside its other properties, and are absent when the row has none", async () => {
        const withUsage = await frameOf(run({ usage: { calls: 47, inputTokens: 809_200, outputTokens: 40_400 } }), detailOf([]), 2);
        const without = await frameOf(run(), detailOf([]), 2);

        // The LONG form: a `label value` property line among the timings, in a full-width dialog being
        // read deliberately — not the rail's compact decoration on a 37-cell row.
        expect(withUsage).toContain("usage 809.2k in · 40.4k out");
        expect(withUsage).toContain("47 calls");
        // A run the ledger knows nothing about carries no line at all — not a zeroed one.
        expect(without).not.toContain("usage ");
    });

    test("each step carries its own compact figure, and a step the ledger has nothing for carries none", async () => {
        const steps = [
            step("s1_load", "completed", { calls: 8, inputTokens: 121_400, outputTokens: 6_200 }),
            // Calls recorded whose provider reported no quantity — no figure, never a zeroed one.
            step("s2_assoc", "completed", { calls: 3 }),
            // `s3_report` has no usage at all: the step made no calls.
            step("s3_report", "completed"),
        ];
        const frame = await frameOf(run(), detailOf(steps), 2);

        // The COMPACT form on a step row — the row's subject is the step, and the run's own `usage`
        // property line above it is the surface that spends words.
        expect(frame).toContain(`${GLYPHS.arrowUp}121.4k ${GLYPHS.arrowDown}6.2k`);
        // Every step still lists; a step with no figure loses its second line, not its row.
        for (const id of ["s1_load", "s2_assoc", "s3_report"]) expect(frame).toContain(id);
        // Exactly one figure painted — the reported-nothing step and the absent one each add none, and
        // a zeroed fallback for either would show up here as a second arrow.
        expect(frame.split(GLYPHS.arrowUp).length - 1).toBe(1);
    });

    test("a run's step-less spend is shown, not silently dropped between the headline and the steps", async () => {
        const steps = [step("s1_load", "completed", { calls: 8, inputTokens: 121_400, outputTokens: 6_200 })];
        const frame = await frameOf(
            run({ usage: { calls: 12, inputTokens: 300_000, outputTokens: 20_000 } }),
            // A run-level call with no step row to hang on, as the detail route sends it.
            detailOf(steps, { calls: 4, inputTokens: 178_600, outputTokens: 13_800 }),
            2,
        );

        expect(frame).toContain("outside any step 178.6k in");
        expect(frame).toContain("4 calls");
        // The step it DOES have still renders its own figure — naming the remainder must not cost the
        // attributed part its row.
        expect(frame).toContain(`${GLYPHS.arrowUp}121.4k`);
    });

    test("a failed detail fetch degrades to the muted line, never a crash", async () => {
        const failed: ClientError = { type: "http", status: 500, body: { error: "internal_error", message: "boom" } };
        const frame = await frameOf(run(), () => errAsync<RunDetail, ClientError>(failed), 2);
        expect(frame).toContain("steps unavailable");
    });
});
