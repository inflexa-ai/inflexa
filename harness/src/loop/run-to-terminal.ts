/**
 * `runToTerminal` — terminal-salvage wrapper around `runAgent`.
 *
 * Some agents communicate their result EXCLUSIVELY through a terminal tool
 * (`submit_plan`, `submit_profile`, `submit_synthesis`, …):
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
import { createNoopLogger } from "../lib/console-logger.js";
import type { Tool } from "../tools/define-tool.js";
import { addChatUsage, type AgentRunUsage } from "./metrics.js";
import { DEFAULT_STEP_NAME_FORMATTER, runAgent, type AgentFinish, type RunAgentOptions, type RunAgentResult, type StepNameFormatter } from "./run-agent.js";
import type { AgentDefinition, LoopMessage } from "./types.js";

/** Default salvage budget: one submit plus a validation-fix retry or two. */
export const DEFAULT_SALVAGE_ITERATIONS = 3;

/**
 * What a salvage continuation was and how it went — present only when one ran.
 *
 * The two finishes answer different questions and a diagnostician needs both: a
 * first run that ended `max_iterations` spent its whole budget failing to submit,
 * while one that ended `stop` gave up on prose after a single turn. Those call for
 * opposite responses, and the returned `RunAgentResult` carries only the second
 * run's finish, which is the same for either. Its token rollups are the sole
 * exception — those are summed across both attempts, since they measure the run
 * rather than diagnose it.
 */
export interface SalvageRecord {
    /** How the FIRST run ended — the reason a salvage was needed at all. */
    readonly firstFinish: AgentFinish;
    /** How the salvage continuation itself ended. */
    readonly finish: AgentFinish;
}

/** A `runToTerminal` outcome: the driving run's result, plus the salvage account. */
export interface RunToTerminalResult extends RunAgentResult {
    /** Null when the first run reached its terminal tool and no salvage was needed. */
    readonly salvage: SalvageRecord | null;
}

/** Describes how to salvage a run that never reached its terminal tool. */
export interface TerminalSalvage {
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
 * already includes the first run's, and its token rollups are summed across both
 * attempts), otherwise the first run's result.
 */
export async function runToTerminal(
    agent: AgentDefinition,
    initial: readonly LoopMessage[],
    session: AgentSession,
    opts: RunAgentOptions,
    salvage: TerminalSalvage,
): Promise<RunToTerminalResult> {
    const first = await runAgent(agent, initial, session, opts);
    if (opts.resolved?.() || opts.signal.aborted) return { ...first, salvage: null };

    const salvageBudget = salvage.maxIterations ?? DEFAULT_SALVAGE_ITERATIONS;
    // Reported here rather than in `runAgent` because the loop cannot know it is being
    // salvaged: it sees an ordinary run with a small budget and a restricted tool set.
    // Only this wrapper holds the fact that a first attempt ended without its outcome.
    // The first run's finish rides along because it is the whole diagnosis of WHY a
    // salvage was needed, and it is the field the second run's result overwrites.
    (opts.logger ?? createNoopLogger()).named("loop").warn("salvaging a run that never reached its terminal tool", {
        agentId: agent.id,
        callPath: session.provenance.callPath,
        firstFinishReason: first.finish.reason,
        firstCappedOut: first.finish.cappedOut,
        salvageTools: salvage.tools.map((t) => t.id),
        salvageMaxIterations: salvageBudget,
    });

    const salvageAgent: AgentDefinition = {
        ...agent,
        tools: [...salvage.tools],
        maxIterations: salvageBudget,
    };
    // The early cap of the first run must not end the salvage turn, whose whole
    // purpose is to submit after the first run stopped.
    const { stopWhen: _stopWhen, ...continuation } = opts;
    const salvageOpts: RunAgentOptions = {
        ...continuation,
        formatStepName: salvageStepNames(opts.formatStepName ?? DEFAULT_STEP_NAME_FORMATTER),
    };
    const salvaged = await runAgent(salvageAgent, [...first.messages, { role: "user", content: salvage.nudge }], session, salvageOpts);

    // The continuation is the same logical run as the first attempt — its
    // message array already carries the first run's — so its rollups must too,
    // or the caller reads the salvage turn's tokens as the whole cost.
    //
    // `salvage` deliberately keeps each attempt's OWN finish, unsummed: it is the
    // per-attempt diagnosis, not a second accounting of the same tokens. The two
    // views are therefore NOT additive — `finish` is the run's total and already
    // covers everything `salvage.firstFinish` and `salvage.finish` report.
    return {
        ...salvaged,
        finish: {
            ...salvaged.finish,
            ...sumUsage("usage", first.finish, salvaged.finish),
            ...sumUsage("turnUsage", first.finish, salvaged.finish),
        },
        salvage: { firstFinish: first.finish, finish: salvaged.finish },
    };
}

/**
 * Sum one rollup field across the two runs, keeping it absent when neither
 * reported. Both runs are roots or neither is — `runToTerminal` forwards its
 * caller's options unchanged — so summing `turnUsage` never mixes a turn total
 * with a bare own-rollup.
 */
function sumUsage(field: "usage" | "turnUsage", first: AgentFinish, second: AgentFinish): Pick<AgentFinish, "usage" | "turnUsage"> {
    const a = first[field];
    const b = second[field];
    if (a === undefined && b === undefined) return {};
    const total: AgentRunUsage = {};
    addChatUsage(total, a);
    addChatUsage(total, b);
    return { [field]: total };
}
