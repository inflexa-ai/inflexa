import { generateText, streamText, type FinishReason, type LanguageModel, type LanguageModelUsage, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError } from "@ai-sdk/provider";
import { retryWithExponentialBackoff } from "@ai-sdk/provider-utils";
import { ResultAsync, err, ok, type Result } from "neverthrow";

import { scopeWorkloadId, type AgentSession } from "../auth/types.js";
import type { ResolveBilling } from "../billing/resolver.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { classifyProviderError, type ProviderError, toProviderError } from "./errors.js";
import type { ChatProvider, ChatRequest, ChatResponse, ChatStreamEvent, ChatUsage, FetchLike, ProviderCapabilities } from "./types.js";

/**
 * The harness-owned retry envelope. The AI SDK's built-in retry exposes only a
 * count: its 2s initial delay and ×2 factor are fixed, it caps neither the
 * per-attempt delay nor the total, and it ignores a server-named `Retry-After`.
 * Wrapping each wire attempt in `retryWithExponentialBackoff` with these values
 * gives a bounded, jittered envelope with a hard per-attempt delay ceiling.
 */
export const RETRY_MAX_RETRIES = 10;
export const RETRY_INITIAL_DELAY_MS = 2_000;
export const RETRY_BACKOFF_FACTOR = 2;
export const RETRY_MAX_DELAY_MS = 30_000;

export interface AiSdkProviderDeps {
    readonly model: LanguageModel;
    readonly resolveBilling: ResolveBilling;
    readonly capabilities?: Partial<ProviderCapabilities>;
    readonly logger?: Logger;
}

/**
 * Connection + model configuration for one `ChatProvider`, discriminated by
 * wire protocol (`anthropic` | `openai-compatible`). The `model` is the wire
 * model bound into the provider at construction: `ChatRequest` carries no model
 * field (see `./types.ts`), so a config value describes exactly one model over
 * one connection. An embedder running distinct models builds one provider per
 * model from configs that share the connection (same `baseURL`/`apiKey`) and
 * differ only in `model` — a single provider cannot be retargeted to another
 * model per request.
 */
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
    readonly logger?: Logger;
}

function workloadOf(session: AgentSession): string {
    return `${session.scope.kind}:${scopeWorkloadId(session.scope)}`;
}

function isAbortError(value: unknown): boolean {
    if (value instanceof DOMException && value.name === "AbortError") return true;
    if (value instanceof Error && value.name === "AbortError") return true;
    return false;
}

/**
 * Locate an `APICallError` on the throwable itself or one hop down its `cause`.
 * A wire failure the SDK raises is an `APICallError` directly; once rewrapped it
 * sits on the wrapper's `cause`, which is as deep as a `Retry-After` header is
 * ever carried.
 */
function apiCallErrorOf(error: unknown): APICallError | undefined {
    if (APICallError.isInstance(error)) return error;
    const cause = (error as { cause?: unknown } | null | undefined)?.cause;
    if (APICallError.isInstance(cause)) return cause;
    return undefined;
}

/** Case-insensitive header lookup; `name` must already be lowercase. */
function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
    if (headers === undefined) return undefined;
    const direct = headers[name];
    if (direct !== undefined) return direct;
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name) return value;
    }
    return undefined;
}

/** Parse a header to a finite number, or `undefined` when it is not numeric. */
function finiteNumber(value: string): number | undefined {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
}

/**
 * The delay a server named via `Retry-After`, in ms, or `undefined` when none
 * applies. `retry-after-ms` is float ms; `retry-after` is float seconds or an
 * HTTP date read relative to now. A value outside `[0, RETRY_MAX_DELAY_MS]` is
 * treated as absent so the jittered exponential delay governs instead — this
 * envelope does not honor a wait longer than its own ceiling verbatim.
 */
