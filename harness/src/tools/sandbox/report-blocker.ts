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
 * one input schema and one terminal contract via `createReportBlockerToolFor`.
 * What differs per loop is only what a blocker *means* there, so each call site
 * injects its own `blockedWhen` prose and its own capture closure. The tool
 * records the reason and tells the agent to stop; the driving body reads the
 * outcome after the loop and decides the terminal status. The sandbox step body
 * runs in durable steps, so it reads the blocker back from the transcript
 * (`recordedBlocker`) on replay, not only from its cell.
 */

import type { ModelMessage } from "ai";
import { ok } from "neverthrow";
import { z } from "zod";

import { repairToolInput } from "../../lib/zod-issues.js";
import { toolOutcomeForOutputType } from "../../loop/tool-outcome.js";
import { defineTool, type Tool } from "../define-tool.js";

export const REPORT_BLOCKER_TOOL_ID = "report_blocker";

export interface BlockerOutcome {
    readonly kind: "blocker";
    readonly reason: string;
}

/** Per-run mutable cell the sandbox-step body reads after the loop. */
export interface BlockerHolder {
    outcome: BlockerOutcome | null;
}

export function createBlockerHolder(): BlockerHolder {
    return { outcome: null };
}

/** The one input every `report_blocker` takes, wherever it is offered. */
const ReportBlockerInputSchema = z.object({ reason: z.string().min(1) });

export interface ReportBlockerDeps {
    /**
     * The calling loop's blocker-capture side effect — writes the outcome into
     * whatever cell that body reads after its loop. Invoked on every call; the
     * closure owns the first-call-wins guard, because only the call site knows
     * what else may already have terminated its loop.
     */
    readonly record: (outcome: BlockerOutcome) => void;
    /**
     * What a blocker means in THIS loop: which loop the call ends and the
     * conditions that warrant it. Composed into the shared terminal contract,
     * so a description can never promise a loop this instance does not end.
     */
    readonly blockedWhen: string;
}

/**
 * Build the `report_blocker` tool for one loop. The id, the input schema and
 * the terminal contract ("pass a reason, then stop") are fixed here; the call
 * site supplies only the per-loop meaning and the capture closure.
 */
export function createReportBlockerToolFor(deps: ReportBlockerDeps): Tool {
    return defineTool({
        id: REPORT_BLOCKER_TOOL_ID,
        description: `Terminal. ${deps.blockedWhen} Pass a clear reason. Stop immediately after calling — take no further actions.`,
        inputSchema: ReportBlockerInputSchema,
        describeCall: "none",
        execute: async (input) => {
            deps.record({ kind: "blocker", reason: input.reason });
            return ok({
                recorded: true as const,
                message: "Blocker recorded. You are done — stop now and do not take further actions.",
            });
        },
    });
}

/**
 * The blocker that a run recorded, read from its transcript: the reason of the
 * first `report_blocker` call, in call order, whose result is ok.
 *
 * A replay returns each tool step's cached result without re-running
 * `execute`, so the in-memory cell is empty on replay; the transcript is not.
 */
export function recordedBlocker(messages: readonly ModelMessage[]): BlockerOutcome | null {
    const recorded = new Set<string>();
    for (const message of messages) {
        if (message.role !== "tool") continue;
        for (const part of message.content) {
            if (part.type === "tool-result" && part.toolName === REPORT_BLOCKER_TOOL_ID && toolOutcomeForOutputType(part.output.type) === "ok") {
                recorded.add(part.toolCallId);
            }
        }
    }
    for (const message of messages) {
        if (message.role !== "assistant" || typeof message.content === "string") continue;
        for (const part of message.content) {
            if (part.type !== "tool-call" || part.toolName !== REPORT_BLOCKER_TOOL_ID || !recorded.has(part.toolCallId)) continue;
            const reason = blockerReason(part.input);
            if (reason !== undefined) return { kind: "blocker", reason };
        }
    }
    return null;
}

/** The reason of a `report_blocker` input, validated as the dispatch validates it. */
function blockerReason(input: unknown): string | undefined {
    const parsed = ReportBlockerInputSchema.safeParse(input);
    if (parsed.success) return parsed.data.reason;
    const repaired = repairToolInput(input, parsed.error);
    if (repaired === undefined) return undefined;
    const reparsed = ReportBlockerInputSchema.safeParse(repaired);
    return reparsed.success ? reparsed.data.reason : undefined;
}

/**
 * The sandbox step agent's `report_blocker`, bound to the step body's holder.
 * A blocker here ends the step with no deliverables and a blocked reason.
 */
export function createReportBlockerTool(holder: BlockerHolder): Tool {
    return createReportBlockerToolFor({
        record: (outcome) => {
            if (holder.outcome === null) holder.outcome = outcome;
        },
        blockedWhen:
            "Ends this analysis step with no deliverables. Call it when you cannot " +
            "fulfil the step — required inputs are missing or unreadable, the " +
            "requested analysis is infeasible with the available data/packages, or " +
            "you cannot produce the persisted deliverables (scripts, output files, " +
            "figures). Do NOT improvise an inline result and narrate it: if you " +
            "cannot persist real output files, report a blocker.",
    });
}
