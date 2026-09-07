/**
 * The recording provider of the headless evaluation: a `ChatProvider` that
 * forwards every call to the inner provider of one model role and appends one
 * line per call to `calls.jsonl` in the attempt directory.
 *
 * The passthrough loops of the harness (the planner, the conversation agent,
 * the run synthesizer, the literature reviewer) persist no transcript, and the
 * durable loops persist theirs only inside the DBOS step cache. The evaluation
 * contract asks for every model role's calls and replies, thus the wrapper
 * records at the one place every call passes: the provider seam. The line
 * carries the role, the provenance of the session (the agent id, the call
 * path, the run frame), the size of the request, the full assistant message,
 * the finish reason, the usage, the two model ids, the elapsed time, and the
 * error of a failed call.
 */

import { isProviderError, type AgentSession, type ChatProvider, type ChatRequest, type ChatResponse, type ChatStreamEvent } from "@inflexa-ai/harness";

import type { JsonlSink } from "./usage-sink.js";

/** The model roles the evaluation binds, one recording provider each. */
export type EvalRole = "planner" | "sandbox" | "utility";

/** One line of `calls.jsonl`. */
export interface CallLine {
    readonly role: string;
    readonly agentId: string;
    readonly callPath: readonly string[];
    readonly runFrame: AgentSession["runFrame"] | null;
    readonly systemChars: number;
    readonly messageCount: number;
    readonly toolNames: readonly string[];
    readonly assistantMessage: ChatResponse["message"] | null;
    readonly finishReason: ChatResponse["finishReason"] | null;
    readonly usage: ChatResponse["usage"] | null;
    readonly requestedModel: string | null;
    readonly servedModel: string | null;
    readonly elapsedMs: number;
    readonly error: { readonly type: string; readonly message: string; readonly retryable?: boolean } | null;
}

function describeError(error: unknown): NonNullable<CallLine["error"]> {
    if (isProviderError(error)) return { type: error.type, message: error.message, retryable: error.retryable };
    if (error instanceof Error) return { type: error.name || "Error", message: error.message };
    return { type: "unknown", message: String(error) };
}

function requestFacts(role: string, req: ChatRequest, session: AgentSession): Pick<CallLine, "role" | "agentId" | "callPath" | "runFrame" | "systemChars" | "messageCount" | "toolNames"> {
    return {
        role,
        agentId: session.provenance.agentId,
        callPath: session.provenance.callPath,
        runFrame: session.runFrame ?? null,
        systemChars: req.system.length,
        messageCount: req.messages.length,
        toolNames: Object.keys(req.tools),
    };
}

function replyFacts(response: ChatResponse): Pick<CallLine, "assistantMessage" | "finishReason" | "usage" | "requestedModel" | "servedModel"> {
    return {
        assistantMessage: response.message,
        finishReason: response.finishReason,
        usage: response.usage ?? null,
        requestedModel: response.requestedModelId ?? null,
        servedModel: response.servedModelId ?? null,
    };
}

const NO_REPLY: Pick<CallLine, "assistantMessage" | "finishReason" | "usage" | "requestedModel" | "servedModel"> = {
    assistantMessage: null,
    finishReason: null,
    usage: null,
    requestedModel: null,
    servedModel: null,
};

/**
 * Wrap `inner` so each `chat` and `chatStream` call lands in `sink` as one
 * `CallLine`, then answers exactly as the inner provider did. The wrapper keeps
 * the capabilities and the request timeout of the inner provider, thus the
 * loop scales its deadlines as it would without the wrapper.
 */
export function recordingProvider(inner: ChatProvider, role: string, sink: JsonlSink): ChatProvider {
    return {
        capabilities: inner.capabilities,
        ...(inner.requestTimeoutMs !== undefined ? { requestTimeoutMs: inner.requestTimeoutMs } : {}),
        chat(req: ChatRequest, session: AgentSession, signal?: AbortSignal) {
            const facts = requestFacts(role, req, session);
            const started = performance.now();
            return inner
                .chat(req, session, signal)
                .map((response) => {
                    const line: CallLine = { ...facts, ...replyFacts(response), elapsedMs: Math.round(performance.now() - started), error: null };
                    sink.append(line);
                    return response;
                })
                .mapErr((error) => {
                    const line: CallLine = { ...facts, ...NO_REPLY, elapsedMs: Math.round(performance.now() - started), error: describeError(error) };
                    sink.append(line);
                    return error;
                });
        },
        async *chatStream(req: ChatRequest, session: AgentSession, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
            const facts = requestFacts(role, req, session);
            const started = performance.now();
            let done = false;
            try {
                for await (const event of inner.chatStream(req, session, signal)) {
                    if (event.type === "done") {
                        done = true;
                        const line: CallLine = { ...facts, ...replyFacts(event.response), elapsedMs: Math.round(performance.now() - started), error: null };
                        sink.append(line);
                    }
                    yield event;
                }
            } catch (caught) {
                if (!done) {
                    const line: CallLine = { ...facts, ...NO_REPLY, elapsedMs: Math.round(performance.now() - started), error: describeError(caught) };
                    sink.append(line);
                }
                throw caught;
            }
        },
    };
}