function serverNamedDelayMs(error: unknown): number | undefined {
    const headers = apiCallErrorOf(error)?.responseHeaders;
    if (headers === undefined) return undefined;

    let ms: number | undefined;
    const retryAfterMs = headerValue(headers, "retry-after-ms");
    if (retryAfterMs !== undefined) ms = finiteNumber(retryAfterMs);
    if (ms === undefined) {
        const retryAfter = headerValue(headers, "retry-after");
        if (retryAfter !== undefined) {
            const seconds = finiteNumber(retryAfter);
            if (seconds !== undefined) {
                ms = seconds * 1_000;
            } else {
                const at = Date.parse(retryAfter);
                if (Number.isFinite(at)) ms = at - Date.now();
            }
        }
    }
    if (ms === undefined || ms < 0 || ms > RETRY_MAX_DELAY_MS) return undefined;
    return ms;
}

/**
 * The delay before the next retry attempt. A server-named `Retry-After` inside
 * the envelope is honored exactly — the server pointed at a precise time, so
 * jitter would only fight it. Otherwise apply full jitter over the exponential
 * delay capped at `RETRY_MAX_DELAY_MS`: full jitter spreads a crowd of callers
 * that failed at the same instant across the window instead of re-colliding on
 * the same retry tick. `random` is injectable so the delay is testable.
 */
export function computeRetryDelayMs(error: unknown, exponentialBackoffDelay: number, random: () => number = Math.random): number {
    const named = serverNamedDelayMs(error);
    if (named !== undefined) return named;
    return random() * Math.min(exponentialBackoffDelay, RETRY_MAX_DELAY_MS);
}

/**
 * Marks a failure that came from the `ResolveBilling` seam rather than the model
 * wire. The retry envelope's budget is sized for model-provider outages; the
 * billing seam is a separate system whose failure must surface immediately, not
 * after a multi-minute retry window — even when the underlying failure is
 * connection-shaped and would otherwise read as retryable. The original throwable
 * rides on `cause` so the outer catch can hand it to `toProviderError` unchanged
 * and classify it byte-identically to a billing failure raised outside the
 * envelope (right down to the surfaced message).
 */
class BillingSeamFailure extends Error {
    constructor(cause: unknown) {
        super("billing resolution failed", { cause });
        this.name = "BillingSeamFailure";
    }
}

/**
 * Resolve attribution headers for one attempt, tagging any non-abort failure as
 * a `BillingSeamFailure` so the retry envelope fails fast on it. An abort is
 * rethrown raw so it stays on the abort control-flow path.
 */
async function resolveBillingHeaders(resolveBilling: ResolveBilling, session: AgentSession) {
    try {
        return await resolveBilling(session);
    } catch (e) {
        if (isAbortError(e)) throw e;
        throw new BillingSeamFailure(e);
    }
}

/** Unwrap a billing-seam failure to the original throwable for classification. */
function unwrapForClassification(e: unknown): unknown {
    return e instanceof BillingSeamFailure ? e.cause : e;
}

/**
 * Wrap a single wire attempt in the harness retry envelope. Built per call so
 * the caller's `AbortSignal` reaches the primitive: it rethrows abort errors
 * without retrying and cancels its own backoff sleep when the signal fires, so
 * the retried closure adds no abort handling of its own. `shouldRetry` defers to
 * the harness retryability taxonomy — but never retries a `BillingSeamFailure`,
 * whose fail-fast is the whole point of the marker — and a non-retried first
 * failure is rethrown untouched, preserving the exact throwable the outer catch
 * classifies. `createRetryError` carries the last real failure on `cause` so
 * that, once retries are exhausted, `toProviderError`'s status walk reaches the
 * true HTTP status instead of stopping at a synthetic wrapper. The attempt
 * counter is per-instance because each call builds its own retry.
 */
