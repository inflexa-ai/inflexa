/**
 * Test-only `ChatProvider` that replays scripted `Message` replies, plus
 * content-block builders. Not a `*.test.ts` file, so the runner ignores
 * it; imported by the loop unit tests.
 */

import type { ContentBlock, Message, TextBlock, ThinkingBlock, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { type ResultAsync, okAsync } from "neverthrow";

import type { AgentSession as Session } from "../../auth/types.js";
import type { ProviderError } from "../../providers/errors.js";
import type { ChatProvider, ChatRequest, ChatStreamEvent } from "../../providers/types.js";

const ZERO_USAGE: Message["usage"] = {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 0,
    output_tokens: 0,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
};

let msgCounter = 0;

/** Build an assistant `Message` carrying the given content blocks. */
export function makeMessage(content: ContentBlock[], stopReason: Message["stop_reason"]): Message {
    return {
        id: `msg_${++msgCounter}`,
        type: "message",
        role: "assistant",
        model: "claude-test",
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        stop_details: null,
        container: null,
        usage: ZERO_USAGE,
    };
}

export function textBlock(text: string): TextBlock {
    return { type: "text", text, citations: null };
}

export function thinkingBlock(thinking: string, signature: string): ThinkingBlock {
    return { type: "thinking", thinking, signature };
}

export function toolUseBlock(id: string, name: string, input: unknown): ToolUseBlock {
    return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

/** A `ChatProvider` whose `chat` replays a script and records its inputs. */
export interface ScriptedProvider extends ChatProvider {
    /** Every `chat` request, in call order. */
    readonly calls: ChatRequest[];
    /** The `Session` passed to each `chat` call, in call order. */
    readonly sessions: Session[];
}

/**
 * Build a scripted provider. `script` is either a fixed list of replies
 * (indexed by call number) or a function of `(callIndex, request)` —
 * the latter drives non-terminating scenarios (always `tool_use`).
 */
export function scriptedProvider(script: Message[] | ((callIndex: number, request: ChatRequest) => Message)): ScriptedProvider {
    const calls: ChatRequest[] = [];
    const sessions: Session[] = [];
    const reply =
        typeof script === "function"
            ? script
            : (i: number): Message => {
                  const r = script[i];
                  if (r === undefined) {
                      throw new Error(`scriptedProvider: no scripted reply for call ${i}`);
                  }
                  return r;
              };

    return {
        calls,
        sessions,
        chat(request: ChatRequest, session: Session): ResultAsync<Message, ProviderError> {
            const i = calls.length;
            calls.push(request);
            sessions.push(session);
            return okAsync(reply(i, request));
        },
        // eslint-disable-next-line require-yield
        async *chatStream(): AsyncIterable<ChatStreamEvent> {
            throw new Error("scriptedProvider: chatStream is not used by runAgent");
        },
    };
}
