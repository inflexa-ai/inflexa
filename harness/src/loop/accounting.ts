/**
 * The accounting of each model call: the token counters and the usage record.
 *
 * The middleware runs inside the durable step of the call, below the step and
 * above the retry envelope. Thus it sees the stream of the attempt that answered,
 * and a replay of a recorded step does not run it again. The usage record and
 * the counters therefore count each call one time.
 */

import { randomUUID } from "node:crypto";

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { LanguageModelMiddleware } from "ai";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";

import type { AgentSession } from "../auth/types.js";
import type { LlmUsageRecord, UsageRecorder } from "../billing/usage-recorder.js";
import { deliverNotice } from "../lib/hooks.js";
import type { Logger } from "../lib/logger.js";
import { fallbackModelOf } from "../providers/ai-sdk.js";
import type { ChatUsage } from "../providers/types.js";
import { addChatUsage, hasReportedUsage, recordChatCall, type AgentRunUsage } from "./metrics.js";

/** What one completed model call is accounted under. */
export type CallAccounting = {
    readonly session: AgentSession;
    /** The id that the counters and the record name, which is not always the id of the agent. */
    readonly agentId: string;
    /** The id of the tool call that runs the loop, when the loop runs inside a tool call. */
    readonly invocationId?: string;
    readonly usageRecorder: UsageRecorder;
    /** The sink that the notice helper logs the reason of a recorder `err` to. */
    readonly logger: Logger;
};

/**
 * Delimiter joining the call path into one key segment.
 *
 * Deliberately not the `:` that separates the key's segments, so a call path
 * can never be read as one: agent ids are kebab-case identifiers, and none of
 * the other segments can contain `>`.
 */
const CALL_PATH_DELIMITER = ">";

/**
 * Idempotency key for one call's usage record, and for the kept text of one cut
 * tool result: `{runId}[:{stepId}]:{callPath}[:{invocationId}]:{callKey}`. A
 * workflow with no `RunFrame`, a chat turn, puts its own workflow id in place of
 * the run and the step.
 *
 * Each component is a fact the same call carries again on every rerun:
 *
 * - `stepId` — `executeAnalysis` runs one child workflow per step under a
 *   single shared `runId`.
 * - `callPath` — several loops run under one frame: a step agent and its
 *   follow-up requests, and the run synthesis and the sub-agents of its tools.
 * - `invocationId` — the same sub-agent dispatched twice in one round has an
 *   identical call path, so only the dispatching tool-call id tells the two
 *   child loops apart. Each data profile runs under the same constant frame,
 *   thus the workflow id of its attempt takes this place.
 * - `callKey` — the id of the model response, or the id of the tool call. A
 *   recorded step gives the same id on a replay.
 *
 * Outside a workflow there is no replay to be safe against, so a fresh id is
 * enough and is what keeps two calls in one turn distinct.
 */
export function recordKeyFor(session: AgentSession, invocationId: string | undefined, callKey: string): string {
    const frame = session.runFrame;
    const workflowId = DBOS.workflowID;
    if (frame === undefined && workflowId === undefined) return randomUUID();
    const scope = frame === undefined ? [workflowId] : [frame.runId, ...(frame.stepId === undefined ? [] : [frame.stepId])];
    return [...scope, session.provenance.callPath.join(CALL_PATH_DELIMITER), ...(invocationId === undefined ? [] : [invocationId]), callKey].join(":");
}

/** The usage of one call in the names of the harness. An unreported figure stays absent. */
export function chatUsageOf(usage: LanguageModelV4Usage): ChatUsage {
    return {
        inputTokens: usage.inputTokens.total,
        outputTokens: usage.outputTokens.total,
        cacheCreationInputTokens: usage.inputTokens.cacheWrite,
        cacheReadInputTokens: usage.inputTokens.cacheRead,
        reasoningTokens: usage.outputTokens.reasoning,
    };
}

/** Count one completed call, and send its usage record. */
function account(
    call: CallAccounting,
    facts: {
        readonly usage: ChatUsage;
        readonly responseId?: string;
        readonly provider: string;
        readonly requestedModelId: string;
        readonly servedModelId?: string;
    },
): void {
    recordChatCall({ agentId: call.agentId, usage: facts.usage, servedModelId: facts.servedModelId, provider: facts.provider });
    if (!hasReportedUsage(facts.usage)) return;
    const { session } = call;
    const record: { -readonly [K in keyof LlmUsageRecord]: LlmUsageRecord[K] } = {
        recordKey: recordKeyFor(session, call.invocationId, facts.responseId ?? randomUUID()),
        agentId: call.agentId,
        callPath: session.provenance.callPath,
        scope: session.scope,
        usage: facts.usage,
        requestedModelId: facts.requestedModelId,
    };
    if (session.runFrame?.runId !== undefined) record.runId = session.runFrame.runId;
    if (session.runFrame?.stepId !== undefined) record.stepId = session.runFrame.stepId;
    if (facts.servedModelId !== undefined) record.servedModelId = facts.servedModelId;
    void deliverNotice(call.logger, "UsageRecorder.record", call.usageRecorder.record(record));
}

/**
 * Folds the usage of each model call into the rollups of the run. It wraps the
 * durable step of the call, thus a replayed call folds the usage of its
 * checkpoint, and a reply whose tool calls an abort cut folds too.
 */
export function rollupMiddleware(rollups: readonly AgentRunUsage[]): LanguageModelMiddleware {
    return {
        specificationVersion: "v4",
        wrapStream: async ({ doStream }) => {
            const { stream, ...rest } = await doStream();
            const observed = stream.pipeThrough(
                new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
                    transform(part, controller) {
                        if (part.type === "finish") for (const rollup of rollups) addChatUsage(rollup, chatUsageOf(part.usage));
                        controller.enqueue(part);
                    },
                }),
            );
            return { ...rest, stream: observed };
        },
    };
}

/**
 * The accounting of each model call of a run, as a model middleware. It reads
 * the response id and the model id of the response metadata, and it accounts
 * the call at the `finish` part.
 */
export function accountingMiddleware(call: CallAccounting): LanguageModelMiddleware {
    return {
        specificationVersion: "v4",
        wrapStream: async ({ doStream, model }) => {
            const { stream, ...rest } = await doStream();
            let responseId: string | undefined;
            let servedModelId: string | undefined;
            const observed = stream.pipeThrough(
                new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
                    transform(part, controller) {
                        if (part.type === "response-metadata") {
                            responseId = part.id ?? responseId;
                            servedModelId = part.modelId ?? servedModelId;
                        } else if (part.type === "finish") {
                            // A fallback hop names the model that answered, and the metadata keeps the requested one.
                            const servedBy = fallbackModelOf(part.providerMetadata);
                            account(call, {
                                usage: chatUsageOf(part.usage),
                                responseId,
                                provider: model.provider,
                                requestedModelId: model.modelId,
                                servedModelId: servedBy === undefined || servedBy === "" ? servedModelId : servedBy,
                            });
                        }
                        controller.enqueue(part);
                    },
                }),
            );
            return { ...rest, stream: observed };
        },
    };
}
