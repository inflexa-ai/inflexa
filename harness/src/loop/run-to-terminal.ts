/**
 * `runToTerminal` — terminal-salvage wrapper around `runAgent`.
 *
 * Some agents communicate their result EXCLUSIVELY through a terminal tool
 * (`submit_plan`, `submit_profile`, `submit_synthesis`, …):
 * the loop's text reply is discarded and the outcome is read from a closure
 * cell the terminal tool writes. The wrap-up of a capped run lets no tool run,
 * so an agent that burns its whole iteration budget — or simply stops on
 * prose — without ever submitting leaves that cell empty and forces the caller
 * to hard-fail.
 *
 * `runToTerminal` runs the agent, then — if the outcome cell is still empty
 * and the run was not aborted — runs ONE salvage continuation of the same
 * conversation (`continueAgent`), opened by a corrective nudge. The salvage
 * still declares every tool of the agent, masked to the terminal tools only,
 * because the tool set is part of the prefix a signed thinking block and the
 * prompt cache bind to.
 *
 * Salvage steps are namespaced (`salvage:…`) so a durable (DBOS) caller does
 * not collide the continuation's `llm-*` / `tool-*` cache keys with the first
 * run's — replaying them would silently return the first run's cached results.
 */

import type { AgentSession } from "../auth/types.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Tool } from "../tools/define-tool.js";
import { continueAgent } from "./continue-agent.js";
import { addChatUsage, type AgentRunUsage } from "./metrics.js";
import { runAgent, type AgentFinish, type RunAgentOptions, type RunAgentResult } from "./run-agent.js";
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
    /** Their ids become the mask of the salvage continuation, so each must already be a declared tool of the agent. */
    readonly tools: readonly Tool[];
    /** Opens the salvage continuation as a synthetic user message. */
    readonly nudge: string;
    /** The cap of salvage requests. Defaults to {@link DEFAULT_SALVAGE_ITERATIONS}. */
    readonly maxIterations?: number;
}

/**
 * Drive `agent` to its terminal tool, salvaging once if it does not get there.
 * A salvage result carries both runs' messages and summed rollups, with the
 * salvage's own finish. Throws first if a terminal tool is not declared on the
 * agent.
 */
export async function runToTerminal(
    agent: AgentDefinition,
    initial: readonly LoopMessage[],
    session: AgentSession,
    opts: RunAgentOptions,
    salvage: TerminalSalvage,
): Promise<RunToTerminalResult> {
    const undeclared = salvage.tools.find((terminal) => !agent.tools.some((tool) => tool.id === terminal.id));
    if (undeclared !== undefined) {
        throw new Error(`The terminal tool "${undeclared.id}" is not a declared tool of the agent "${agent.id}", thus the salvage mask cannot let it run.`);
    }

    const first = await runAgent(agent, initial, session, opts);
    if (opts.resolved?.() || opts.signal.aborted) return { ...first, salvage: null };

    const salvageBudget = salvage.maxIterations ?? DEFAULT_SALVAGE_ITERATIONS;
    // Reported here rather than in `runAgent` because the loop cannot know it is being
    // salvaged: it sees a continuation with a small cap and a mask.
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

    // The early cap of the first run must not end the salvage turn, whose whole
    // purpose is to submit after the first run stopped.
    const { stopWhen: _stopWhen, ...continuation } = opts;
    const salvaged = await continueAgent(
        agent,
        first.messages,
        { text: salvage.nudge, mask: { allow: salvage.tools.map((t) => t.id) }, maxRequests: salvageBudget, stepNamespace: "salvage" },
        session,
        continuation,
    );

    // The continuation is the same logical run as the first attempt, so its
    // rollups must cover both, or the caller reads the salvage's tokens as the whole cost.
    //
    // `salvage` deliberately keeps each attempt's OWN finish, unsummed: it is the
    // per-attempt diagnosis, not a second accounting of the same tokens. The two
    // views are therefore NOT additive — `finish` is the run's total and already
    // covers everything `salvage.firstFinish` and `salvage.finish` report.
    return {
        messages: [...first.messages, ...salvaged.messages],
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
