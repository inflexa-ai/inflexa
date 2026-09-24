/**
 * Claude Opus 5.5 and Claude Fable 5.1 bind each signed thinking block to the
 * exact prefix of its request, and the prompt cache keys on that same prefix.
 * A continuation must extend the conversation, never replay it under a new
 * system prompt or tool set.
 */

import type { AgentSession } from "../auth/types.js";
import { forSubAgent } from "../auth/types.js";
import { traceAgentRun } from "./genai-spans.js";
import { DEFAULT_STEP_NAME_FORMATTER, isTurnRoot, openLoop, type AgentFinish, type RunAgentOptions, type StepNameFormatter } from "./run-agent.js";
import type { ToolMask } from "./tool-mask.js";
import type { AgentDefinition, LoopMessage } from "./types.js";

export interface ContinuationRequest {
    /** Appended as a synthetic user message. */
    readonly text: string;
    /** The requests still declare every tool of the agent, even when masked. */
    readonly mask: ToolMask;
    /** The continuation runs no wrap-up at its cap. */
    readonly maxRequests: number;
    /** Prefixes each step name (`<namespace>:<name>`) so its cache key cannot match the conversation's own. */
    readonly stepNamespace: string;
    /**
     * When set, metrics and token counts are attributed to this id instead of
     * `agent.id`, through `forSubAgent`. Omitted, both stay the agent's own.
     */
    readonly accountingAgentId?: string;
}

export interface ContinuationResult {
    /** The new messages only, starting with the synthetic request. */
    readonly messages: LoopMessage[];
    readonly finish: AgentFinish;
}

export function namespacedStepNames(base: StepNameFormatter, namespace: string): StepNameFormatter {
    return {
        llm: (i) => `${namespace}:${base.llm(i)}`,
        tool: (name, id) => `${namespace}:${base.tool(name, id)}`,
    };
}

/**
 * `agent` and `opts` must match the conversation's own, since each request
 * extends its cached prefix. `conversation` itself is never changed.
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
