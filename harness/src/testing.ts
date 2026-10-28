/**
 * The test kit of the harness: a scripted model for a test of an agent, a chat
 * turn, or a tool that runs a sub-agent. It is a `ChatProvider` over the mock
 * model of the AI SDK. Each request takes the next entry of the script, and the
 * kit records each request that the model got. `inProcessChatTurns` gives the
 * chat turns of a runtime with no DBOS engine, over the turn in process. An
 * embedder imports it from `@inflexa-ai/harness/testing`.
 */

import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart, SharedV4ProviderMetadata } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

import { createAiSdkProvider } from "./providers/ai-sdk.js";
import type { ResolveRequestHeaders } from "./providers/request-headers.js";

export { inProcessChatTurns } from "./app/in-process-turn.js";
import type { ChatProvider, ChatUsage, ProviderCapabilities } from "./providers/types.js";

export type ScriptedPart =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "reasoning"; readonly text: string; readonly signature?: string }
    | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly input: unknown };

export type ScriptedReply = {
    readonly content: readonly ScriptedPart[];
    readonly finishReason: "stop" | "tool-calls" | "length" | "content-filter" | "other" | "error";
    readonly rawFinishReason?: string;
    readonly usage?: ChatUsage;
    readonly providerMetadata?: SharedV4ProviderMetadata;
    readonly responseId?: string;
    readonly modelId?: string;
};

/** A request that fails: the model throws the value when it opens its stream. */
export type ScriptedFailure = { readonly fail: unknown };

/** A reply that streams its first parts, and then fails with an error part. */
export type ScriptedBreak = { readonly breakAfter: readonly ScriptedPart[]; readonly error: unknown };

export type ScriptEntry = ScriptedReply | ScriptedFailure | ScriptedBreak;

export type ScriptStep = ScriptEntry | ((call: LanguageModelV4CallOptions) => ScriptEntry | Promise<ScriptEntry>);

export type ScriptedModel = {
    readonly provider: ChatProvider;
    /** Each request that the model got, in order. */
    readonly calls: LanguageModelV4CallOptions[];
};

export function text(value: string): ScriptedPart {
    return { type: "text", text: value };
}

export function reasoning(value: string, signature?: string): ScriptedPart {
    return signature === undefined ? { type: "reasoning", text: value } : { type: "reasoning", text: value, signature };
}

export function toolCall(toolCallId: string, toolName: string, input: unknown): ScriptedPart {
    return { type: "tool-call", toolCallId, toolName, input };
}

export function reply(content: readonly ScriptedPart[], finishReason: ScriptedReply["finishReason"] = "stop", usage?: ChatUsage): ScriptedReply {
    return usage === undefined ? { content, finishReason } : { content, finishReason, usage };
}

/** The reply of a round of tool calls. */
export function callTools(...calls: readonly ScriptedPart[]): ScriptedReply {
    return { content: calls, finishReason: "tool-calls" };
}

function v4Usage(usage: ChatUsage | undefined): Extract<LanguageModelV4StreamPart, { type: "finish" }>["usage"] {
    return {
        inputTokens: { total: usage?.inputTokens, noCache: undefined, cacheRead: usage?.cacheReadInputTokens, cacheWrite: usage?.cacheCreationInputTokens },
        outputTokens: { total: usage?.outputTokens, text: undefined, reasoning: usage?.reasoningTokens },
    };
}

function contentParts(content: readonly ScriptedPart[]): LanguageModelV4StreamPart[] {
    const parts: LanguageModelV4StreamPart[] = [];
    for (const [index, part] of content.entries()) {
        const id = `p${index}`;
        switch (part.type) {
            case "text":
                parts.push({ type: "text-start", id }, { type: "text-delta", id, delta: part.text }, { type: "text-end", id });
                break;
            case "reasoning": {
                const providerMetadata = part.signature === undefined ? undefined : { anthropic: { signature: part.signature } };
                parts.push({ type: "reasoning-start", id }, { type: "reasoning-delta", id, delta: part.text }, { type: "reasoning-end", id, providerMetadata });
                break;
            }
            case "tool-call":
                parts.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: JSON.stringify(part.input) });
                break;
        }
    }
    return parts;
}

function streamOf(entry: ScriptedReply, index: number): LanguageModelV4StreamPart[] {
    return [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: entry.responseId ?? `response-${index}`, modelId: entry.modelId ?? "scripted-model", timestamp: new Date(0) },
        ...contentParts(entry.content),
        {
            type: "finish",
            finishReason: { unified: entry.finishReason, raw: entry.rawFinishReason ?? entry.finishReason },
            usage: v4Usage(entry.usage),
            providerMetadata: entry.providerMetadata,
        },
    ];
}

/** Build a provider over a scripted model. A request past the end of the script fails the test that made it. */
export function scriptedModel(
    script: readonly ScriptStep[],
    options: {
        readonly capabilities?: Partial<ProviderCapabilities>;
        readonly maxRetries?: number;
        readonly resolveRequestHeaders?: ResolveRequestHeaders;
    } = {},
): ScriptedModel {
    const calls: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
        provider: "scripted",
        modelId: "scripted-model",
        doStream: async (call) => {
            const index = calls.length;
            calls.push(call);
            const step = script[index];
            if (step === undefined) throw new Error(`the script has no reply ${index}`);
            const entry = typeof step === "function" ? await step(call) : step;
            if ("fail" in entry) throw entry.fail;
            if ("breakAfter" in entry) {
                return {
                    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
                        { type: "stream-start", warnings: [] },
                        ...contentParts(entry.breakAfter),
                        { type: "error", error: entry.error },
                    ]),
                };
            }
            return { stream: convertArrayToReadableStream(streamOf(entry, index)) };
        },
    });
    const provider = createAiSdkProvider({
        model,
        capabilities: options.capabilities,
        maxRetries: options.maxRetries ?? 0,
        resolveRequestHeaders: options.resolveRequestHeaders,
    });
    return { provider, calls };
}
