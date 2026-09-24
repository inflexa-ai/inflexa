/**
 * `continueAgent` — continue an existing conversation of an agent with one
 * harness request.
 *
 * Claude Opus 5.5 and Claude Fable 5.1 bind each signed thinking block to the
 * exact prefix of its request: the system prompt, the tool set, and the earlier
 * messages. The prompt cache keys on the same prefix. Thus a second pass over a
 * conversation — a salvage, a summary, a description of its files — must extend
 * that conversation, not replay it under a new system prompt or a new tool set.
 *
 * A continuation appends the request as a synthetic user message, which opens no
 * turn in a stored thread, and runs the loop with the system prompt, the declared
 * tools, and the tool choice of the conversation. A mask gives the tools that can
 * run, and a small cap ends the continuation with no wrap-up of its own. The
 * caller gives the provider and the options of the conversation, thus the effort
 * and the cache policy stay the same.
 */

import type { AgentSession } from "../auth/types.js";
import { forSubAgent } from "../auth/types.js";
import { traceAgentRun } from "./genai-spans.js";
import { DEFAULT_STEP_NAME_FORMATTER, isTurnRoot, openLoop, type AgentFinish, type RunAgentOptions, type StepNameFormatter } from "./run-agent.js";
import type { ToolMask } from "./tool-mask.js";
import type { AgentDefinition, LoopMessage } from "./types.js";

/** The harness request of one continuation. */
export interface ContinuationRequest {
    /** The text of the request, appended as a synthetic user message. */
    readonly text: string;
    /** The tools that can run for each request of the continuation. The requests still declare every tool of the agent. */
    readonly mask: ToolMask;
    /** The cap of model requests. The continuation runs no wrap-up at its cap. */
    readonly maxRequests: number;
    /**
     * The prefix of each step name: `<namespace>:<name>`. Thus a durable cache key
     * of the continuation cannot match a key of its conversation.
     */
    readonly stepNamespace: string;
    /**
     * The agent that the calls of the continuation are accounted under, for
     * example `step-summary-writer`. The continuation then runs under
     * `forSubAgent(session, id)`, and its token counters and run metrics carry
     * the id in place of `agent.id`. Absent keeps both.
     */
    readonly accountingAgentId?: string;
}

/** What a continuation added to its conversation, and how it ended. */
export interface ContinuationResult {
    /** The new messages only: the synthetic request, then each message after it. */
    readonly messages: LoopMessage[];
    readonly finish: AgentFinish;
}

/** The step names of a continuation: each name of `base` under `namespace`. */
export function namespacedStepNames(base: StepNameFormatter, namespace: string): StepNameFormatter {
    return {
        llm: (i) => `${namespace}:${base.llm(i)}`,
        tool: (name, id) => `${namespace}:${base.tool(name, id)}`,
    };
}

/**
 * Continue `conversation` with `request`. `agent` and `opts` must be those of the
 * conversation, thus each request extends the prefix that the conversation
 * cached. No message of `conversation` changes.
 */
export function continueAgent(
    agent: AgentDefinition,
    conversation: readonly LoopMessage[],
    request: ContinuationRequest,
    session: AgentSession,
    opts: RunAgentOptions,
): Promise<ContinuationResult> {
    const accountingAgentId = request.accountingAgentId;
    const runSession = accountingAgentId === undefined ? session : forSubAgent(session, accountingAgentId);
    const metricAgentId = accountingAgentId ?? agent.id;
    return traceAgentRun(metricAgentId, runSession, isTurnRoot(opts), async () => {
        const loop = openLoop(agent, conversation, runSession, opts, metricAgentId);
        const outcome = await loop.runSegment({
            mask: request.mask,
            maxRequests: request.maxRequests,
            stepNames: namespacedStepNames(opts.formatStepName ?? DEFAULT_STEP_NAME_FORMATTER, request.stepNamespace),
            firstIndex: 0,
            requestText: request.text,
        });
        const result = outcome === "capped" ? await loop.endCapped() : outcome;
        return { messages: result.messages.slice(conversation.length), finish: result.finish };
    });
}
