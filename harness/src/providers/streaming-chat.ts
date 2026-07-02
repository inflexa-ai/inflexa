/**
 * `createStreamingChat` — a streaming `AgentChat`.
 *
 * The agent loop depends on `AgentChat`: one request in, one collapsed
 * `ChatResponse` out. A `ChatProvider` satisfies that directly — its `chat`
 * collapses the stream silently. This builds a SECOND `AgentChat` from the
 * same provider's `chatStream` primitive: its `chat` drives the stream,
 * forwards every text delta to `onText`, and returns the same collapsed
 * `ChatResponse`. `runAgent` calls `chat` and never knows it streamed.
 *
 * The chat route is the one caller — it is the single place token streaming
 * is wired. Sub-agent loops (planner, literature-reviewer) and workflow
 * loops run on the plain `ChatProvider`, so they never stream.
 */

import { ResultAsync, err, ok, type Result } from "neverthrow";

import { scopeWorkloadId } from "../auth/types.js";
import { type ProviderError, toProviderError } from "./errors.js";
import type { AgentChat, ChatProvider, ChatResponse } from "./types.js";

/**
 * Wrap a `ChatProvider` as a streaming `AgentChat`. `onText` is called once
 * per text delta, in arrival order, as a side effect of `chat`. `chat` is
 * Result-returning: it consumes the throwing `chatStream` and maps a thrown
 * SDK failure to `err(ProviderError)`; a client abort is re-thrown verbatim
 * (control-flow, never the error channel).
 */
export function createStreamingChat(provider: ChatProvider, onText: (text: string) => void): AgentChat {
    return {
        capabilities: provider.capabilities,
        chat(req, session, signal): ResultAsync<ChatResponse, ProviderError> {
            const workload = `${session.scope.kind}:${scopeWorkloadId(session.scope)}`;
            const run = async (): Promise<Result<ChatResponse, ProviderError>> => {
                let final: ChatResponse | undefined;
                try {
                    for await (const event of provider.chatStream(req, session, signal)) {
                        if (event.type === "text-delta") {
                            onText(event.text);
                        } else {
                            final = event.response;
                        }
                    }
                } catch (e) {
                    if (e instanceof DOMException && e.name === "AbortError") throw e;
                    if (e instanceof Error && e.name === "AbortError") throw e;
                    return err(toProviderError(e, workload));
                }
                if (final === undefined) {
                    return err({
                        type: "provider",
                        retryable: false,
                        message: "createStreamingChat: chatStream ended without a final message",
                    });
                }
                return ok(final);
            };
            return new ResultAsync(run());
        },
    };
}
