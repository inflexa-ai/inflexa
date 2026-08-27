import { describe, expect, it } from "bun:test";
import { createServer, type ServerResponse } from "node:http";

import { makeSession } from "./__fixtures__/session.js";
import { createConfiguredAiSdkProvider, wrapFetchWithRequestTimeout, type AiSdkProviderConfig } from "./ai-sdk.js";
import { isProviderError } from "./errors.js";
import type { ChatRequest, ChatStreamEvent, FetchLike } from "./types.js";

const request: ChatRequest = {
    system: "You are a test model.",
    messages: [{ role: "user", content: "hello" }],
    tools: {},
};

/** A minimal OpenAI-compatible completion stream that the SDK parses to `"ok"`. */
const OK_COMPLETION = [
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
].join("");

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

/** An event-stream response with headers ready at once. */
function sseResponse(body: string): Response {
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
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
        return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
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

    it("does not cut a body that outlives the window, because the guard clears at the headers", async () => {
        // Five chunks, 15 ms apart, run to about 75 ms — longer than the 60 ms
        // window. The headers arrive at once, thus no guard timer survives to cut
        // the body, whatever its total length.
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
            return Promise.resolve(sseResponse(OK_COMPLETION));
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

    it("leaves no guard timer alive once the headers arrive", async () => {
        // Instrument the global timer so the test asserts on the live guard-timer
        // set as state, not on a call count. The wrapper arms and clears through
        // these globals, thus the set reflects the guard timer directly.
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        const live = new Set<ReturnType<typeof setTimeout>>();
        let lastArmed: ReturnType<typeof setTimeout> | undefined;
        globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
            const handle = realSetTimeout(...args);
            live.add(handle);
            lastArmed = handle;
            return handle;
        }) as typeof globalThis.setTimeout;
        globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
            if (handle !== undefined) live.delete(handle);
            realClearTimeout(handle);
        }) as typeof globalThis.clearTimeout;

        try {
            // A body that never ends and ignores its signal. The SDK bound owns each
            // gap of such a body, thus the guard must hold no timer for it.
            const headersThenStall: FetchLike = () => {
                const body = new ReadableStream<Uint8Array>({
                    pull() {
                        return new Promise<void>(() => {});
                    },
                });
                return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
            };

            const wrapped = wrapFetchWithRequestTimeout(headersThenStall, 10_000);
            const caller = new AbortController();
            const response = await wrapped("http://models.local/v1", { signal: caller.signal });

            expect(lastArmed).toBeDefined();
            const guardTimer = lastArmed as ReturnType<typeof setTimeout>;
            // The fetch promise settled at the headers, thus the one armed timer
            // left the live set and cannot reach a late, pointless expiry.
            expect(live.has(guardTimer)).toBe(false);

            caller.abort(new DOMException("caller cancelled", "AbortError"));
            expect(live.size).toBe(0);

            await response.body?.cancel();
        } finally {
            for (const handle of live) realClearTimeout(handle);
            globalThis.setTimeout = realSetTimeout;
            globalThis.clearTimeout = realClearTimeout;
        }
    });

    it("returns the response of the wrapped fetch untouched", async () => {
        // The guard forwards the body of the transport as it is. A wrapper around
        // the body was the source of the timer-leak class of defect.
        const source = new Response("payload", { status: 201, statusText: "Created", headers: { "content-type": "text/plain" } });
        const wrapped = wrapFetchWithRequestTimeout(() => Promise.resolve(source), 10_000);

        const response = await wrapped("http://models.local/v1");

        expect(response).toBe(source);
        expect(await response.text()).toBe("payload");
    });
});

