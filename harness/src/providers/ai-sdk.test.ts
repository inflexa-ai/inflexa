import { describe, expect, it } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamPart,
    LanguageModelV4StreamResult,
    LanguageModelV4Usage,
} from "@ai-sdk/provider";

import { makeSession } from "./__fixtures__/session.js";
import {
    computeRetryDelayMs,
    createAiSdkProvider,
    createConfiguredAiSdkProvider,
    RETRY_BACKOFF_FACTOR,
    RETRY_INITIAL_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRY_MAX_RETRIES,
} from "./ai-sdk.js";
import { isProviderError } from "./errors.js";
import type { ChatRequest } from "./types.js";

const usage: LanguageModelV4Usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function okResult(text = "ok"): LanguageModelV4GenerateResult {
    return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
    };
}

function streamResult(deltas: readonly string[]): LanguageModelV4StreamResult {
    return {
        stream: new ReadableStream({
            start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "txt-1" });
                for (const delta of deltas) {
                    controller.enqueue({ type: "text-delta", id: "txt-1", delta });
                }
                controller.enqueue({ type: "text-end", id: "txt-1" });
                controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
                controller.close();
            },
        }),
    };
}

function fakeModel(
    impl: (options: LanguageModelV4CallOptions) => Promise<LanguageModelV4GenerateResult>,
    streamImpl?: (options: LanguageModelV4CallOptions) => Promise<LanguageModelV4StreamResult>,
): LanguageModelV4 {
    return {
        specificationVersion: "v4",
        provider: "fake-provider",
        modelId: "fake-model",
        supportedUrls: {},
        doGenerate: impl,
        doStream:
            streamImpl ??
            (async () => {
                throw new Error("streaming is not used in these tests");
            }),
    };
}

const request: ChatRequest = {
    system: "You are a test model.",
    messages: [{ role: "user", content: "hello" }],
    tools: {},
};

/**
 * A real 503 `APICallError` naming a zero-millisecond `retry-after-ms` by
 * default. Retry backoff is a genuine wall-clock sleep here — the provider
 * injects no timer — so a server-named 0ms delay is what lets a full
 * exhaustion run (1 + RETRY_MAX_RETRIES attempts) finish inside bun's 5s
 * per-test budget while still exercising the real header-honoring path. Pass
 * other headers to drive the delay/classification a specific test needs.
 */
function apiError503(responseHeaders: Record<string, string> = { "retry-after-ms": "0" }): APICallError {
    return new APICallError({
        message: "upstream unavailable",
        url: "https://model.test/v1/messages",
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders,
        isRetryable: true,
    });
}

/**
 * A stream that fails during establishment by erroring before any text delta
 * reaches the consumer, so the failure surfaces at the retried closure's first
 * `textStream` pull. This is one of two distinct SDK surfacing paths the retry
 * envelope covers — the other is a `doStream` promise rejection, which
 * `streamText` defers past a clean first pull to the result promises — so each
 * flavor is exercised on its own.
 */
function streamErrorsBeforeDelta(error: unknown): LanguageModelV4StreamResult {
    return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.error(error);
            },
        }),
    };
}

/**
 * A well-formed stream that finishes cleanly without ever emitting a text part —
 * a genuine text-less turn. Pins that awaiting the deferred result promises
 * inside the envelope resolves such a turn instead of mistaking its empty first
 * pull for an establishment failure to retry.
 */
function streamWithNoText(): LanguageModelV4StreamResult {
    return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
                controller.close();
            },
        }),
    };
}

/**
 * A stream that delivers exactly one text delta and then errors. The error is
 * raised on a later pull rather than in the same tick as the delta so the
 * consumer observes the delta before the failure — a same-tick `controller.error`
 * races ahead of the buffered delta and the consumer never sees it.
 */
function streamDeltaThenError(delta: string, error: unknown): LanguageModelV4StreamResult {
    let step = 0;
    return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
            pull(controller) {
                step += 1;
                if (step === 1) controller.enqueue({ type: "stream-start", warnings: [] });
                else if (step === 2) controller.enqueue({ type: "text-start", id: "txt-1" });
                else if (step === 3) controller.enqueue({ type: "text-delta", id: "txt-1", delta });
                else controller.error(error);
            },
        }),
    };
}

