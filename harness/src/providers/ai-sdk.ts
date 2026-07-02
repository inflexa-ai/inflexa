import { generateText, streamText, type FinishReason, type LanguageModel, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ResultAsync, err, ok, type Result } from "neverthrow";

import { scopeWorkloadId, type AgentSession } from "../auth/types.js";
import type { ResolveBilling } from "../billing/resolver.js";
import { type ProviderError, toProviderError } from "./errors.js";
import type { ChatProvider, ChatRequest, ChatResponse, ChatStreamEvent, FetchLike, ProviderCapabilities } from "./types.js";

const DEFAULT_MAX_RETRIES = 2;

export interface AiSdkProviderDeps {
    readonly model: LanguageModel;
    readonly resolveBilling: ResolveBilling;
    readonly capabilities?: Partial<ProviderCapabilities>;
}

export type AiSdkProviderConfig =
    | {
          readonly kind: "anthropic";
          readonly baseURL?: string;
          readonly apiKey: string;
          readonly model: string;
          readonly fetch?: FetchLike;
          readonly capabilities?: Partial<ProviderCapabilities>;
      }
    | {
          readonly kind: "openai-compatible";
          readonly name: string;
          readonly baseURL: string;
          readonly apiKey?: string;
          readonly model: string;
          readonly fetch?: FetchLike;
          readonly capabilities?: Partial<ProviderCapabilities>;
      };

export interface ConfiguredAiSdkProviderDeps {
    readonly config: AiSdkProviderConfig;
    readonly resolveBilling: ResolveBilling;
}

function workloadOf(session: AgentSession): string {
    return `${session.scope.kind}:${scopeWorkloadId(session.scope)}`;
}

function isAbortError(value: unknown): boolean {
    if (value instanceof DOMException && value.name === "AbortError") return true;
    if (value instanceof Error && value.name === "AbortError") return true;
    return false;
}

function responseFromMessages(
    messages: readonly ModelMessage[],
    fallbackText: string,
    finishReason: FinishReason,
    rawFinishReason?: string,
): ChatResponse {
    const message = [...messages].reverse().find((m): m is Extract<ModelMessage, { role: "assistant" }> => m.role === "assistant");
    if (message === undefined) {
        return {
            message: { role: "assistant", content: fallbackText },
            finishReason,
            rawFinishReason,
        };
    }
    return { message, finishReason, rawFinishReason };
}

function responseFromGenerate(result: Awaited<ReturnType<typeof generateText>>): ChatResponse {
    return responseFromMessages(result.responseMessages, result.text, result.finishReason, result.rawFinishReason);
}

/**
 * Drop empty text parts — and messages left with no content at all — before
 * the wire call. The Anthropic Messages API rejects any request containing an
 * empty text block, and the SDK's own response assembly legitimately produces
 * them: a turn that goes straight to tool calls yields an assistant message
 * carrying a ""-text part, which the agent loop then echoes back as history
 * on its next request. Filtering once at the outbound boundary covers every
 * source at once — loop echo, stored thread history, legacy backfill, and the
 * empty-string fallback in `responseFromMessages`.
 */
function sanitizeMessages(messages: readonly ModelMessage[]): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (const m of messages) {
        if (typeof m.content === "string") {
            if (m.content !== "") out.push(m);
            continue;
        }
        const parts = m.content.filter((p) => p.type !== "text" || p.text !== "");
        // The filtered parts are a subset of this message's own content, so the
        // message remains valid for its role — the cast only re-associates the
        // narrowed array with the union member TS can no longer correlate.
        if (parts.length > 0) out.push({ ...m, content: parts } as ModelMessage);
    }
    return out;
}

export function createAiSdkProvider(deps: AiSdkProviderDeps): ChatProvider {
    const capabilities: ProviderCapabilities = { toolCalling: deps.capabilities?.toolCalling ?? true };

    function chat(req: ChatRequest, session: AgentSession, signal?: AbortSignal): ResultAsync<ChatResponse, ProviderError> {
        const run = async (): Promise<Result<ChatResponse, ProviderError>> => {
            try {
                const headers = await deps.resolveBilling(session);
                const result = await generateText({
                    model: deps.model,
                    system: req.system,
                    messages: sanitizeMessages(req.messages),
                    tools: req.tools,
                    toolChoice: req.toolChoice ?? "auto",
                    stopWhen: [],
                    maxRetries: DEFAULT_MAX_RETRIES,
                    headers,
                    abortSignal: signal,
                    providerOptions: req.providerOptions,
                });
                return ok(responseFromGenerate(result));
            } catch (e) {
                if (isAbortError(e) || signal?.aborted) throw e;
                return err(toProviderError(e, workloadOf(session)));
            }
        };
        return new ResultAsync(run());
    }

    async function* chatStream(req: ChatRequest, session: AgentSession, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
        try {
            const headers = await deps.resolveBilling(session);
            const result = streamText({
                model: deps.model,
                system: req.system,
                messages: sanitizeMessages(req.messages),
                tools: req.tools,
                toolChoice: req.toolChoice ?? "auto",
                stopWhen: [],
                maxRetries: DEFAULT_MAX_RETRIES,
                headers,
                abortSignal: signal,
                providerOptions: req.providerOptions,
            });
            let text = "";
            for await (const delta of result.textStream) {
                text += delta;
                yield { type: "text-delta", text: delta };
            }
            const response = responseFromMessages(await result.responseMessages, text, await result.finishReason, await result.rawFinishReason);
            yield { type: "done", response };
        } catch (e) {
            if (isAbortError(e) || signal?.aborted) throw e;
            throw toProviderError(e, workloadOf(session));
        }
    }

    return { capabilities, chat, chatStream };
}

export function createConfiguredAiSdkProvider(deps: ConfiguredAiSdkProviderDeps): ChatProvider {
    const config = deps.config;
    if (config.kind === "anthropic") {
        const provider = createAnthropic({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            fetch: config.fetch as typeof fetch | undefined,
        });
        return createAiSdkProvider({ model: provider.chat(config.model), resolveBilling: deps.resolveBilling, capabilities: config.capabilities });
    }

    const provider = createOpenAICompatible({
        name: config.name,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        fetch: config.fetch as typeof fetch | undefined,
    });
    return createAiSdkProvider({ model: provider.chatModel(config.model), resolveBilling: deps.resolveBilling, capabilities: config.capabilities });
}
