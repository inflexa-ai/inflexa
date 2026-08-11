import { describe, expect, it } from "bun:test";

import { makeSession } from "./__fixtures__/session.js";
import { createConfiguredAiSdkProvider, type AiSdkProviderConfig } from "./ai-sdk.js";
import type { ChatRequest, FetchLike } from "./types.js";

const request: ChatRequest = {
    system: "You are a test model.",
    messages: [{ role: "user", content: "hello" }],
    tools: {},
};

/** A minimal OpenAI-compatible chat completion that the SDK parses to `"ok"`. */
const OK_COMPLETION = JSON.stringify({
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
});

/** Build an OpenAI-compatible config over a fake fetch, with the guard fields set per test. */
function openAiConfig(fetch: FetchLike, opts: { requestTimeoutMs?: number; maxRetries?: number } = {}): AiSdkProviderConfig {
    return {
        kind: "openai-compatible",
        name: "test",
        baseURL: "http://models.local/v1",
        apiKey: "test-key",
        model: "local-model",
        fetch,
        ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    };
}

/** A JSON response with headers ready at once. */
function jsonResponse(body: string): Response {
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * A fetch that never starts its response. It settles only when its signal
 * aborts, and then it rejects with the abort reason, the same as a real fetch.
 * It models a server that holds the connection before the response headers.
 */
function fetchThatNeverStarts(onCall?: () => void): FetchLike {
    return (_input, init) => {
        onCall?.();
        return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal === null || signal === undefined) return;
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    };
}

/**
 * A fetch that returns its headers at once, then a body that emits no chunk and
 * errors when its signal aborts. It models a stream that stalls after the start.
 */
function fetchWithStalledBody(): FetchLike {
    return (_input, init) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                if (signal === null || signal === undefined) return;
                if (signal.aborted) return controller.error(signal.reason);
                signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
            },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    };
}

/**
 * A fetch that returns its headers at once, then streams `body` in `chunks`
 * equal pieces with `gapMs` between each. It models a steady stream. It errors
 * the body when its signal aborts.
 */
function fetchWithSteadyBody(body: string, chunks: number, gapMs: number): FetchLike {
    return (_input, init) => {
        const signal = init?.signal;
        const encoded = new TextEncoder().encode(body);
        const size = Math.ceil(encoded.length / chunks);
        let offset = 0;
        let timer: ReturnType<typeof setTimeout>;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const push = (): void => {
                    if (signal?.aborted) return controller.error(signal.reason);
                    if (offset >= encoded.length) return controller.close();
                    controller.enqueue(encoded.slice(offset, offset + size));
                    offset += size;
                    timer = setTimeout(push, gapMs);
                };
                timer = setTimeout(push, gapMs);
                signal?.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        controller.error(signal.reason);
                    },
                    { once: true },
                );
            },
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    };
}

describe("request-timeout guard", () => {
    it("trips on a slow response start and classifies as a retryable provider timeout", async () => {
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetchThatNeverStarts(), { requestTimeoutMs: 30, maxRetries: 0 }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("provider");
            expect(result.error.retryable).toBe(true);
            expect(result.error.message).toContain("30");
        }
    });

    it("trips on a stalled body after the headers arrive", async () => {
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetchWithStalledBody(), { requestTimeoutMs: 30, maxRetries: 0 }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("provider");
            expect(result.error.retryable).toBe(true);
            expect(result.error.message).toContain("30");
        }
    });

    it("does not trip on a steady stream that runs longer than the window", async () => {
        // Five chunks, 15 ms apart, run to about 75 ms — longer than the 60 ms
        // window — but each chunk gap stays under it, thus the guard never trips.
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetchWithSteadyBody(OK_COMPLETION, 5, 15), { requestTimeoutMs: 60, maxRetries: 0 }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        if (result.isOk()) expect(result.value.message).toEqual({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    });

    it("keeps a caller abort a cancellation rather than a timeout", async () => {
        const provider = createConfiguredAiSdkProvider({
            // A large window makes the caller abort, not the guard, the only thing
            // that ends the stalled request.
            config: openAiConfig(fetchThatNeverStarts(), { requestTimeoutMs: 500 }),
            resolveBilling: async () => ({}),
        });

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);

        try {
            const outcome = await provider.chat(request, makeSession(), controller.signal);
            throw new Error(`expected the caller abort to reject the call, got a ${outcome.isOk() ? "ok" : "err"} result`);
        } catch (err) {
            expect(err).toBeInstanceOf(DOMException);
            expect((err as DOMException).name).toBe("AbortError");
        }
    });

    it("retries a guard expiry with a fresh window and succeeds on the next attempt", async () => {
        let calls = 0;
        const fetch: FetchLike = (input, init) => {
            calls += 1;
            if (calls === 1) return fetchThatNeverStarts()(input, init);
            return Promise.resolve(jsonResponse(OK_COMPLETION));
        };
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetch, { requestTimeoutMs: 30 }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(calls).toBe(2);
        expect(result.isOk()).toBe(true);
        if (result.isOk()) expect(result.value.message).toEqual({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    }, 10_000);

    it("bounds the guard retries by the configured maxRetries and names the value on exhaustion", async () => {
        let calls = 0;
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(
                fetchThatNeverStarts(() => {
                    calls += 1;
                }),
                { requestTimeoutMs: 20, maxRetries: 1 },
            ),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(calls).toBe(2);
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("provider");
            expect(result.error.retryable).toBe(true);
            expect(result.error.message).toContain("20");
        }
    }, 10_000);
});

describe("request-timeout advertisement", () => {
    it("advertises the configured value on the provider instance", () => {
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetchThatNeverStarts(), { requestTimeoutMs: 1234 }),
            resolveBilling: async () => ({}),
        });

        expect(provider.requestTimeoutMs).toBe(1234);
    });

    it("installs no wrapper and advertises no value when the field is absent", async () => {
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetchThatNeverStarts()),
            resolveBilling: async () => ({}),
        });

        expect(provider.requestTimeoutMs).toBeUndefined();

        // With no guard installed, only the caller abort ends the stalled request,
        // thus the failure is a cancellation, never a request-timeout.
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 40);

        try {
            const outcome = await provider.chat(request, makeSession(), controller.signal);
            throw new Error(`expected the caller abort to reject the call, got a ${outcome.isOk() ? "ok" : "err"} result`);
        } catch (err) {
            expect(err).toBeInstanceOf(DOMException);
            expect((err as DOMException).name).toBe("AbortError");
        }
    });
});