function createRetry(signal: AbortSignal | undefined, logger: Logger) {
    let retryCount = 0;
    return retryWithExponentialBackoff({
        maxRetries: RETRY_MAX_RETRIES,
        initialDelayInMs: RETRY_INITIAL_DELAY_MS,
        backoffFactor: RETRY_BACKOFF_FACTOR,
        abortSignal: signal,
        shouldRetry: (e) => !(e instanceof BillingSeamFailure) && classifyProviderError(e).retryable,
        getDelayInMs: ({ error, exponentialBackoffDelay }) => {
            const delayMs = computeRetryDelayMs(error, exponentialBackoffDelay);
            retryCount += 1;
            logger.debug("retrying provider call", { attempt: retryCount, delayMs, ...logger.errorFields(error) });
            return delayMs;
        },
        createRetryError: ({ message, errors }) => new Error(message, { cause: errors[errors.length - 1] }),
    });
}

/**
 * Map AI SDK token accounting onto the harness's neutral `ChatUsage`.
 *
 * The cache breakdown rides on the SDK's *vendor-neutral* `inputTokenDetails`,
 * not in `providerMetadata` — both installed providers normalize into it:
 * `@ai-sdk/anthropic` maps `cache_read_input_tokens` → `cacheReadTokens` and
 * `cache_creation_input_tokens` → `cacheWriteTokens`, and
 * `@ai-sdk/openai-compatible` maps `prompt_tokens_details.cached_tokens` →
 * `cacheReadTokens` (it never reports a write — that family caches
 * server-side, with no billed write step). Reading the neutral field is
 * therefore both correct and vendor-agnostic; the raw vendor payload remains
 * available under `providerMetadata.anthropic.usage` for debugging, in the
 * vendor's own snake_case.
 *
 * `inputTokens` is the total billed prefix, cache reads included.
 */
function toChatUsage(usage: LanguageModelUsage | undefined): ChatUsage | undefined {
    if (usage === undefined) return undefined;
    return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.inputTokenDetails?.cacheWriteTokens,
        cacheReadInputTokens: usage.inputTokenDetails?.cacheReadTokens,
    };
}

function responseFromMessages(
    messages: readonly ModelMessage[],
    fallbackText: string,
    finishReason: FinishReason,
    rawFinishReason?: string,
    usage?: LanguageModelUsage,
): ChatResponse {
    const message = [...messages].reverse().find((m): m is Extract<ModelMessage, { role: "assistant" }> => m.role === "assistant");
    if (message === undefined) {
        return {
            message: { role: "assistant", content: fallbackText },
            finishReason,
            rawFinishReason,
            usage: toChatUsage(usage),
        };
    }
    return { message, finishReason, rawFinishReason, usage: toChatUsage(usage) };
}

