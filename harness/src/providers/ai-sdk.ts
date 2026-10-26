import { errorOf, errorNameOf } from "../lib/thrown.js";
import { textOf } from "../lib/unknown-text.js";
import { createHash } from "node:crypto";

import { wrapLanguageModel, type LanguageModelMiddleware, type LanguageModelUsage, type ProviderMetadata } from "ai";
import { createAnthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
// Any `providerOptions.anthropic.thinking` bypasses this table's thinking
// selection (see `thinkingWithBinding`).
import { getModelCapabilities } from "@ai-sdk/anthropic/internal";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { OpenTelemetry } from "@ai-sdk/otel";
import { APICallError, type LanguageModelV4, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { retryWithExponentialBackoff, type RetryFunction } from "@ai-sdk/provider-utils";
import { trace } from "@opentelemetry/api";

import { scopeWorkloadId, type AgentSession } from "../auth/types.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { GateRefusal } from "../lib/hooks.js";
import type { Logger } from "../lib/logger.js";
import { ResultError } from "../lib/result.js";

import { isUnknownArray } from "../lib/unknown-array.js";
import { parseUnknownRecord } from "../lib/unknown-containers.js";
import { DEFAULT_SUSPEND_ON, classifyProviderError, type ProviderError, RequestTimeoutError, type SuspendOn, toProviderError } from "./errors.js";
import { DEFAULT_REASONING } from "./reasoning.js";
import { headersRefusalError, requestHeadersFor, type RequestHeaders, type ResolveRequestHeaders } from "./request-headers.js";
import type { BoundModel, ChatProvider, ChatUsage, ModelBinding, ProviderCapabilities, ProviderOptions, ReasoningPolicy } from "./types.js";

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

/**
 * Output-token ceiling requested when a config names none — a floor against a
 * provider default, not a target. For an unset value, `@ai-sdk/anthropic`
 * defaults to 128000 for an unknown `claude-*` id and 4096 for a non-Claude
 * id. The anthropic arm always sends a value, so it never truncates mid
 * tool-call.
 *
 * Lower it per-config for servers that validate `prompt + max_tokens <= context`
 * (vLLM and similar) against a small-context model.
 *
 * The openai arm takes no value from this default. `@ai-sdk/openai` clamps
 * nothing per model, and it puts the number on the wire as it is. Thus a model
 * whose own cap is smaller answers 400 on each call. That arm sends no ceiling,
 * and the server then enforces the true cap of the model.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/**
 * Point the AI SDK's warning logger at the harness `Logger`.
 *
 * The SDK writes warnings itself — `process.emitWarning`, else `console.warn` —
 * and offers only this process-global hook to redirect them. Left alone it
 * bypasses the Logger seam entirely and lands on the stdout a TUI host owns;
 * `maxOutputTokens` makes that routine, since the SDK warns on every request
 * whose ceiling it clamps. Installed once: the handler is global, and every
 * provider over a boot shares one sink.
 */
function routeSdkWarningsTo(logger: Logger): void {
    // The SDK names a global that no declaration of `globalThis` describes, so the install reads and
    // writes the key reflectively.
    if (Reflect.get(globalThis, "AI_SDK_LOG_WARNINGS") !== undefined) return;
    Reflect.set(globalThis, "AI_SDK_LOG_WARNINGS", (options: { warnings: readonly unknown[]; provider?: string; model?: string }) => {
        for (const warning of options.warnings) {
            logger.warn("ai sdk warning", { provider: options.provider, model: options.model, warning });
        }
    });
}

/** With no `suspendOn`, a provider uses {@link DEFAULT_SUSPEND_ON}. */
export type ProviderHostPolicy = {
    readonly resolveRequestHeaders?: ResolveRequestHeaders;
    readonly suspendOn?: SuspendOn;
};

/** The call facts that `providerOptionsFor` uses to build provider options. */
export type ProviderCall = {
    readonly session: AgentSession;
    readonly reasoning: ReasoningPolicy;
};

export type AiSdkProviderDeps = ProviderHostPolicy & {
    readonly model: LanguageModelV4;
    readonly capabilities?: Partial<ProviderCapabilities>;
    readonly logger?: Logger;
    /**
     * Output-token ceiling per request. Defaults to
     * {@link DEFAULT_MAX_OUTPUT_TOKENS}. The value `"provider-maximum"` sends the
     * SDK no ceiling, and the server then enforces the true cap of the model. Use
     * the sentinel for a wire whose SDK puts the number on the request as it is,
     * because a ceiling above the cap of the model fails the call.
     */
    readonly maxOutputTokens?: number | "provider-maximum";
    /** The retry limit of the harness envelope. Defaults to {@link RETRY_MAX_RETRIES}. */
    readonly maxRetries?: number;
    /**
     * The bound for each silent interval of a request attempt, in milliseconds:
     * the wait for the first content part, and each gap between two content
     * parts. The value also names itself in the error of an attempt that the
     * bound stopped. When the field is absent, the provider bounds nothing.
     */
    readonly requestTimeoutMs?: number;
    /** Fallback effort when a run sets none. Defaults to {@link DEFAULT_REASONING}. */
    readonly reasoning?: ReasoningPolicy;
    /**
     * Builds provider options once per run, before the retry envelope, so
     * every attempt reuses the same options.
     */
    readonly providerOptionsFor?: (call: ProviderCall) => ProviderOptions | undefined;
};

/**
 * Connection + model configuration for one `ChatProvider`, discriminated by
 * wire protocol (`anthropic` | `openai` | `openai-compatible`). The `model` is the wire
 * model bound into the provider at construction, so a config value describes
 * exactly one model over one connection. An embedder running distinct models
 * builds one provider per model from configs that share the connection (same
 * `baseURL`/`apiKey`) and differ only in `model`.
 */
export type AiSdkProviderConfig =
    | {
          readonly kind: "anthropic";
          readonly baseURL?: string;
          readonly apiKey: string;
          readonly model: string;
          readonly fetch?: typeof fetch;
          readonly capabilities?: Partial<ProviderCapabilities>;
          /** Output-token ceiling per request. Defaults to {@link DEFAULT_MAX_OUTPUT_TOKENS}. */
          readonly maxOutputTokens?: number;
          /**
           * The bound for each silent interval of a request attempt, in
           * milliseconds. The value bounds the wait until the response starts, the
           * wait for the first content part, and each gap between two content
           * parts, per attempt. A chunk that carries no content, for example a
           * keep-alive comment, does not reset the gap bound. When the field is
           * absent, the provider installs no guard, and its behavior does not
           * change.
           *
           * The harness lifts the transport floor of Bun: the guard adds
           * `timeout: false` to the fetch init, thus the idle cut of 300 seconds
           * does not apply. Under Node the floor of undici stays. Thus a Node
           * embedder that sets a value above 300 seconds supplies a `fetch` whose
           * dispatcher raises that limit.
           */
          readonly requestTimeoutMs?: number;
          /**
           * The retry limit of the harness envelope. The envelope uses this value
           * in place of the default limit. When the field is absent, the envelope
           * keeps the default of 10.
           */
          readonly maxRetries?: number;
          /** Fallback effort when a run sets none. Defaults to {@link DEFAULT_REASONING}. */
          readonly reasoning?: ReasoningPolicy;
          /**
           * How the API handles a signed thinking block whose prefix changed.
           * Needs the `thinking-binding-controls-2026-08-01` beta header.
           */
          readonly thinkingBinding?: "drop_block" | "error" | "off";
      }
    | {
          readonly kind: "openai";
          readonly baseURL?: string;
          readonly apiKey: string;
          readonly model: string;
          readonly fetch?: typeof fetch;
          readonly capabilities?: Partial<ProviderCapabilities>;
          /**
           * Output-token ceiling per request. An unset value sends no ceiling, and
           * the model cap of the server governs the reply. The Responses wire holds
           * no low default, thus the omission cannot truncate a reply. Set a number
           * to hold the reply under a lower ceiling than the cap of the model.
           */
          readonly maxOutputTokens?: number;
          /**
           * The bound for each silent interval of a request attempt, in
           * milliseconds. The value bounds the wait until the response starts, the
           * wait for the first content part, and each gap between two content
           * parts, per attempt. A chunk that carries no content, for example a
           * keep-alive comment, does not reset the gap bound. When the field is
           * absent, the provider installs no guard, and its behavior does not
           * change.
           *
           * The harness lifts the transport floor of Bun: the guard adds
           * `timeout: false` to the fetch init, thus the idle cut of 300 seconds
           * does not apply. Under Node the floor of undici stays. Thus a Node
           * embedder that sets a value above 300 seconds supplies a `fetch` whose
           * dispatcher raises that limit.
           */
          readonly requestTimeoutMs?: number;
          /**
           * The retry limit of the harness envelope. The envelope uses this value
           * in place of the default limit. When the field is absent, the envelope
           * keeps the default of 10.
           */
          readonly maxRetries?: number;
          /** Fallback effort when a run sets none. Defaults to {@link DEFAULT_REASONING}. */
          readonly reasoning?: ReasoningPolicy;
          /**
           * NOTICE: this value is the retention directive of the Responses wire.
           *
           * An unset value lets the OpenAI server keep the response for 30 days.
           * The dashboard logs show that response, and a caller can retrieve it by
           * id. Thus the arm always sends an explicit value. The default is
           * `false`, and an analysis payload does not persist at OpenAI.
           *
           * An unset value is also not neutral inside the SDK. When the SDK sees
           * no explicit `false`, its input converter assumes storage. It then
           * replaces a round-tripped item with an `item_reference` entry. Such a
           * reference fails with a 404 under Zero Data Retention, and it fails
           * after the 30-day expiry.
           *
           * An explicit `false` selects the stateless reasoning path of the SDK.
           * The SDK adds `include: ["reasoning.encrypted_content"]` for a
           * reasoning-family model id. It captures the blob on `providerMetadata`,
           * and it replays the blob from the history of the thread. The SDK strips
           * a reasoning part that lost its blob, and it warns. That warning reaches
           * the harness logger through the SDK warning hook.
           *
           * One thread must keep one mode. The wire captures the history of a turn
           * under the mode of that turn. If a later turn replays a history of the
           * `false` mode under storage, the SDK emits a reference onto an item that
           * the server never stored.
           *
           * An operator can override the default with `true`. The dashboard then
           * shows the trail of the thread, and a caller can retrieve a response by
           * id. The harness does not use `previous_response_id`, and it does not
           * use `conversation`. This is true for the two modes.
           */
          readonly store?: boolean;
      }
    | {
          readonly kind: "openai-compatible";
          readonly name: string;
          readonly baseURL: string;
          readonly apiKey?: string;
          readonly model: string;
          readonly fetch?: typeof fetch;
          readonly capabilities?: Partial<ProviderCapabilities>;
          /** Output-token ceiling per request. Defaults to {@link DEFAULT_MAX_OUTPUT_TOKENS}. */
          readonly maxOutputTokens?: number;
          /**
           * The bound for each silent interval of a request attempt, in
           * milliseconds. The value bounds the wait until the response starts, the
           * wait for the first content part, and each gap between two content
           * parts, per attempt. A chunk that carries no content, for example a
           * keep-alive comment, does not reset the gap bound. When the field is
           * absent, the provider installs no guard, and its behavior does not
           * change.
           *
           * The harness lifts the transport floor of Bun: the guard adds
           * `timeout: false` to the fetch init, thus the idle cut of 300 seconds
           * does not apply. Under Node the floor of undici stays. Thus a Node
           * embedder that sets a value above 300 seconds supplies a `fetch` whose
           * dispatcher raises that limit.
           */
          readonly requestTimeoutMs?: number;
          /**
           * The retry limit of the harness envelope. The envelope uses this value
           * in place of the default limit. When the field is absent, the envelope
           * keeps the default of 10.
           */
          readonly maxRetries?: number;
          /** Fallback effort when a run sets none. Defaults to {@link DEFAULT_REASONING}. */
          readonly reasoning?: ReasoningPolicy;
      };

export type ConfiguredAiSdkProviderDeps = ProviderHostPolicy & {
    readonly config: AiSdkProviderConfig;
    readonly logger?: Logger;
};

function workloadOf(session: AgentSession): string {
    return `${session.scope.kind}:${scopeWorkloadId(session.scope)}`;
}

/**
 * Identifiers only, never a name or address. The run frame wins over the
 * thread so parallel steps of one run keep separate gateway cache accounts.
 */
export function sessionKeyOf(session: Pick<AgentSession, "scope" | "runFrame">): string {
    const { scope, runFrame } = session;
    if (runFrame !== undefined) {
        return runFrame.stepId === undefined ? `${scope.analysisId}:${runFrame.runId}` : `${scope.analysisId}:${runFrame.runId}:${runFrame.stepId}`;
    }
    return scope.threadId === undefined ? scope.analysisId : `${scope.analysisId}:${scope.threadId}`;
}

/**
 * Base64url SHA-256 digest of {@link sessionKeyOf}, always 43 characters.
 * OpenAI and Azure reject a `prompt_cache_key` over 64 characters with a
 * non-retryable 400.
 */
export function sessionKeyDigestOf(session: Pick<AgentSession, "scope" | "runFrame">): string {
    return createHash("sha256").update(sessionKeyOf(session)).digest("base64url");
}

/**
 * CAUTION: setting `providerOptions.anthropic.thinking` without a `type`
 * turns thinking off. Call only for a model whose capability row says
 * `rejectsThinkingDisabled`.
 */
function thinkingWithBinding(reasoning: ReasoningPolicy, mode: "drop_block" | "error"): NonNullable<AnthropicLanguageModelOptions["thinking"]> {
    const blockBinding = { prefixMismatchBehavior: mode };
    if (reasoning === "none" || reasoning === "provider-default") return { blockBinding };
    return { type: "adaptive", display: "summarized", blockBinding };
}

/** One input transformation that the Anthropic API reports. */
type InputTransformation = {
    readonly type?: string;
    readonly path?: string;
    readonly reason?: string;
};

/**
 * The model that answered after a server-side fallback hop, `""` when the hop is
 * reported without one, and `undefined` when no hop happened.
 *
 * A model can refuse a request by category — a biology prompt is one such category —
 * and the API then re-serves it on another model. It reports the hop TWICE: as a
 * `fallback` content block inside the assistant turn, and on
 * `providerMetadata.anthropic.iterations`. `@ai-sdk/anthropic` keeps only the second,
 * because the AI SDK has no part for a model hop, and it drops the block from the
 * content it returns (`anthropic-messages-language-model`, the `content_block_start`
 * case). Thus the turn the harness holds is not the turn the API produced, and every
 * signed thinking block of that turn is rejected from the next request on.
 *
 * The API holds the whole turn against the signature of each of its thinking blocks, so
 * echoing that turn earns `thinking ... blocks in the latest assistant message cannot be
 * modified`, which is a 400 that no retry can pass. A thinking block is optional on the
 * way back, thus the loop records the reply of a hop with no thinking block, and the next
 * request continues. The cost is the reasoning of this one turn and the cache write that
 * its new prefix pays for.
 *
 * The response metadata of the package carries `message_start.message.model`, and that
 * field keeps the REQUESTED model across a hop. The iteration names the model that
 * answered, thus it wins for the usage record.
 */
export function fallbackModelOf(metadata: ProviderMetadata | undefined): string | undefined {
    const entries = metadata?.["anthropic"]?.["iterations"];
    if (!isUnknownArray(entries)) return undefined;
    for (const entry of entries) {
        const record = parseUnknownRecord(entry);
        if (record === undefined || !("type" in record)) continue;
        if (record["type"] !== "fallback_message") continue;
        return "model" in record && typeof record["model"] === "string" ? record["model"] : "";
    }
    return undefined;
}

/** Reads `providerMetadata.anthropic.inputTransformations`; empty for another vendor. */
function inputTransformationsOf(metadata: ProviderMetadata | undefined): InputTransformation[] {
    const entries = metadata?.["anthropic"]?.["inputTransformations"];
    if (!isUnknownArray(entries)) return [];
    return entries.map((entry: unknown) => {
        const record = parseUnknownRecord(entry);
        const text = (key: string): string | undefined => {
            const value = record?.[key];
            return typeof value === "string" ? value : undefined;
        };
        return { type: text("type"), path: text("path"), reason: text("reason") };
    });
}

function isAbortError(value: unknown): boolean {
    return errorNameOf(value) === "AbortError";
}

/**
 * Locate an `APICallError` on the throwable itself or one hop down its `cause`.
 * A wire failure the SDK raises is an `APICallError` directly; once rewrapped it
 * sits on the wrapper's `cause`, which is as deep as a `Retry-After` header is
 * ever carried.
 */
function apiCallErrorOf(error: unknown): APICallError | undefined {
    if (APICallError.isInstance(error)) return error;
    if (error === null || typeof error !== "object" || !("cause" in error)) return undefined;
    const cause: unknown = error.cause;
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
 * A refusal of the request headers hook inside the retry envelope. The envelope
 * speaks exceptions, thus the refusal crosses it as this throw.
 */
class HeadersRefused extends Error {
    constructor(readonly refusal: GateRefusal) {
        super(`the request headers hook refused the model call: ${refusal.reason}`);
        this.name = "HeadersRefused";
    }
}

/**
 * A rejection of the request headers hook is a defect of the host, and the
 * harness does not catch it (host-hooks spec): the envelope never retries it,
 * and the outer catch rethrows it unchanged. The hook call has no `catch`, thus
 * this flag marks the rejection: it stays set when the hook call of the attempt
 * did not settle as a value.
 */
export type HookCall = {
    unsettled: boolean;
};

/** A refusal of the hook throws `HeadersRefused`. */
export async function headersForAttempt(hook: ResolveRequestHeaders | undefined, session: AgentSession, call: HookCall): Promise<Record<string, string>> {
    call.unsettled = true;
    const resolved = await requestHeadersFor(hook, session);
    call.unsettled = false;
    if (resolved.isErr()) throw new HeadersRefused(resolved.error);
    return { ...resolved.value } satisfies RequestHeaders;
}

export function failureOf(e: unknown, workload: string, suspendOn: SuspendOn): ProviderError {
    return e instanceof HeadersRefused ? headersRefusalError(e.refusal, workload) : toProviderError(e, workload, suspendOn);
}

/**
 * Wrap a single wire attempt in the harness retry envelope. Built per call so
 * the caller's `AbortSignal` reaches the primitive: it rethrows abort errors
 * without retrying and cancels its own backoff sleep when the signal fires, so
 * the retried closure adds no abort handling of its own. `shouldRetry` defers to
 * the harness retryability taxonomy under the `suspendOn` map of the provider —
 * thus a mapped status is never retried — and it never retries a refusal or a
 * rejection of the request headers hook. A non-retried first failure is rethrown untouched,
 * preserving the exact throwable the outer catch classifies. `createRetryError` carries the last real failure on `cause` so
 * that, once retries are exhausted, `toProviderError`'s status walk reaches the
 * true HTTP status instead of stopping at a synthetic wrapper. The attempt
 * counter is per-instance because each call builds its own retry.
 *
 * An aborted caller signal also stops the retry. A wall-clock guard of a caller
 * aborts with a `TimeoutError` reason, which the taxonomy marks as a retryable
 * timeout. Without this guard the envelope would loop an expiry that the caller
 * itself declared.
 */
export function createRetry(signal: AbortSignal | undefined, logger: Logger, maxRetries: number, suspendOn: SuspendOn, hookCall: HookCall): RetryFunction {
    let retryCount = 0;
    return retryWithExponentialBackoff({
        maxRetries,
        initialDelayInMs: RETRY_INITIAL_DELAY_MS,
        backoffFactor: RETRY_BACKOFF_FACTOR,
        abortSignal: signal,
        shouldRetry: (e) => !hookCall.unsettled && !(e instanceof HeadersRefused) && signal?.aborted !== true && classifyProviderError(e, suspendOn).retryable,
        getDelayInMs: ({ error, exponentialBackoffDelay }) => {
            const delayMs = computeRetryDelayMs(error, exponentialBackoffDelay);
            retryCount += 1;
            logger.debug("retrying provider call", { attempt: retryCount, delayMs, ...logger.errorFields(error) });
            return delayMs;
        },
        createRetryError: ({ message, errors }) => {
            const last = errors[errors.length - 1];
            // A refusal of the hook on a later attempt ends the call as that refusal, with its
            // suspend flag, and never as a wire failure whose message text the taxonomy reads.
            // A rejection of the hook leaves the envelope unchanged.
            return hookCall.unsettled || last instanceof HeadersRefused ? last : new Error(message, { cause: last });
        },
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
 * therefore both correct and vendor-agnostic.
 *
 * `inputTokens` is the total billed prefix, cache reads included.
 *
 * `reasoningTokens` rides the neutral `outputTokenDetails` beside the text
 * count and is copied verbatim: providers disagree on whether reasoning tokens
 * are already inside the output total, so the harness reconciles nothing.
 */
export function toChatUsage(usage: LanguageModelUsage | undefined): ChatUsage | undefined {
    if (usage === undefined) return undefined;
    return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.inputTokenDetails.cacheWriteTokens,
        cacheReadInputTokens: usage.inputTokenDetails.cacheReadTokens,
        reasoningTokens: usage.outputTokenDetails.reasoningTokens,
    };
}

/**
 * The HTTP status that each Anthropic stream error type stands for.
 *
 * A provider names a mid-stream failure in the payload, not in the status line:
 * a stream that carries `overloaded_error` reports the condition that a 529
 * names on the non-streaming wire. The classifier reads the status alone, thus
 * the part has to reach it as an error that names one.
 */
const STREAM_ERROR_STATUS: Readonly<Record<string, number>> = {
    invalid_request_error: 400,
    authentication_error: 401,
    permission_error: 403,
    not_found_error: 404,
    request_too_large: 413,
    rate_limit_error: 429,
    timeout_error: 408,
    api_error: 500,
    overloaded_error: 529,
};

/**
 * The failure that an `error` part of the model stream stands for.
 *
 * The part carries whatever the provider put on the wire, and that is often a
 * bare object rather than an `Error`. Left as it is, it reaches the message as
 * `[object Object]` and reaches the classifier with no status at all.
 */
function streamPartFailure(error: unknown): unknown {
    const thrownError = errorOf(error);
    if (thrownError !== undefined) return thrownError;
    if (typeof error !== "object" || error === null) return new Error(textOf(error));
    const type = "type" in error && typeof error.type === "string" ? error.type : undefined;
    const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
    const failure = new Error(message ?? type ?? "The provider reported a stream error.", { cause: error });
    const status = type === undefined ? undefined : STREAM_ERROR_STATUS[type];
    // `extractStatus` walks the chain for this field, thus the named condition
    // classifies the same way it would from a status line.
    if (status !== undefined) Object.assign(failure, { status });
    return failure;
}

/**
 * A part that the reader of a reply can see. A retry after one would show the
 * reader the start of the reply again, thus a live call retries only before the
 * first one. The same parts reset the silent-interval bound: a part that carries
 * no content does not prove that the model writes.
 */
function isOutputPart(part: LanguageModelV4StreamPart): boolean {
    return part.type !== "stream-start" && part.type !== "response-metadata" && part.type !== "raw";
}

/** One read of a model stream. */
type PartRead = { readonly done: true } | { readonly done: false; readonly value: LanguageModelV4StreamPart };

type BoundedReader = {
    read(): Promise<PartRead>;
    cancel(reason?: unknown): void;
};

/**
 * A reader of one model stream under the silent-interval bound. The bound runs
 * from the start of the read, and each output part resets it. A part with no
 * content leaves the bound as it was.
 */
function boundedReader(stream: ReadableStream<LanguageModelV4StreamPart>, timeoutMs: number | undefined): BoundedReader {
    const reader = stream.getReader();
    let deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
    return {
        async read(): Promise<PartRead> {
            if (deadline === undefined || timeoutMs === undefined) {
                const next = await reader.read();
                return next.done ? { done: true } : { done: false, value: next.value };
            }
            const remaining = Math.max(deadline - performance.now(), 0);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const expiry = new Promise<never>((_resolve, reject) => {
                // oxlint-disable-next-line eslint-js/no-restricted-syntax -- a guard, not a wait: it rejects the read of a silent stream at the bound, unrefs so an armed guard never holds a short-lived process, and the finally clears it.
                timer = setTimeout(() => reject(new RequestTimeoutError(timeoutMs)), remaining);
                timer.unref();
            });
            try {
                const next = await Promise.race([reader.read(), expiry]);
                if (next.done) return { done: true };
                if (isOutputPart(next.value)) deadline = performance.now() + timeoutMs;
                return { done: false, value: next.value };
            } catch (e) {
                void reader.cancel(e).catch(() => undefined);
                throw e;
            } finally {
                clearTimeout(timer);
            }
        },
        cancel(reason?: unknown): void {
            void reader.cancel(reason).catch(() => undefined);
        },
    };
}

/** The retry envelope of one run, and the facts that its log lines carry. */
type EnvelopeOptions = {
    readonly session: AgentSession;
    readonly live: boolean;
    readonly logger: Logger;
    readonly maxRetries: number;
    readonly suspendOn: SuspendOn;
    readonly requestTimeoutMs?: number;
    readonly resolveRequestHeaders?: ResolveRequestHeaders;
};

/**
 * The retry envelope of a model call, as a model middleware.
 *
 * Each attempt resolves the request headers of the host first: a host header can
 * be time-limited, and the retry window can last minutes. A live call retries
 * until its first output part, because a reader already saw each part after it.
 * A call with no live reader takes the whole reply inside the attempt, thus a
 * failure at any point of the stream runs the whole attempt again.
 *
 * After the last attempt, the failure leaves as a `ResultError` that carries the
 * classified `ProviderError`. An abort and a rejection of the headers hook leave
 * unchanged.
 */
function retryEnvelope(options: EnvelopeOptions): LanguageModelMiddleware {
    const { session, live, logger, maxRetries, suspendOn, requestTimeoutMs } = options;
    const workload = workloadOf(session);

    /** The one record of a call that the envelope gave up on: the reply carries the failure, and the operator sees this. */
    const failed = (thrown: unknown): ResultError => {
        const failure = failureOf(thrown, workload, suspendOn);
        logger.error("provider call failed", { workload, kind: failure.type, retryable: failure.retryable, ...logger.errorFields(thrown) });
        return new ResultError(failure);
    };

    const observeFinish = (part: LanguageModelV4StreamPart): void => {
        if (part.type !== "finish") return;
        for (const drop of inputTransformationsOf(part.providerMetadata)) {
            logger.warn("thinking block dropped", { workload, type: drop.type, path: drop.path, reason: drop.reason });
        }
        const servedBy = fallbackModelOf(part.providerMetadata);
        if (servedBy !== undefined) {
            logger.warn("reply served by a fallback model, thus the harness drops the thinking of that turn", {
                workload,
                servedBy: servedBy === "" ? undefined : servedBy,
            });
        }
    };

    return {
        specificationVersion: "v4",
        wrapStream: async ({ params, model }) => {
            const signal = params.abortSignal;
            const hookCall: HookCall = { unsettled: false };
            const retry = createRetry(signal, logger, maxRetries, suspendOn, hookCall);
            let opened: {
                readonly rest: Omit<Awaited<ReturnType<LanguageModelV4["doStream"]>>, "stream">;
                readonly head: LanguageModelV4StreamPart[];
                readonly tail?: BoundedReader;
            };
            try {
                opened = await retry(async () => {
                    const headers = await headersForAttempt(options.resolveRequestHeaders, session, hookCall);
                    const { stream, ...rest } = await model.doStream({ ...params, headers: { ...params.headers, ...headers } });
                    const reader = boundedReader(stream, requestTimeoutMs);
                    const head: LanguageModelV4StreamPart[] = [];
                    for (let next = await reader.read(); !next.done; next = await reader.read()) {
                        const part = next.value;
                        // The provider reports a wire failure as a part, and then it closes the stream.
                        if (part.type === "error") {
                            reader.cancel();
                            throw streamPartFailure(part.error);
                        }
                        head.push(part);
                        if (live && isOutputPart(part)) return { rest, head, tail: reader };
                    }
                    return { rest, head };
                });
            } catch (e) {
                if (isAbortError(e) || signal?.aborted === true || hookCall.unsettled) throw e;
                throw failed(e);
            }

            const { rest, head, tail } = opened;
            const stream = new ReadableStream<LanguageModelV4StreamPart>({
                start(controller) {
                    for (const part of head) {
                        observeFinish(part);
                        controller.enqueue(part);
                    }
                    if (tail === undefined) controller.close();
                },
                async pull(controller) {
                    if (tail === undefined) return;
                    try {
                        const next = await tail.read();
                        if (next.done) {
                            controller.close();
                            return;
                        }
                        const part = next.value;
                        if (part.type === "error") {
                            tail.cancel();
                            controller.enqueue({ type: "error", error: failed(streamPartFailure(part.error)) });
                            controller.close();
                            return;
                        }
                        observeFinish(part);
                        controller.enqueue(part);
                    } catch (e) {
                        // Past the first output part, a failure ends the reply with no retry: the reader saw its start.
                        if (isAbortError(e) || signal?.aborted === true) {
                            controller.error(e);
                            return;
                        }
                        controller.enqueue({ type: "error", error: failed(e) });
                        controller.close();
                    }
                },
                cancel(reason) {
                    tail?.cancel(reason);
                },
            });
            return { ...rest, stream };
        },
    };
}

export function createAiSdkProvider(deps: AiSdkProviderDeps): ChatProvider {
    const capabilities: ProviderCapabilities = {
        toolCalling: deps.capabilities?.toolCalling ?? true,
        // Propagate a picture flag only when the caller states it. An absent
        // flag stays absent, thus the loop drops a picture for a wire that
        // carries none in a tool result.
        imageToolResults: deps.capabilities?.imageToolResults,
        contextWindow: deps.capabilities?.contextWindow,
    };
    const logger = (deps.logger ?? createNoopLogger()).named("providers.ai-sdk");
    const maxOutputTokens = deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    // The sentinel hands the SDK no ceiling, thus the request carries none and the
    // server enforces the cap of the model.
    const outputCeiling: { maxOutputTokens?: number } = maxOutputTokens === "provider-maximum" ? {} : { maxOutputTokens };
    const maxRetries = deps.maxRetries ?? RETRY_MAX_RETRIES;
    const suspendOn = deps.suspendOn ?? DEFAULT_SUSPEND_ON;
    const requestTimeoutMs = deps.requestTimeoutMs;
    // Each model call and each tool call emits OpenTelemetry GenAI spans through the
    // AI SDK, with no prompt or completion text on them. The integration rides on each
    // call instead of the global registry, so the harness never traces the embedder's
    // own AI SDK calls.
    const telemetry = { integrations: new OpenTelemetry({ tracer: trace.getTracer("gen_ai") }), recordInputs: false, recordOutputs: false };
    routeSdkWarningsTo(logger);

    function bind(call: ModelBinding): BoundModel {
        const reasoning = call.reasoning ?? deps.reasoning ?? DEFAULT_REASONING;
        const model = wrapLanguageModel({
            model: deps.model,
            middleware: retryEnvelope({
                session: call.session,
                live: call.live,
                logger,
                maxRetries,
                suspendOn,
                requestTimeoutMs,
                resolveRequestHeaders: deps.resolveRequestHeaders,
            }),
        });
        const providerOptions = deps.providerOptionsFor?.({ session: call.session, reasoning });
        return { model, settings: { ...outputCeiling, reasoning, providerOptions }, telemetry };
    }

    // The provider advertises the guard limit on its own instance, thus a
    // consumer that scales a deadline reads it from the provider in its deps.
    return { capabilities, bind, requestTimeoutMs };
}

/**
 * Wrap a fetch so that the wait until the response starts does not exceed
 * `requestTimeoutMs`. The wrapper arms one timer for each fetch call. The timer
 * runs from the send until the fetch promise settles, and the headers of the
 * response settle it. On expiry the wrapper aborts a dedicated controller with a
 * `RequestTimeoutError` reason, and it composes that controller with the caller
 * signal through `AbortSignal.any`. Thus the caller signal keeps its normal
 * effect, and a caller abort stays a cancellation.
 *
 * The guard bounds the response start only. The retry envelope bounds each later
 * gap of a streamed body, thus no timer of the wrapper survives the headers. One
 * fetch call is one attempt, because the SDK retries are off, thus the window is
 * per attempt.
 *
 * When the field is absent, `createConfiguredAiSdkProvider` installs no wrapper,
 * and the behavior stays byte-identical.
 */
export function wrapFetchWithRequestTimeout(fetchImpl: typeof fetch, requestTimeoutMs: number): typeof fetch {
    return Object.assign(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const controller = new AbortController();
            const callerSignal = init?.signal ?? undefined;
            // oxlint-disable-next-line eslint-js/no-restricted-syntax -- a guard, not a wait: it aborts the controller of the in-flight fetch at the deadline, unrefs so an armed guard never holds a short-lived process, and the finally clears it.
            const timer = setTimeout(() => controller.abort(new RequestTimeoutError(requestTimeoutMs)), requestTimeoutMs);
            // The harness runs on Node, where a timer has `unref`. Unref the guard
            // timer, thus an armed guard does not keep a short-lived process alive.
            timer.unref();
            const clear = (): void => {
                clearTimeout(timer);
                // The harness runs on Node, where a caller signal can outlive one fetch
                // attempt. Remove the abort listener when the attempt settles, thus a
                // long-lived signal does not retain this closure.
                callerSignal?.removeEventListener("abort", clear);
            };

            // Compose the guard controller with the caller signal, thus either one
            // can abort the wire, and the abort reason names its own source. A caller
            // abort also clears the guard timer at once. Thus an armed timer does not
            // reach a pointless expiry after the caller cancels.
            const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
            callerSignal?.addEventListener("abort", clear, { once: true });

            // `timeout: false` is an extension of the fetch init of Bun. Bun cuts a
            // request that stays idle past its default of 300 seconds, and this key
            // lifts that cut. Node ignores an unknown member of the init, thus the key
            // is inert there. A probe on Bun 1.4.2 proved both results: the cut fired
            // at 360 seconds, because Bun pads the timer to its minute wheel, and a
            // request with the key completed after 420 seconds. The `RequestInit` type
            // declares no such member, thus the wider annotation.
            const forwarded: RequestInit & { timeout?: boolean } = { ...init, signal, timeout: false };
            try {
                return await fetchImpl(input, forwarded);
            } finally {
                clear();
            }
        },
        // `typeof fetch` is a callable with the `preconnect` member of the Bun declaration, so the
        // wrapper carries the member of the fetch it wraps.
        { preconnect: fetchImpl.preconnect },
    );
}

/**
 * Bind one explicit `store` directive onto each call of a model.
 *
 * The middleware merges the value into the `openai` namespace of
 * `providerOptions`. It keeps each other namespace, and it keeps each other key
 * of the `openai` namespace, thus the session key of the call
 * (`promptCacheKey`) rides through untouched. The retention mode belongs to the
 * connection and not to one turn: a thread that mixes the two modes replays a
 * reference onto an item that the server never stored.
 */
function withStoreDirective(model: LanguageModelV4, store: boolean): LanguageModelV4 {
    return wrapLanguageModel({
        model,
        middleware: {
            transformParams: ({ params }) =>
                Promise.resolve({
                    ...params,
                    providerOptions: { ...params.providerOptions, openai: { ...params.providerOptions?.openai, store } },
                }),
        },
    });
}

export function hostPolicyOf(deps: ProviderHostPolicy): ProviderHostPolicy {
    return {
        resolveRequestHeaders: deps.resolveRequestHeaders,
        suspendOn: deps.suspendOn,
    };
}

/**
 * Realize an `AiSdkProviderConfig` into a `ChatProvider` bound to that config's
 * connection and model. The model is closed into the returned provider here, so
 * N models require N provider instances over one shared connection
 * configuration — one instance serves the single model it was built with.
 *
 * When the config sets `requestTimeoutMs`, the provider wraps the effective fetch
 * (`config.fetch ?? globalThis.fetch`) with the response-start guard, the retry
 * envelope bounds each later silent interval with the same value, and the
 * provider advertises the value on the returned instance. When the field is
 * absent, it installs no wrapper, it bounds nothing, and it advertises no value.
 */
export function createConfiguredAiSdkProvider(deps: ConfiguredAiSdkProviderDeps): ChatProvider {
    const config = deps.config;
    const requestTimeoutMs = config.requestTimeoutMs;
    const effectiveFetch = requestTimeoutMs === undefined ? config.fetch : wrapFetchWithRequestTimeout(config.fetch ?? globalThis.fetch, requestTimeoutMs);

    if (config.kind === "anthropic") {
        const provider = createAnthropic({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            fetch: effectiveFetch,
        });
        // The Anthropic Messages wire renders an image block inside a
        // tool_result, thus the loop can send a picture. A custom baseURL can
        // front a different backend that stringifies the block. Thus the
        // harness asserts the capability only for the default endpoint. An
        // absent flag means "cannot carry", thus a config with a custom baseURL
        // must declare the capability. A config value overrides this default in
        // both directions.
        const pictureDefault: Partial<ProviderCapabilities> = config.baseURL === undefined ? { imageToolResults: true } : {};
        // A model that can run without thinking gets no binding (see `thinkingWithBinding`).
        const bindingMode = config.thinkingBinding ?? "drop_block";
        const binding = bindingMode !== "off" && getModelCapabilities(config.model).rejectsThinkingDisabled ? bindingMode : undefined;
        return createAiSdkProvider({
            model: provider.chat(config.model),
            ...hostPolicyOf(deps),
            capabilities: { ...pictureDefault, ...config.capabilities },
            logger: deps.logger,
            maxOutputTokens: config.maxOutputTokens,
            maxRetries: config.maxRetries,
            requestTimeoutMs,
            reasoning: config.reasoning,
            // The package sends the key as `metadata.user_id`, and the binding as
            // `thinking.block_binding`.
            providerOptionsFor: ({ session, reasoning }) => ({
                anthropic: {
                    metadata: { userId: sessionKeyDigestOf(session) },
                    thinking: binding === undefined ? undefined : thinkingWithBinding(reasoning, binding),
                } satisfies AnthropicLanguageModelOptions,
            }),
        });
    }

    if (config.kind === "openai") {
        const provider = createOpenAI({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            fetch: effectiveFetch,
        });
        // The Responses wire renders an image block inside a function-call
        // output, thus the loop can send a picture. A custom baseURL can front
        // a different backend that stringifies the block. Thus the harness
        // asserts the capability only for the default endpoint. An absent flag
        // means "cannot carry", thus a config with a custom baseURL must
        // declare the capability. A config value overrides this default in both
        // directions.
        const pictureDefault: Partial<ProviderCapabilities> = config.baseURL === undefined ? { imageToolResults: true } : {};
        return createAiSdkProvider({
            // The explicit Responses binding pins the wire here. The bare
            // factory callable of the package resolves to the same path today,
            // but nothing in the package holds it there.
            model: withStoreDirective(provider.responses(config.model), config.store ?? false),
            ...hostPolicyOf(deps),
            capabilities: { ...pictureDefault, ...config.capabilities },
            logger: deps.logger,
            // The package puts this number on the wire as it is, and it clamps
            // nothing per model. Thus the shared default of 64000 breaks each call
            // to a model with a smaller cap, with a 400 that no retry can pass. An
            // unset config sends no ceiling, and the server holds the reply at the
            // cap of the model.
            maxOutputTokens: config.maxOutputTokens ?? "provider-maximum",
            maxRetries: config.maxRetries,
            requestTimeoutMs,
            reasoning: config.reasoning,
            // The package sends the key as `prompt_cache_key`. The store
            // directive merges into the same namespace, and it keeps this key.
            providerOptionsFor: ({ session }) => ({ openai: { promptCacheKey: sessionKeyDigestOf(session) } }),
        });
    }

    const provider = createOpenAICompatible({
        name: config.name,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        fetch: effectiveFetch,
        // Each call of the provider streams. Without this flag the package asks for
        // no usage on a stream, and the call reports none.
        includeUsage: true,
    });
    // The compatible wire has no standard field for a session key, thus this arm
    // gives no provider options of its own.
    return createAiSdkProvider({
        // The compatible package reads the neutral `reasoning` of the call, thus
        // the seam needs no middleware to carry the depth into its namespace.
        model: provider.chatModel(config.model),
        ...hostPolicyOf(deps),
        capabilities: config.capabilities,
        logger: deps.logger,
        maxOutputTokens: config.maxOutputTokens,
        maxRetries: config.maxRetries,
        requestTimeoutMs,
        reasoning: config.reasoning,
    });
}
