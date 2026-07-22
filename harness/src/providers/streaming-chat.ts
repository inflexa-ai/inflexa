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
 *
 * This wrapper is also where a client abort stops being control flow: it sees
 * every delta, so it alone can assemble the partial. On the stream's abort it
 * resolves an `"aborted"` `ChatResponse` carrying that partial rather than
 * re-throwing, letting the interactive turn keep what the model produced. The
 * plain provider keeps throwing on abort, so durable loops are untouched.
 */

import { ResultAsync, err, ok, type Result } from "neverthrow";

import { scopeWorkloadId } from "../auth/types.js";
import { type ProviderError, toProviderError } from "./errors.js";
import type { AgentChat, ChatProvider, ChatResponse } from "./types.js";

/**
 * Wrap a `ChatProvider` as a streaming `AgentChat`. `onText` is called once
 * per text delta, in arrival order, as a side effect of `chat`. `chat` is
 * Result-returning: it consumes the throwing `chatStream` and maps a thrown
 * SDK failure to `err(ProviderError)`. A client abort is not an error here — it
 * resolves `ok` with finish reason `"aborted"` and an assistant message holding
 * exactly the deltas already forwarded (empty when the abort beat the first
 * delta), so the interactive turn keeps the partial reply instead of losing it
 * to a throw.
 */
export function createStreamingChat(provider: ChatProvider, onText: (text: string) => void): AgentChat {
    return {
        capabilities: provider.capabilities,
        chat(req, session, signal): ResultAsync<ChatResponse, ProviderError> {
            const workload = `${session.scope.kind}:${scopeWorkloadId(session.scope)}`;
            const run = async (): Promise<Result<ChatResponse, ProviderError>> => {
                let final: ChatResponse | undefined;
                let partial = "";
                try {
                    for await (const event of provider.chatStream(req, session, signal)) {
                        if (event.type === "text-delta") {
                            partial += event.text;
                            onText(event.text);
                        } else {
                            final = event.response;
                        }
                    }
                } catch (e) {
                    // A client abort resolves with what streamed so far, never through
                    // the error channel: the interactive turn persists the partial.
                    const aborted = (e instanceof DOMException || e instanceof Error) && e.name === "AbortError";
                    if (aborted) {
                        // A complete response already in hand beats a partial reconstruction: if the
                        // stream had yielded its terminal `done` before the abort threw, that whole
                        // response is authoritative, so return it rather than the assembled deltas.
                        if (final !== undefined) return ok(final);
                        return ok({ message: { role: "assistant", content: partial }, finishReason: "aborted" });
                    }
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