describe("createAiSdkProvider", () => {
    it("runs an embedder-supplied AI SDK language model and applies billing headers", async () => {
        const calls: LanguageModelV4CallOptions[] = [];
        const provider = createAiSdkProvider({
            model: fakeModel(async (options) => {
                calls.push(options);
                return okResult("done");
            }),
            resolveBilling: async () => ({ "X-Billing-Context": "bc-test", "X-Billing-Virtual-Key": "vk-test" }),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().message).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }] });
        expect(calls[0]!.headers).toMatchObject({
            "x-billing-context": "bc-test",
            "x-billing-virtual-key": "vk-test",
        });
    });

    it("returns classified ProviderError values for provider failures", async () => {
        const provider = createAiSdkProvider({
            model: fakeModel(async () => {
                throw Object.assign(new Error("payment required"), { status: 402 });
            }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error).toMatchObject({
                type: "budget",
                retryable: false,
            });
        }
    });

    it("rethrows aborts instead of classifying them", async () => {
        const signal = AbortSignal.abort();
        const provider = createAiSdkProvider({
            model: fakeModel(async () => {
                throw new DOMException("aborted", "AbortError");
            }),
            resolveBilling: async () => ({}),
        });

        try {
            const result = await provider.chat(request, makeSession(), signal);
            throw new Error(`expected abort to be rethrown, got a ${result.isOk() ? "ok" : "err"} result`);
        } catch (err) {
            expect(err).toBeInstanceOf(DOMException);
            expect((err as DOMException).name).toBe("AbortError");
        }
    });

    it("streams deltas through the AI SDK streaming primitive", async () => {
        const generateCalls: LanguageModelV4CallOptions[] = [];
        const streamCalls: LanguageModelV4CallOptions[] = [];
        const provider = createAiSdkProvider({
            model: fakeModel(
                async (options) => {
                    generateCalls.push(options);
                    return okResult("should not be used");
                },
                async (options) => {
                    streamCalls.push(options);
                    return streamResult(["he", "llo"]);
                },
            ),
            resolveBilling: async () => ({ "X-Billing-Context": "bc-test" }),
        });

        const events = [];
        for await (const event of provider.chatStream(request, makeSession())) {
            events.push(event);
        }

        expect(generateCalls).toHaveLength(0);
        expect(streamCalls).toHaveLength(1);
        expect(streamCalls[0]!.headers).toMatchObject({ "X-Billing-Context": "bc-test" });
        expect(events).toEqual([
            { type: "text-delta", text: "he" },
            { type: "text-delta", text: "llo" },
            {
                type: "done",
                response: {
                    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
                    finishReason: "stop",
                    rawFinishReason: "stop",
                    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
                },
            },
        ]);
    });

    it("rejects tool-required agents before the first model call when tool calling is disabled", async () => {
        const calls: LanguageModelV4CallOptions[] = [];
        const provider = createAiSdkProvider({
            model: fakeModel(async (options) => {
                calls.push(options);
                return okResult();
            }),
            resolveBilling: async () => ({}),
            capabilities: { toolCalling: false },
        });

        expect(provider.capabilities.toolCalling).toBe(false);
        expect(calls).toHaveLength(0);
    });
});

describe("empty text block sanitization", () => {
    // The Anthropic API 400s on any request containing an empty text block, and
    // the SDK's response assembly produces one whenever a turn goes straight to
    // tool calls — the loop then echoes that assistant message back as history.
    it("strips empty text parts from echoed history before the wire call", async () => {
        const calls: LanguageModelV4CallOptions[] = [];
        const provider = createAiSdkProvider({
            model: fakeModel(async (options) => {
                calls.push(options);
                return okResult("done");
            }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(
            {
                system: "You are a test model.",
                messages: [
                    { role: "user", content: "profile the files" },
                    {
                        role: "assistant",
                        content: [
                            { type: "text", text: "" },
                            { type: "tool-call", toolCallId: "tc-1", toolName: "execute_command", input: { command: "ls" } },
                        ],
                    },
                    {
                        role: "tool",
                        content: [{ type: "tool-result", toolCallId: "tc-1", toolName: "execute_command", output: { type: "text", value: "ok" } }],
                    },
                    { role: "assistant", content: "" },
                ],
                tools: {},
            },
            makeSession(),
        );

        expect(result.isOk()).toBe(true);
        const textParts = calls[0]!.prompt.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "text") : []));
        for (const part of textParts) {
            expect(part.text).not.toBe("");
        }
        // The tool call survives the strip; the all-empty assistant message is dropped whole.
        const json = JSON.stringify(calls[0]!.prompt);
        expect(json).toContain("tc-1");
        expect(json).not.toContain('"text":""');
    });
});

