import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ResultAsync, err, ok, type Result } from "neverthrow";

import { scopeWorkloadId, type AgentSession } from "../auth/types.js";
import type { ResolveBilling } from "../billing/resolver.js";
import { type ProviderError, toProviderError } from "./errors.js";
import type { ChatProvider, ChatRequest, ChatResponse, ChatStreamEvent, FetchLike, ProviderCapabilities } from "./types.js";

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

function responseFromGenerate(result: Awaited<ReturnType<typeof generateText>>): ChatResponse {
    const message = [...result.responseMessages].reverse().find((m): m is Extract<(typeof result.responseMessages)[number], { role: "assistant" }> => m.role === "assistant");
    if (message === undefined) {
        return {
            message: { role: "assistant", content: result.text },
            finishReason: result.finishReason,
            rawFinishReason: result.rawFinishReason,
        };
    }
    return { message, finishReason: result.finishReason, rawFinishReason: result.rawFinishReason };
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
                    messages: [...req.messages],
                    tools: req.tools,
                    toolChoice: req.toolChoice ?? "auto",
                    stopWhen: [],
                    maxRetries: 0,
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
        const response = await chat(req, session, signal);
        if (response.isErr()) throw response.error;
        const content = response.value.message.content;
        if (typeof content === "string") {
            yield { type: "text-delta", text: content };
        } else {
            for (const part of content) {
                if (part.type === "text") yield { type: "text-delta", text: part.text };
            }
        }
        yield { type: "done", response: response.value };
    }

    return { capabilities, chat, chatStream };
}

export function createConfiguredAiSdkProvider(deps: ConfiguredAiSdkProviderDeps): ChatProvider {
    const config = deps.config;
    if (config.kind === "anthropic") {
        const provider = createAnthropic({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            fetch: config.fetch,
        });
        return createAiSdkProvider({ model: provider.chat(config.model), resolveBilling: deps.resolveBilling, capabilities: config.capabilities });
    }

    const provider = createOpenAICompatible({
        name: config.name,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        fetch: config.fetch,
    });
    return createAiSdkProvider({ model: provider.chatModel(config.model), resolveBilling: deps.resolveBilling, capabilities: config.capabilities });
}
