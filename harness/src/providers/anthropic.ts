/**
 * Anthropic chat provider.
 *
 * The ONLY file in the harness that imports the `@anthropic-ai/sdk`
 * runtime client (`types.ts` imports SDK *types* only — erased at compile
 * time; see the harness-providers spec). The SDK client is pointed at the billing-gateway base URL;
 * per-call billing headers are assembled from the `Session`. Both
 * `chat` and `chatStream` issue
 * streaming wire calls (`messages.stream()`) — the dev proxy is
 * streaming-only (CLAUDE.md design principle #7). `chat` collapses the
 * stream to a complete `Message` via the SDK's `finalMessage()`.
 *
 * Returned `Message` content blocks are Anthropic-native and verbatim,
 * including `thinking` blocks with their `signature` (see the harness-providers spec).
 */

import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import { ResultAsync, err, ok, type Result } from "neverthrow";

import { scopeWorkloadId } from "../auth/types.js";
import type { ResolveBilling } from "../billing/resolver.js";
import { type ProviderError, toProviderError } from "./errors.js";
import { anthropicAcceptsTemperature, maxOutputTokens } from "./llm-capabilities.js";
import type { ChatProvider, ChatRequest, ChatStreamEvent, FetchLike, Message } from "./types.js";
import type { AgentSession } from "../auth/types.js";

export interface AnthropicProviderDeps {
    /** Billing-gateway base URL — all LLM traffic is routed through it. */
    readonly baseURL: string;
    /** API token presented to the billing gateway. */
    readonly token: string;
    /** The Anthropic model id this provider instance calls. */
    readonly model: string;
    /** Resolves the billing attribution map at the call site. */
    readonly resolveBilling: ResolveBilling;
    /**
     * `fetch` override. Production omits it (the SDK's default is used);
     * tests inject a fake to feed a recorded SDK stream.
     */
    readonly fetch?: FetchLike;
}

/**
 * Strip per-call fields the target model rejects so the call succeeds
 * instead of 400'ing. Today only `temperature` on Anthropic 4.7+; widen
 * as new fields land.
 */
function gatePerCallOverrides(req: ChatRequest, model: string): ChatRequest {
    if (req.temperature !== undefined && !anthropicAcceptsTemperature(model)) {
        const { temperature: _drop, ...rest } = req;
        return rest;
    }
    return req;
}

export function createAnthropicProvider(deps: AnthropicProviderDeps): ChatProvider {
    const client = new Anthropic({
        baseURL: deps.baseURL,
        apiKey: deps.token,
        // The gateway owns provider retries and VK fallback; the SDK's own retry of
        // transient 429/5xx is the one layer kept (cheap, in-step, invisible to
        // any outer DBOS retry).
        maxRetries: 2,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });

    function workloadOf(session: AgentSession): string {
        return `${session.scope.kind}:${scopeWorkloadId(session.scope)}`;
    }

    async function openStream(req: ChatRequest, session: AgentSession, signal?: AbortSignal) {
        const headers = await deps.resolveBilling(session);
        const gated = gatePerCallOverrides(req, deps.model);
        return client.messages.stream(
            {
                ...gated,
                model: deps.model,
                max_tokens: maxOutputTokens(deps.model),
            },
            { headers, signal },
        );
    }

    function chat(req: ChatRequest, session: AgentSession, signal?: AbortSignal): ResultAsync<Message, ProviderError> {
        const run = async (): Promise<Result<Message, ProviderError>> => {
            try {
                const stream = await openStream(req, session, signal);
                return ok(await stream.finalMessage());
            } catch (e) {
                // A client abort is a control-flow exception, not a provider failure
                // — re-throw it verbatim so it escapes the Result channel.
                if (e instanceof APIUserAbortError) throw e;
                return err(toProviderError(e, workloadOf(session)));
            }
        };
        // `run` rejects only on the deliberate abort re-throw; that rejection
        // propagates as a real rejection of the wrapped promise (the abort never
        // becomes an `err`). `new ResultAsync(promise)` adopts a
        // `Promise<Result>` verbatim — no extra wrapping.
        return new ResultAsync(run());
    }

    async function* chatStream(req: ChatRequest, session: AgentSession, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
        // Throwing by contract: the SDK stream raises on failure (a client abort
        // surfaces as `APIUserAbortError`). The sole consumer
        // (`createStreamingChat`) catches and maps the throw into the Result
        // channel — re-classifying via `toProviderError` and re-throwing abort.
        const stream = await openStream(req, session, signal);
        for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                yield { type: "text-delta", text: event.delta.text };
            }
        }
        yield { type: "done", message: await stream.finalMessage() };
    }

    return { chat, chatStream };
}