describe("usage reporting", () => {
    // The cache breakdown rides on the SDK's vendor-neutral `inputTokenDetails`
    // (`@ai-sdk/anthropic` normalizes `cache_read_input_tokens` /
    // `cache_creation_input_tokens` into it) — not on `providerMetadata`, which
    // carries only the raw snake_case vendor payload.
    const cachedUsage: LanguageModelV4Usage = {
        inputTokens: { total: 2000, noCache: 100, cacheRead: 1700, cacheWrite: 200 },
        outputTokens: { total: 42, text: 42, reasoning: 0 },
    };

    it("surfaces input/output and cache tokens on the generate path", async () => {
        const provider = createAiSdkProvider({
            model: fakeModel(async () => ({
                content: [{ type: "text", text: "done" }],
                finishReason: { unified: "stop", raw: "stop" },
                usage: cachedUsage,
                warnings: [],
            })),
            resolveBilling: async () => ({}),
        });

        const reply = (await provider.chat(request, makeSession()))._unsafeUnwrap();

        expect(reply.usage).toEqual({
            inputTokens: 2000,
            outputTokens: 42,
            cacheCreationInputTokens: 200,
            cacheReadInputTokens: 1700,
        });
    });

    it("surfaces the same usage on the stream path's terminal event", async () => {
        const provider = createAiSdkProvider({
            model: fakeModel(
                async () => okResult(),
                async () => ({
                    stream: new ReadableStream({
                        start(controller) {
                            controller.enqueue({ type: "stream-start", warnings: [] });
                            controller.enqueue({ type: "text-start", id: "txt-1" });
                            controller.enqueue({ type: "text-delta", id: "txt-1", delta: "done" });
                            controller.enqueue({ type: "text-end", id: "txt-1" });
                            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: cachedUsage });
                            controller.close();
                        },
                    }),
                }),
            ),
            resolveBilling: async () => ({}),
        });

        const events = [];
        for await (const event of provider.chatStream(request, makeSession())) events.push(event);

        const done = events.at(-1);
        if (done?.type !== "done") throw new Error(`expected a terminal done event, got ${done?.type}`);
        expect(done.response.usage).toEqual({
            inputTokens: 2000,
            outputTokens: 42,
            cacheCreationInputTokens: 200,
            cacheReadInputTokens: 1700,
        });
    });

    it("leaves cache fields undefined when a provider reports no cache breakdown", async () => {
        const provider = createAiSdkProvider({
            model: fakeModel(async () => ({
                content: [{ type: "text", text: "done" }],
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                    inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
                    outputTokens: { total: 5, text: 5, reasoning: undefined },
                },
                warnings: [],
            })),
            resolveBilling: async () => ({}),
        });

        const reply = (await provider.chat(request, makeSession()))._unsafeUnwrap();

        expect(reply.usage?.inputTokens).toBe(50);
        expect(reply.usage?.cacheReadInputTokens).toBeUndefined();
        expect(reply.usage?.cacheCreationInputTokens).toBeUndefined();
    });

    it("forwards the request's providerOptions verbatim to the model", async () => {
        const calls: LanguageModelV4CallOptions[] = [];
        const provider = createAiSdkProvider({
            model: fakeModel(async (options) => {
                calls.push(options);
                return okResult();
            }),
            resolveBilling: async () => ({}),
        });

        await provider.chat({ ...request, providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } } }, makeSession());

        expect(calls[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } });
    });
});

describe("createConfiguredAiSdkProvider", () => {
    it("constructs an OpenAI-compatible provider from endpoint/key/model configuration", () => {
        const provider = createConfiguredAiSdkProvider({
            config: {
                kind: "openai-compatible",
                name: "self-hosted",
                baseURL: "http://models.local/v1",
                apiKey: "test-key",
                model: "local-tool-model",
                capabilities: { toolCalling: true },
            },
            resolveBilling: async () => ({}),
        });

        expect(provider.capabilities.toolCalling).toBe(true);
    });
});

