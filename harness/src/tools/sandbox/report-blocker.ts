/**
 * `report_blocker` — an agent's honest exit when it cannot fulfil the loop it
 * is driving (see the harness-sandbox-agents spec). There is no `submit`/`done`
 * tool on a sandbox step: a step's deliverable is its persisted files, so a
 * clean end-of-turn after writing them is the implicit success. Calling
 * `report_blocker` is the alternative to improvising an inline result the
 * harness would launder into a green run.
 *
 * This module is the canonical home of the tool. Four loops offer it — the
 * sandbox step agent, the planner (`tools/research/generate-plan.ts`), the
 * run synthesizer (`execution/run-synthesis.ts`) and the analogical reasoner
 * (`tools/research/generate-analogy-report.ts`) — and all four share one id,
 * one input schema and one result via `createReportBlockerToolFor`. What
 * differs per loop is only what a blocker *means* there, so each call site
 * injects its own `blockedWhen` prose. The result of the call carries the
 * reason, and the driving body selects the blocker from the recorded calls of
 * the run (`blockerOf`). Thus a replay selects the same blocker.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import type { LoopStep } from "../../loop/run-loop.js";
import { terminalTextSchema } from "../terminal-text.js";
import { defineTool, type Tool } from "../define-tool.js";

export const REPORT_BLOCKER_TOOL_ID = "report_blocker";

export type BlockerOutcome = {
    readonly kind: "blocker";
    readonly reason: string;
};

/** The one input every `report_blocker` takes, wherever it is offered. */
const ReportBlockerInputSchema = z.object({
    reason: terminalTextSchema(
        "What blocks the work, stated as a fact: the missing or unreadable input, or the capability that is not available, and what you tried.",
    ),
});

/** The result of a call: the blocker that the call recorded. */
const BlockerResultSchema = z.object({ kind: z.literal("blocker"), reason: z.string(), message: z.string() });

type BlockerResult = z.infer<typeof BlockerResultSchema>;

export type ReportBlockerDeps = {
    /**
     * What a blocker means in THIS loop: which loop the call ends and the
     * conditions that warrant it. Composed into the shared terminal contract,
     * so a description can never promise a loop this instance does not end.
     */
    readonly blockedWhen: string;
};

/**
 * Build the `report_blocker` tool for one loop. The id, the input schema and
 * the terminal contract ("pass a reason, then stop") are fixed here; the call
 * site supplies only the per-loop meaning.
 */
export function createReportBlockerToolFor(deps: ReportBlockerDeps): Tool<z.infer<typeof ReportBlockerInputSchema>, BlockerResult> {
    return defineTool({
        id: REPORT_BLOCKER_TOOL_ID,
        description: `Terminal. ${deps.blockedWhen} Pass a clear reason. Stop immediately after calling — take no further actions.`,
        inputSchema: ReportBlockerInputSchema,
        view: "none",
        describeCall: "none",
        execute: (input) =>
            Promise.resolve(
                ok({ kind: "blocker" as const, reason: input.reason, message: "Blocker recorded. You are done — stop now and do not take further actions." }),
            ),
    });
}

/** The blocker that a run recorded: the reason of the first `report_blocker` call, in call order, whose result is ok. */
export function blockerOf(steps: readonly LoopStep[]): BlockerOutcome | null {
    for (const step of steps) {
        for (const call of step.calls) {
            if (call.toolName !== REPORT_BLOCKER_TOOL_ID || call.output?.outcome !== "ok") continue;
            const result = BlockerResultSchema.safeParse(call.output.value);
            if (result.success) return { kind: "blocker", reason: result.data.reason };
        }
    }
    return null;
}

/**
 * The sandbox step agent's `report_blocker`. A blocker here ends the step with
 * no deliverables and a blocked reason.
 */
export function createReportBlockerTool(): Tool {
    return createReportBlockerToolFor({
        blockedWhen:
            "Ends this analysis step with no deliverables. Call it when you cannot " +
            "fulfil the step — required inputs are missing or unreadable, the " +
            "requested analysis is infeasible with the available data/packages, or " +
            "you cannot produce the persisted deliverables (scripts, output files, " +
            "figures). Do NOT improvise an inline result and narrate it: if you " +
            "cannot persist real output files, report a blocker.",
    });
}