describe("request-timeout transport lift", () => {
    it("adds `timeout: false` to the forwarded init", async () => {
        const inits: (RequestInit | undefined)[] = [];
        const wrapped = wrapFetchWithRequestTimeout((_input, init) => {
            inits.push(init);
            return Promise.resolve(sseResponse(OK_COMPLETION));
        }, 10_000);

        await wrapped("http://models.local/v1", { method: "POST" });

        const forwarded = inits[0] as (RequestInit & { timeout?: unknown }) | undefined;
        expect(forwarded?.timeout).toBe(false);
        expect(forwarded?.method).toBe("POST");
        expect(forwarded?.signal).toBeDefined();
    });

    it("adds no `timeout` key when the field is absent", async () => {
        const inits: (RequestInit | undefined)[] = [];
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig((_input, init) => {
                inits.push(init);
                return Promise.resolve(sseResponse(OK_COMPLETION));
            }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(inits).toHaveLength(1);
        expect(Object.hasOwn(inits[0] as object, "timeout")).toBe(false);
    });
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

/** One OpenAI-compatible completion chunk that carries `content` as its delta. */
function sseDelta(content: string): string {
    const chunk = {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "local-model",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** The terminal chunk of a completion, and the end marker of the event stream. */
const SSE_END = `data: ${JSON.stringify({
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "local-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
})}\n\ndata: [DONE]\n\n`;

/** A keep-alive comment. It carries no content, thus it produces no stream part. */
const SSE_KEEP_ALIVE = ": keep-alive\n\n";

/**
 * Start a fake OpenAI-compatible endpoint that streams its response.
 *
 * The handler flushes the headers at once, thus the response-start guard clears
 * and the SDK chunk bound owns each later gap. `emit` then writes the event
 * stream on its own schedule, thus a test controls each gap. The server listens
 * on an ephemeral port of the loopback interface.
 */
async function startFakeStreamEndpoint(emit: (res: ServerResponse) => void): Promise<{ readonly baseURL: string; close(): Promise<void> }> {
    const server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.flushHeaders();
        emit(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address for the fake endpoint");
    return {
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/**
 * Write `chunks` with `gapMs` between each. When `end` is true, the response
 * closes after the last chunk. Otherwise the response stays open and silent,
 * which models a stalled stream.
 */
function emitEvery(chunks: readonly string[], gapMs: number, end: boolean): (res: ServerResponse) => void {
    return (res) => {
        let index = 0;
        const push = (): void => {
            if (res.writableEnded || res.destroyed) return;
            if (index < chunks.length) {
                res.write(chunks[index]!);
                index += 1;
                setTimeout(push, gapMs).unref?.();
                return;
            }
            if (end) res.end();
        };
        setTimeout(push, gapMs).unref?.();
    };
}

/** Build a provider over the fake endpoint, with the real global fetch under it. */
function providerOver(baseURL: string, requestTimeoutMs: number) {
    return createConfiguredAiSdkProvider({
        config: {
            kind: "openai-compatible",
            name: "test",
            baseURL,
            apiKey: "test-key",
            model: "local-model",
            requestTimeoutMs,
            maxRetries: 0,
        },
        resolveBilling: async () => ({}),
    });
}

/** Drain a chat stream into its events and the failure that ended it, if any. */
async function drain(stream: AsyncIterable<ChatStreamEvent>): Promise<{ readonly events: ChatStreamEvent[]; readonly failure: unknown }> {
    const events: ChatStreamEvent[] = [];
    try {
        for await (const event of stream) events.push(event);
    } catch (e) {
        return { events, failure: e };
    }
    return { events, failure: undefined };
}

describe("SDK chunk bound", () => {
    it("trips on the gap after the content stops, and not before", async () => {
        // Four deltas, 60 ms apart, run to about 240 ms — longer than the 150 ms
        // bound — and each one reaches the consumer. Thus the response-start guard
        // cleared at the headers, and the SDK bound owns each gap. The silence
        // after the last delta then passes the bound, and the turn ends with an
        // error.
        const deltas = ["a", "b", "c", "d"].map(sseDelta);
        const endpoint = await startFakeStreamEndpoint(emitEvery(deltas, 60, false));
        try {
            const { events, failure } = await drain(providerOver(endpoint.baseURL, 150).chatStream(request, makeSession()));

            expect(events).toEqual([
                { type: "text-delta", text: "a" },
                { type: "text-delta", text: "b" },
                { type: "text-delta", text: "c" },
                { type: "text-delta", text: "d" },
            ]);
            expect(isProviderError(failure)).toBe(true);
            if (isProviderError(failure)) {
                expect(failure.type).toBe("provider");
                expect(failure.retryable).toBe(true);
                expect(failure.message).toContain("150");
            }
        } finally {
            await endpoint.close();
        }
    });

    it("trips when a stalled stream sends no content at all", async () => {
        const endpoint = await startFakeStreamEndpoint(emitEvery([], 20, false));
        try {
            const { events, failure } = await drain(providerOver(endpoint.baseURL, 150).chatStream(request, makeSession()));

            expect(events).toEqual([]);
            expect(isProviderError(failure)).toBe(true);
            if (isProviderError(failure)) {
                expect(failure.retryable).toBe(true);
                expect(failure.message).toContain("150");
            }
        } finally {
            await endpoint.close();
        }
    });

    it("does not reset the bound on a keep-alive comment", async () => {
        // One delta, then a keep-alive every 40 ms. A keep-alive carries no
        // content, thus it produces no stream part and it feeds no gap bound.
        const keepAlives = Array.from({ length: 20 }, () => SSE_KEEP_ALIVE);
        const endpoint = await startFakeStreamEndpoint(emitEvery([sseDelta("a"), ...keepAlives], 40, true));
        try {
            const { events, failure } = await drain(providerOver(endpoint.baseURL, 150).chatStream(request, makeSession()));

            expect(events).toEqual([{ type: "text-delta", text: "a" }]);
            expect(isProviderError(failure)).toBe(true);
            if (isProviderError(failure)) expect(failure.message).toContain("150");
        } finally {
            await endpoint.close();
        }
    });

    it("does not trip on a steady stream that runs longer than the bound", async () => {
        // Eight content chunks, 40 ms apart, run to about 320 ms — longer than the
        // 150 ms bound — but each gap stays under it, thus the stream completes.
        const deltas = ["a", "b", "c", "d", "e", "f", "g", "h"].map(sseDelta);
        const endpoint = await startFakeStreamEndpoint(emitEvery([...deltas, SSE_END], 40, true));
        try {
            const { events, failure } = await drain(providerOver(endpoint.baseURL, 150).chatStream(request, makeSession()));

            expect(failure).toBeUndefined();
            const done = events.at(-1);
            if (done?.type !== "done") throw new Error(`expected a terminal done event, got ${done?.type}`);
            expect(done.response.message).toEqual({ role: "assistant", content: [{ type: "text", text: "abcdefgh" }] });
        } finally {
            await endpoint.close();
        }
    }, 10_000);

    it("keeps a caller abort a cancellation rather than a timeout", async () => {
        // A bound of 5 s cannot fire inside this test, thus only the caller abort
        // ends the stalled stream.
        const endpoint = await startFakeStreamEndpoint(emitEvery([sseDelta("a")], 20, false));
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 120);
        try {
            const { events, failure } = await drain(providerOver(endpoint.baseURL, 5_000).chatStream(request, makeSession(), controller.signal));

            expect(events).toEqual([{ type: "text-delta", text: "a" }]);
            expect(isProviderError(failure)).toBe(false);
            expect(failure).toBeInstanceOf(DOMException);
            expect((failure as DOMException).name).toBe("AbortError");
        } finally {
            await endpoint.close();
        }
    });
});