describe("computeRetryDelayMs", () => {
    it("scales the exponential input with full jitter and caps it at the ceiling", () => {
        // random = () => 1 removes jitter, so the result is the capped input itself.
        const noJitter = () => 1;
        expect(computeRetryDelayMs(new Error("transient"), 2_000, noJitter)).toBe(2_000);
        expect(computeRetryDelayMs(new Error("transient"), 4_000, noJitter)).toBe(4_000);
        expect(computeRetryDelayMs(new Error("transient"), 8_000, noJitter)).toBe(8_000);
        expect(computeRetryDelayMs(new Error("transient"), 16_000, noJitter)).toBe(16_000);
        expect(computeRetryDelayMs(new Error("transient"), 32_000, noJitter)).toBe(RETRY_MAX_DELAY_MS);
    });

    it("spreads the delay across the full jitter window for a fixed input", () => {
        expect(computeRetryDelayMs(new Error("transient"), 10_000, () => 0)).toBe(0);
        expect(computeRetryDelayMs(new Error("transient"), 10_000, () => 0.5)).toBe(5_000);
    });

    it("honors a server-named retry-after-ms exactly, ignoring jitter", () => {
        expect(computeRetryDelayMs(apiError503({ "retry-after-ms": "1500" }), 8_000, () => 0.9)).toBe(1_500);
    });

    it("reads retry-after seconds and an HTTP-date retry-after", () => {
        expect(computeRetryDelayMs(apiError503({ "retry-after": "2" }), 8_000, () => 1)).toBe(2_000);

        const tenSecondsOut = new Date(Date.now() + 10_000).toUTCString();
        const ms = computeRetryDelayMs(apiError503({ "retry-after": tenSecondsOut }), 8_000, () => 1);
        // HTTP dates carry no sub-second precision, so the parsed offset lands a
        // little under the full 10s window it names.
        expect(ms).toBeGreaterThan(8_000);
        expect(ms).toBeLessThanOrEqual(10_000);
    });

    it("falls back to jitter when the server-named delay is outside the envelope", () => {
        // Above the ceiling and negative are both treated as absent, so the
        // jittered exponential governs instead of the verbatim header value.
        expect(computeRetryDelayMs(apiError503({ "retry-after-ms": "30001" }), 2_000, () => 1)).toBe(2_000);
        expect(computeRetryDelayMs(apiError503({ "retry-after-ms": "-5" }), 2_000, () => 1)).toBe(2_000);
    });

    it("reads the retry-after header from an APICallError one cause hop down", () => {
        const wrapped = new Error("rewrapped by the SDK", { cause: apiError503({ "retry-after-ms": "1200" }) });
        expect(computeRetryDelayMs(wrapped, 8_000, () => 0.1)).toBe(1_200);
    });
});

describe("createAiSdkProvider chat retry", () => {
    it("retries a connection failure and succeeds on the next attempt", async () => {
        let attempts = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(async () => {
                attempts += 1;
                if (attempts === 1) {
                    throw Object.assign(new TypeError("fetch failed"), {
                        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
                    });
                }
                return okResult("recovered");
            }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().message).toEqual({ role: "assistant", content: [{ type: "text", text: "recovered" }] });
        expect(attempts).toBe(2);
        // A single connection retry has no server-named delay, so it sleeps a
        // real jittered backoff of up to the 2s initial window.
    }, 10_000);

    it("returns the classified error after exactly one attempt for a non-retryable status", async () => {
        const cases = [
            { status: 401, type: "auth" },
            { status: 402, type: "budget" },
            { status: 403, type: "tenant-blocked" },
            { status: 400, type: "provider" },
        ] as const;

        for (const { status, type } of cases) {
            let attempts = 0;
            const provider = createAiSdkProvider({
                model: fakeModel(async () => {
                    attempts += 1;
                    throw Object.assign(new Error(`HTTP ${status}`), { status });
                }),
                resolveBilling: async () => ({}),
            });

            const result = await provider.chat(request, makeSession());

            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                expect(result.error.type).toBe(type);
                expect(result.error.retryable).toBe(false);
            }
            expect(attempts).toBe(1);
        }
    });

    it("exhausts retries on a persistent retryable failure and preserves the transient classification", async () => {
        let attempts = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(async () => {
                attempts += 1;
                // The 503 reaches classification down the retry wrapper's cause
                // chain; asserting type/retryable proves it stayed reachable.
                throw apiError503();
            }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(attempts).toBe(1 + RETRY_MAX_RETRIES);
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("provider");
            expect(result.error.retryable).toBe(true);
        }
    });

    it("resolves fresh billing headers on every attempt", async () => {
        let billingInvocations = 0;
        let attempts = 0;
        const calls: LanguageModelV4CallOptions[] = [];
        const provider = createAiSdkProvider({
            model: fakeModel(async (options) => {
                calls.push(options);
                attempts += 1;
                if (attempts === 1) throw apiError503();
                return okResult();
            }),
            resolveBilling: async () => {
                billingInvocations += 1;
                return { "x-billing-attempt": `attempt-${billingInvocations}` };
            },
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(calls).toHaveLength(2);
        expect(calls[1]!.headers).toMatchObject({ "x-billing-attempt": "attempt-2" });
    });
});

describe("createAiSdkProvider abort during backoff", () => {
    it("abandons a pending retry backoff when the signal fires", async () => {
        let attempts = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(async () => {
                attempts += 1;
                // A 4s server-named delay makes the backoff long enough that only
                // the abort — not the delay elapsing — can end the call quickly.
                throw apiError503({ "retry-after-ms": "4000" });
            }),
            resolveBilling: async () => ({}),
        });

        const controller = new AbortController();
        const startedAt = Date.now();
        setTimeout(() => controller.abort(), 50);

        try {
            const outcome = await provider.chat(request, makeSession(), controller.signal);
            throw new Error(`expected the abort to reject the call, got a ${outcome.isOk() ? "ok" : "err"} result`);
        } catch (err) {
            expect(err).toBeInstanceOf(DOMException);
            expect((err as DOMException).name).toBe("AbortError");
        }

        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(attempts).toBe(1);
    }, 10_000);
});

