/**
 * `report_blocker` — a step agent's honest exit when it cannot fulfil its
 * step (see the harness-sandbox-agents spec). There is no `submit`/`done` tool: a step's deliverable is
 * its persisted files, so a clean end-of-turn after writing them is the
 * implicit success. Calling `report_blocker` is the alternative to
 * improvising an inline result the harness would launder into a green run.
 *
 * Mirrors the synthesizer's blocker (`execution/run-synthesis.ts`): the
 * workflow body owns a per-run `BlockerHolder` and reads `holder.outcome`
 * after `runAgent`. The tool only records the reason and tells the agent to
 * stop — the body decides the terminal status.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool } from "../define-tool.js";

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

export function createReportBlockerTool(holder: BlockerHolder): Tool {
    return defineTool({
        id: "report_blocker",
        description:
            "Terminal. Call this when you cannot fulfil the step — required inputs " +
            "are missing or unreadable, the requested analysis is infeasible with " +
            "the available data/packages, or you cannot produce the persisted " +
            "deliverables (scripts, output files, figures). Pass a clear reason. Do " +
            "NOT improvise an inline result and narrate it; if you cannot persist " +
            "real output files, report a blocker. Stop after calling.",
        inputSchema: z.object({ reason: z.string().min(1) }),
        execute: async (input) => {
            if (holder.outcome === null) {
                holder.outcome = { kind: "blocker", reason: input.reason };
            }
            return ok({
                recorded: true as const,
                message: "Blocker recorded. You are done — stop now and do not take further actions.",
            });
        },
    });
}