function responseFromGenerate(result: Awaited<ReturnType<typeof generateText>>): ChatResponse {
    return responseFromMessages(result.responseMessages, result.text, result.finishReason, result.rawFinishReason, result.usage);
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
    const logger = (deps.logger ?? createNoopLogger()).named("providers.ai-sdk");

    function chat(req: ChatRequest, session: AgentSession, signal?: AbortSignal): ResultAsync<ChatResponse, ProviderError> {
        const run = async (): Promise<Result<ChatResponse, ProviderError>> => {
            const retry = createRetry(signal, logger);
            try {
                const result = await retry(async () => {
                    // Attribution headers are time-limited; resolving them inside the
                    // retried closure keeps them fresh across a multi-minute window.
                    const headers = await resolveBillingHeaders(deps.resolveBilling, session);
                    return generateText({
                        model: deps.model,
                        system: req.system,
                        messages: sanitizeMessages(req.messages),
                        tools: req.tools,
                        toolChoice: req.toolChoice ?? "auto",
                        stopWhen: [],
                        // The harness envelope owns retries; leaving the SDK default in
                        // place would multiply attempts (10 outer × 3 inner).
                        maxRetries: 0,
                        headers,
                        abortSignal: signal,
                        providerOptions: req.providerOptions,
                    });
                });
                return ok(responseFromGenerate(result));
            } catch (e) {
                if (isAbortError(e) || signal?.aborted) throw e;
                return err(toProviderError(unwrapForClassification(e), workloadOf(session)));
            }
        };
        return new ResultAsync(run());
    }

    async function* chatStream(req: ChatRequest, session: AgentSession, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
        const retry = createRetry(signal, logger);
        try {
            // Retry covers only stream establishment: streamText defers wire errors
            // to consumption, so a failure is not visible until the stream is read.
            // The retried closure resolves to one of two outcomes — the stream is
            // live with a first delta in hand, or it finished without yielding any
            // text — and a delta is only ever yielded OUTSIDE the closure, so a
            // retried attempt can never re-emit a delta the consumer already saw.
            // Resolving billing inside the closure keeps attribution headers fresh
            // per attempt.
            const opened = await retry(async () => {
                const headers = await resolveBillingHeaders(deps.resolveBilling, session);
                const result = streamText({
                    model: deps.model,
                    system: req.system,
                    messages: sanitizeMessages(req.messages),
                    tools: req.tools,
                    toolChoice: req.toolChoice ?? "auto",
                    stopWhen: [],
                    maxRetries: 0,
                    headers,
                    abortSignal: signal,
                    providerOptions: req.providerOptions,
                });
                const iterator = result.textStream[Symbol.asyncIterator]();
                const first = await iterator.next();
                if (first.done) {
                    // A doStream promise rejection — the shape a real connection
                    // failure takes — does NOT surface at this first pull: streamText
                    // resolves it `{ done: true }` and defers the rejection to the
                    // deferred result promises. Awaiting them here brings that failure
                    // inside the retry envelope so a text-less establishment error is
                    // retried; a genuine text-less turn resolves them, and the terminal
                    // event is built from these already-resolved values without a
                    // second await. (These promises only settle once the stream is
                    // fully drained, so they can be awaited here only because the first
                    // pull already reported the stream done.)
                    return {
                        kind: "completed" as const,
                        messages: await result.responseMessages,
                        finishReason: await result.finishReason,
                        rawFinishReason: await result.rawFinishReason,
                        usage: await result.usage,
                    };
                }
                return { kind: "streaming" as const, result, iterator, firstDelta: first.value };
            });

            if (opened.kind === "completed") {
                const response = responseFromMessages(opened.messages, "", opened.finishReason, opened.rawFinishReason, opened.usage);
                yield { type: "done", response };
                return;
            }

            const { result, iterator, firstDelta } = opened;
            let text = firstDelta;
            yield { type: "text-delta", text: firstDelta };
            // Drain the same iterator: past the first delta, errors propagate
            // unchanged (no retry, no re-emit).
            for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
                text += next.value;
                yield { type: "text-delta", text: next.value };
            }
            const response = responseFromMessages(
                await result.responseMessages,
                text,
                await result.finishReason,
                await result.rawFinishReason,
                await result.usage,
            );
            yield { type: "done", response };
        } catch (e) {
            if (isAbortError(e) || signal?.aborted) throw e;
            throw toProviderError(unwrapForClassification(e), workloadOf(session));
        }
    }

    return { capabilities, chat, chatStream };
}

/**
 * Realize an `AiSdkProviderConfig` into a `ChatProvider` bound to that config's
 * connection and model. The model is closed into the returned provider here (it
 * is never passed per `ChatRequest`), so N models require N provider
 * instances over one shared connection configuration — one instance serves the
 * single model it was built with.
 */
export function createConfiguredAiSdkProvider(deps: ConfiguredAiSdkProviderDeps): ChatProvider {
    const config = deps.config;
    if (config.kind === "anthropic") {
        const provider = createAnthropic({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            fetch: config.fetch as typeof fetch | undefined,
        });
        return createAiSdkProvider({
            model: provider.chat(config.model),
            resolveBilling: deps.resolveBilling,
            capabilities: config.capabilities,
            logger: deps.logger,
        });
    }

    const provider = createOpenAICompatible({
        name: config.name,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        fetch: config.fetch as typeof fetch | undefined,
    });
    return createAiSdkProvider({
        model: provider.chatModel(config.model),
        resolveBilling: deps.resolveBilling,
        capabilities: config.capabilities,
        logger: deps.logger,
    });
}
