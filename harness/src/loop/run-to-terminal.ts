/**
 * `runToTerminal` — terminal-salvage wrapper around `runAgent`.
 *
 * Some agents communicate their result EXCLUSIVELY through a terminal tool
 * (`submit_plan`, `submit_report`, `submit_profile`, `submit_synthesis`, …):
 * the loop's text reply is discarded and the outcome is read from a closure
 * cell the terminal tool writes. Plain `runAgent` ends a capped run on a
 * tool-LESS wrap-up turn, so an agent that burns its whole iteration budget —
 * or simply stops on prose — without ever submitting leaves that cell empty
 * and forces the caller to hard-fail.
 *
 * `runToTerminal` runs the agent, then — if the outcome cell is still empty
 * and the run was not aborted — grants ONE focused salvage continuation whose
 * only tools are the terminal tools, opened by a corrective nudge. Restricting
 * the surface to the terminal tools removes every distraction; a small
 * `maxIterations` lets the model fix a single validation rejection and
 * resubmit.
 *
 * Salvage steps are namespaced (`salvage:…`) so a durable (DBOS) caller does
 * not collide the continuation's `llm-*` / `tool-*` cache keys with the first
 * run's — replaying them would silently return the first run's cached results.
 */

import type { AgentSession } from "../auth/types.js";
import type { Tool } from "../tools/define-tool.js";
import { DEFAULT_STEP_NAME_FORMATTER, runAgent, type RunAgentOptions, type RunAgentResult, type StepNameFormatter } from "./run-agent.js";
import type { AgentDefinition, LoopMessage } from "./types.js";

/** Default salvage budget: one submit plus a validation-fix retry or two. */
export const DEFAULT_SALVAGE_ITERATIONS = 3;

/** Describes how to salvage a run that never reached its terminal tool. */
export interface TerminalSalvage {
    /** True once the agent recorded its terminal outcome (reads the closure cell). */
    readonly resolved: () => boolean;
    /** Terminal tools offered on the salvage turn (submit / blocker / …). Must be
     *  the same instances the first run used — they close over the outcome cell. */
    readonly tools: readonly Tool[];
    /** Corrective user message that opens the salvage continuation. */
    readonly nudge: string;
    /** Salvage iteration budget. Defaults to {@link DEFAULT_SALVAGE_ITERATIONS}. */
    readonly maxIterations?: number;
}

function salvageStepNames(base: StepNameFormatter): StepNameFormatter {
    return {
        llm: (i) => `salvage:${base.llm(i)}`,
        tool: (name, id) => `salvage:${base.tool(name, id)}`,
    };
}

/**
 * Drive `agent` to its terminal tool, salvaging once if it doesn't get there.
 * Returns the salvage run's result when a salvage occurred (its message array
 * already includes the first run's), otherwise the first run's result.
 */
export async function runToTerminal(
    agent: AgentDefinition,
    initial: readonly LoopMessage[],
    session: AgentSession,
    opts: RunAgentOptions,
    salvage: TerminalSalvage,
): Promise<RunAgentResult> {
    const first = await runAgent(agent, initial, session, opts);
    if (salvage.resolved() || opts.signal.aborted) return first;

    const salvageAgent: AgentDefinition = {
        ...agent,
        tools: [...salvage.tools],
        maxIterations: salvage.maxIterations ?? DEFAULT_SALVAGE_ITERATIONS,
    };
    const salvageOpts: RunAgentOptions = {
        ...opts,
        formatStepName: salvageStepNames(opts.formatStepName ?? DEFAULT_STEP_NAME_FORMATTER),
    };
    return runAgent(salvageAgent, [...first.messages, { role: "user", content: salvage.nudge }], session, salvageOpts);
}