describe("createAiSdkProvider chatStream retry", () => {
    it("retries stream establishment and then streams the recovered deltas", async () => {
        let attempts = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(
                async () => okResult(),
                async () => {
                    attempts += 1;
                    if (attempts === 1) return streamErrorsBeforeDelta(apiError503());
                    return streamResult(["a", "b"]);
                },
            ),
            resolveBilling: async () => ({}),
        });

        const events = [];
        for await (const event of provider.chatStream(request, makeSession())) events.push(event);

        expect(attempts).toBe(2);
        expect(events).toEqual([
            { type: "text-delta", text: "a" },
            { type: "text-delta", text: "b" },
            {
                type: "done",
                response: {
                    message: { role: "assistant", content: [{ type: "text", text: "ab" }] },
                    finishReason: "stop",
                    rawFinishReason: "stop",
                    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
                },
            },
        ]);
    });

    it("does not retry or re-emit once the first delta has reached the consumer", async () => {
        let attempts = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(
                async () => okResult(),
                async () => {
                    attempts += 1;
                    return streamDeltaThenError("a", apiError503());
                },
            ),
            resolveBilling: async () => ({}),
        });

        const deltas: string[] = [];
        let threw = false;
        try {
            for await (const event of provider.chatStream(request, makeSession())) {
                if (event.type === "text-delta") deltas.push(event.text);
            }
        } catch {
            threw = true;
        }

        expect(deltas).toEqual(["a"]);
        expect(threw).toBe(true);
        expect(attempts).toBe(1);
    });

    it("exhausts establishment retries and throws the classified provider error", async () => {
        let attempts = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(
                async () => okResult(),
                async () => {
                    attempts += 1;
                    return streamErrorsBeforeDelta(apiError503());
                },
            ),
            resolveBilling: async () => ({}),
        });

        let caught: unknown;
        try {
            for await (const _part of provider.chatStream(request, makeSession())) {
                // Each establishment attempt errors before any delta, so the body
                // is never reached; draining runs the retries to exhaustion.
            }
        } catch (e) {
            caught = e;
        }

        expect(attempts).toBe(1 + RETRY_MAX_RETRIES);
        expect(isProviderError(caught)).toBe(true);
        if (isProviderError(caught)) {
            expect(caught.type).toBe("provider");
            expect(caught.retryable).toBe(true);
        }
    });

    it("retries a doStream promise rejection and then streams the recovered deltas", async () => {
        let attempts = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(
                async () => okResult(),
                async () => {
                    attempts += 1;
                    // A rejected doStream promise is the shape a real connection
                    // failure at establishment takes; streamText defers it past a
                    // clean first pull, so the envelope surfaces it via the result
                    // promises rather than the first `textStream` pull.
                    if (attempts === 1) throw apiError503();
                    return streamResult(["a", "b"]);
                },
            ),
            resolveBilling: async () => ({}),
        });

        const events = [];
        for await (const event of provider.chatStream(request, makeSession())) events.push(event);

        expect(attempts).toBe(2);
        expect(events).toEqual([
            { type: "text-delta", text: "a" },
            { type: "text-delta", text: "b" },
            {
                type: "done",
                response: {
                    message: { role: "assistant", content: [{ type: "text", text: "ab" }] },
                    finishReason: "stop",
                    rawFinishReason: "stop",
                    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
                },
            },
        ]);
    });

    it("exhausts retries on a persistently rejecting doStream and throws the classified provider error", async () => {
        let attempts = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(
                async () => okResult(),
                async () => {
                    attempts += 1;
                    throw apiError503();
                },
            ),
            resolveBilling: async () => ({}),
        });

        let caught: unknown;
        try {
            for await (const _part of provider.chatStream(request, makeSession())) {
                // Every attempt rejects, so the body is never reached; draining
                // runs the retries to exhaustion.
            }
        } catch (e) {
            caught = e;
        }

        expect(attempts).toBe(1 + RETRY_MAX_RETRIES);
        expect(isProviderError(caught)).toBe(true);
        if (isProviderError(caught)) {
            expect(caught.type).toBe("provider");
            expect(caught.retryable).toBe(true);
        }
    });

    it("does not retry a clean text-less turn and yields only the terminal event", async () => {
        let attempts = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(
                async () => okResult(),
                async () => {
                    attempts += 1;
                    return streamWithNoText();
                },
            ),
            resolveBilling: async () => ({}),
        });

        const events = [];
        for await (const event of provider.chatStream(request, makeSession())) events.push(event);

        expect(attempts).toBe(1);
        expect(events).toHaveLength(1);
        expect(events[0]!.type).toBe("done");
    });
});

