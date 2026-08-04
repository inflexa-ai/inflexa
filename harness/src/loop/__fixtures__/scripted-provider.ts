import type { ChatResponse, ChatProvider, ChatRequest, ChatStreamEvent, ChatUsage } from "../../providers/types.js";
import { type ResultAsync, okAsync } from "neverthrow";
import type { ProviderError } from "../../providers/errors.js";
import type { AgentSession as Session } from "../../auth/types.js";

export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "reasoning"; text: string; providerOptions?: { anthropic: { signature: string } } };
export type ToolUseBlock = { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock;

function mapFinishReason(finishReason: ChatResponse["finishReason"] | "tool_use" | "end_turn" | "max_tokens" | "refusal"): ChatResponse["finishReason"] {
    switch (finishReason) {
        case "tool_use":
            return "tool-calls";
        case "end_turn":
            return "stop";
        case "max_tokens":
            return "length";
        case "refusal":
            return "content-filter";
        default:
            return finishReason;
    }
}

export function makeMessage(
    content: ContentBlock[],
    finishReason: ChatResponse["finishReason"] | "tool_use" | "end_turn" | "max_tokens" | "refusal",
    usage?: ChatUsage,
): ChatResponse {
    return {
        message: { role: "assistant", content },
        finishReason: mapFinishReason(finishReason),
        usage,
    };
}

export function textBlock(text: string): TextBlock {
    return { type: "text", text };
}

export function thinkingBlock(thinking: string, signature: string): ThinkingBlock {
    return { type: "reasoning", text: thinking, providerOptions: { anthropic: { signature } } };
}

export function toolUseBlock(id: string, name: string, input: unknown): ToolUseBlock {
    return { type: "tool-call", toolCallId: id, toolName: name, input };
}

/**
 * The text a real provider would have streamed for this reply — one delta per
 * text block. Reasoning and tool-call blocks carry no text on the wire, so they
 * arrive only in the terminal `done` response.
 */
function textDeltas(response: ChatResponse): string[] {
    const content = response.message.content;
    if (typeof content === "string") return content === "" ? [] : [content];
    return content.filter((part) => part.type === "text").map((part) => part.text);
}

export interface ScriptedProvider extends ChatProvider {
    readonly calls: ChatRequest[];
    readonly sessions: Session[];
}

export function scriptedProvider(script: ChatResponse[] | ((callIndex: number, request: ChatRequest) => ChatResponse)): ScriptedProvider {
    const calls: ChatRequest[] = [];
    const sessions: Session[] = [];
    const reply =
        typeof script === "function"
            ? script
            : (i: number): ChatResponse => {
                  const r = script[i];
                  if (r === undefined) {
                      throw new Error(`scriptedProvider: no scripted reply for call ${i}`);
                  }
                  return r;
              };

    return {
        capabilities: { toolCalling: true },
        calls,
        sessions,
        chat(request: ChatRequest, session: Session): ResultAsync<ChatResponse, ProviderError> {
            const i = calls.length;
            calls.push(request);
            sessions.push(session);
            return okAsync(reply(i, request));
        },
        chatStream(request: ChatRequest, session: Session): AsyncIterable<ChatStreamEvent> {
            // The call is recorded and the reply resolved eagerly, as in `chat`, so
            // an unscripted call fails at the same point either primitive is driven.
            const i = calls.length;
            calls.push(request);
            sessions.push(session);
            const response = reply(i, request);
            return (async function* () {
                for (const text of textDeltas(response)) yield { type: "text-delta", text };
                yield { type: "done", response };
            })();
        },
    };
}