describe("retry policy constants", () => {
    // The behavioral tests above assert attempt counts self-referentially (e.g.
    // `1 + RETRY_MAX_RETRIES`), so a drifted constant would keep the whole suite
    // green while silently changing the spec'd envelope. Pin the values directly.
    it("match the specified envelope", () => {
        expect(RETRY_MAX_RETRIES).toBe(10);
        expect(RETRY_INITIAL_DELAY_MS).toBe(2_000);
        expect(RETRY_BACKOFF_FACTOR).toBe(2);
        expect(RETRY_MAX_DELAY_MS).toBe(30_000);
    });
});

describe("createAiSdkProvider billing resolution fail-fast", () => {
    // A connection-shaped failure is retryable by nature (its `retryable: true`
    // flag says so), but the billing seam is a different system from the model
    // wire: its failure must surface immediately rather than consume the retry
    // envelope. The single resolver invocation — not the flag — is the assertion.
    it("does not retry a connection-shaped billing failure and never calls the model", async () => {
        let generateCalls = 0;
        let billingInvocations = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(async () => {
                generateCalls += 1;
                return okResult();
            }),
            resolveBilling: async () => {
                billingInvocations += 1;
                throw Object.assign(new TypeError("fetch failed"), {
                    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
                });
            },
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("provider");
        expect(generateCalls).toBe(0);
        expect(billingInvocations).toBe(1);
    });

    it("classifies a billing 402 as budget after a single resolver call", async () => {
        let generateCalls = 0;
        let billingInvocations = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(async () => {
                generateCalls += 1;
                return okResult();
            }),
            resolveBilling: async () => {
                billingInvocations += 1;
                throw Object.assign(new Error("payment required"), { status: 402 });
            },
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("budget");
        expect(generateCalls).toBe(0);
        expect(billingInvocations).toBe(1);
    });

    it("fails a stream fast on a billing failure without opening the stream", async () => {
        let streamCalls = 0;
        let billingInvocations = 0;
        const provider = createAiSdkProvider({
            model: fakeModel(
                async () => okResult(),
                async () => {
                    streamCalls += 1;
                    return streamResult(["a"]);
                },
            ),
            resolveBilling: async () => {
                billingInvocations += 1;
                throw Object.assign(new TypeError("fetch failed"), {
                    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
                });
            },
        });

        let caught: unknown;
        try {
            for await (const _event of provider.chatStream(request, makeSession())) {
                // Establishment fails at billing before any event is produced.
            }
        } catch (e) {
            caught = e;
        }

        expect(isProviderError(caught)).toBe(true);
        if (isProviderError(caught)) expect(caught.type).toBe("provider");
        expect(streamCalls).toBe(0);
        expect(billingInvocations).toBe(1);
    });
});
