import { setTimeout as sleep } from "node:timers/promises";

import { textOf } from "../../lib/unknown-text.js";
import { describe, expect, it } from "bun:test";
import { createServer, type ServerResponse } from "node:http";
import { streamText } from "ai";

import { makeSession } from "../__fixtures__/session.js";
import { createConfiguredAiSdkProvider, wrapFetchWithRequestTimeout, type AiSdkProviderConfig } from "../ai-sdk.js";
import { findProviderError, type ProviderError } from "../errors.js";
import type { ChatProvider } from "../types.js";
import { presentAt } from "../../lib/present.js";

/** A `fetch` test double: the callable plus the `preconnect` member that `typeof fetch` carries. */
function fetchDouble(run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

/** What a reader of one model call saw. */
type Outcome = {
    readonly deltas: readonly string[];
    readonly text: string;
    /** The first failure that the call reported, as the AI SDK gave it. */
    readonly failure: unknown;
    readonly aborted: boolean;
};

/** Run one model call over the bound model of `provider`, the same way the loop runs each request. */
async function drive(provider: ChatProvider, call: { readonly live?: boolean; readonly signal?: AbortSignal } = {}): Promise<Outcome> {
    const bound = provider.bind({ session: makeSession(), live: call.live ?? false });
    let failure: unknown;
    const result = streamText({
        model: bound.model,
        ...bound.settings,
        maxRetries: 0,
        instructions: "You are a test model.",
        messages: [{ role: "user", content: "hello" }],
        abortSignal: call.signal,
        onError: ({ error }) => {
            failure ??= error;
        },
    });
    const deltas: string[] = [];
    let aborted = false;
    for await (const part of result.stream) {
        if (part.type === "text-delta") deltas.push(part.text);
        else if (part.type === "abort") aborted = true;
    }
    return { deltas, text: deltas.join(""), failure, aborted };
}

/** The classified failure of a call that the retry envelope gave up on. */
function providerErrorOf(outcome: Outcome): ProviderError {
    const error = findProviderError(outcome.failure);
    if (error === undefined) throw new Error(`expected a provider error, got ${textOf(outcome.failure)}`, { cause: outcome.failure });
    return error;
}

/** A minimal OpenAI-compatible completion stream that the SDK parses to `"ok"`. */
const OK_COMPLETION = [
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
].join("");

/** Build an OpenAI-compatible config over a fake fetch, with the guard fields set per test. */
function openAiConfig(fetch: typeof globalThis.fetch, opts: { requestTimeoutMs?: number; maxRetries?: number } = {}): AiSdkProviderConfig {
    return {
        kind: "openai-compatible",
        name: "test",
        baseURL: "http://models.local/v1",
        apiKey: "test-key",
        model: "local-model",
        fetch,
        requestTimeoutMs: opts.requestTimeoutMs,
        maxRetries: opts.maxRetries,
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
function fetchThatNeverStarts(onCall?: () => void): typeof fetch {
    return fetchDouble((_input, init) => {
        onCall?.();
        return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal === null || signal === undefined) return;
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the abort reason rides as-is; the awaiter classifies the abort by its name.
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener("abort", () => {
                // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the abort reason rides as-is; the awaiter classifies the abort by its name.
                reject(signal.reason);
            });
        });
    });
}

/**
 * A fetch that returns its headers at once, then streams `body` in `chunks`
 * equal pieces with `gapMs` between each. It models a steady stream. It errors
 * the body when its signal aborts.
 */
function fetchWithSteadyBody(body: string, chunks: number, gapMs: number): typeof fetch {
    return fetchDouble((_input, init) => {
        const abortSignal = init?.signal ?? undefined;
        const encoded = new TextEncoder().encode(body);
        const size = Math.ceil(encoded.length / chunks);
        let offset = 0;
        const stream = new ReadableStream<Uint8Array>({
            start: async (controller) => {
                for (;;) {
                    if (abortSignal?.aborted) return controller.error(abortSignal.reason);
                    if (offset >= encoded.length) return controller.close();
                    try {
                        // The wait rejects on abort, which ends the loop and lets node unschedule
                        // the timer — the cleanup the clearTimeout listener used to do.
                        await sleep(gapMs, undefined, { signal: abortSignal });
                    } catch {
                        if (abortSignal === undefined) throw new Error("the gap wait rejected with no signal to blame");
                        return controller.error(abortSignal.reason);
                    }
                    controller.enqueue(encoded.slice(offset, offset + size));
                    offset += size;
                }
            },
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    });
}

describe("request-timeout guard", () => {
    it("trips on a slow response start and classifies as a retryable provider timeout", async () => {
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetchThatNeverStarts(), { requestTimeoutMs: 30, maxRetries: 0 }),
        });

        const failure = providerErrorOf(await drive(provider));

        expect(failure.type).toBe("provider");
        expect(failure.retryable).toBe(true);
        expect(failure.message).toContain("30");
    });

    it("does not cut a body that outlives the window, because the guard clears at the headers", async () => {
        // Five chunks, 15 ms apart, run to about 75 ms — longer than the 60 ms
        // window. The headers arrive at once, thus no guard timer survives to cut
        // the body, whatever its total length.
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetchWithSteadyBody(OK_COMPLETION, 5, 15), { requestTimeoutMs: 60, maxRetries: 0 }),
        });

        const outcome = await drive(provider);

        expect(outcome.failure).toBeUndefined();
        expect(outcome.text).toBe("ok");
    });

    it("keeps a caller abort a cancellation rather than a timeout", async () => {
        const provider = createConfiguredAiSdkProvider({
            // A large window makes the caller abort, not the guard, the only thing
            // that ends the stalled request.
            config: openAiConfig(fetchThatNeverStarts(), { requestTimeoutMs: 500 }),
        });

        const controller = new AbortController();

        // The abort lands once the call holds the stalled fetch, so the caller signal, not the guard, ends it.
        const pending = drive(provider, { signal: controller.signal });
        await sleep(20);
        controller.abort();
        const outcome = await pending;

        expect(outcome.aborted).toBe(true);
        expect(outcome.failure).toBeUndefined();
    });

    it("retries a guard expiry with a fresh window and succeeds on the next attempt", async () => {
        let calls = 0;
        const fetch = fetchDouble((input, init) => {
            calls += 1;
            if (calls === 1) return fetchThatNeverStarts()(input, init);
            return Promise.resolve(sseResponse(OK_COMPLETION));
        });
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetch, { requestTimeoutMs: 30 }),
        });

        const outcome = await drive(provider);

        expect(calls).toBe(2);
        expect(outcome.failure).toBeUndefined();
        expect(outcome.text).toBe("ok");
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
        });

        const failure = providerErrorOf(await drive(provider));

        expect(calls).toBe(2);
        expect(failure.type).toBe("provider");
        expect(failure.retryable).toBe(true);
        expect(failure.message).toContain("20");
    }, 10_000);

    it("leaves no guard timer alive once the headers arrive", async () => {
        // Instrument the global timer so the test asserts on the live guard-timer
        // set as state, not on a call count. The wrapper arms and clears through
        // these globals, thus the set reflects the guard timer directly.
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        const live = new Set<ReturnType<typeof setTimeout>>();
        let lastArmed: ReturnType<typeof setTimeout> | undefined;
        // The trap keeps the exact `typeof setTimeout` of the real timer; a plain
        // wrapper arrow cannot carry the timer interface's extra members.
        globalThis.setTimeout = new Proxy(realSetTimeout, {
            apply(target: typeof setTimeout, thisArg: unknown, args: Parameters<typeof setTimeout>) {
                const handle = target.apply(thisArg, args);
                live.add(handle);
                lastArmed = handle;
                return handle;
            },
        });
        globalThis.clearTimeout = new Proxy(realClearTimeout, {
            apply(target: typeof clearTimeout, thisArg: unknown, [handle]: [handle?: ReturnType<typeof setTimeout>]) {
                if (handle !== undefined) live.delete(handle);
                return target.apply(thisArg, [handle]);
            },
        });

        try {
            // A body that never ends and ignores its signal. The SDK bound owns each
            // gap of such a body, thus the guard must hold no timer for it.
            const headersThenStall = fetchDouble(() => {
                const body = new ReadableStream<Uint8Array>({
                    pull() {
                        return new Promise<void>(() => {});
                    },
                });
                return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
            });

            const wrapped = wrapFetchWithRequestTimeout(headersThenStall, 10_000);
            const caller = new AbortController();
            const response = await wrapped("http://models.local/v1", { signal: caller.signal });

            const guardTimer = lastArmed;
            if (guardTimer === undefined) throw new Error("expected the guard to arm a timer");
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
        const wrapped = wrapFetchWithRequestTimeout(
            fetchDouble(() => Promise.resolve(source)),
            10_000,
        );

        const response = await wrapped("http://models.local/v1");

        expect(response).toBe(source);
        expect(await response.text()).toBe("payload");
    });
});

describe("request-timeout transport lift", () => {
    it("adds `timeout: false` to the forwarded init", async () => {
        const inits: (RequestInit | undefined)[] = [];
        const wrapped = wrapFetchWithRequestTimeout(
            fetchDouble((_input, init) => {
                inits.push(init);
                return Promise.resolve(sseResponse(OK_COMPLETION));
            }),
            10_000,
        );

        await wrapped("http://models.local/v1", { method: "POST" });

        const forwarded = inits[0];
        if (forwarded === undefined || !("timeout" in forwarded)) throw new Error("expected the forwarded init to carry the timeout key");
        expect(forwarded.timeout).toBe(false);
        expect(forwarded.method).toBe("POST");
        expect(forwarded.signal).toBeDefined();
    });

    it("adds no `timeout` key when the field is absent", async () => {
        const inits: (RequestInit | undefined)[] = [];
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(
                fetchDouble((_input, init) => {
                    inits.push(init);
                    return Promise.resolve(sseResponse(OK_COMPLETION));
                }),
            ),
        });

        const outcome = await drive(provider);

        expect(outcome.failure).toBeUndefined();
        expect(inits).toHaveLength(1);
        const forwarded = inits[0];
        if (forwarded === undefined) throw new Error("expected one forwarded init");
        expect(Object.hasOwn(forwarded, "timeout")).toBe(false);
    });
});

describe("request-timeout advertisement", () => {
    it("advertises the configured value on the provider instance", () => {
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetchThatNeverStarts(), { requestTimeoutMs: 1234 }),
        });

        expect(provider.requestTimeoutMs).toBe(1234);
    });

    it("installs no wrapper and advertises no value when the field is absent", async () => {
        const provider = createConfiguredAiSdkProvider({
            config: openAiConfig(fetchThatNeverStarts()),
        });

        expect(provider.requestTimeoutMs).toBeUndefined();

        // With no guard installed, only the caller abort ends the stalled request,
        // thus the failure is a cancellation, never a request-timeout.
        const controller = new AbortController();

        const pending = drive(provider, { signal: controller.signal });
        await sleep(20);
        controller.abort();
        const outcome = await pending;

        expect(outcome.aborted).toBe(true);
        expect(outcome.failure).toBeUndefined();
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
                res.write(presentAt(chunks, index));
                index += 1;
                // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the emitter re-arms its own next write, unref'd so the fake endpoint never holds the process; a wait cannot re-arm itself here.
                setTimeout(push, gapMs).unref();
                return;
            }
            if (end) res.end();
        };
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the emitter re-arms its own next write, unref'd so the fake endpoint never holds the process; a wait cannot re-arm itself here.
        setTimeout(push, gapMs).unref();
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
    });
}

describe("the stream gap bound", () => {
    it("trips on the gap after the content stops, and not before", async () => {
        // Four deltas, 60 ms apart, run to about 240 ms — longer than the 150 ms
        // bound — and each one reaches the consumer. Thus the response-start guard
        // cleared at the headers, and the retry envelope owns each gap. The silence
        // after the last delta then passes the bound, and the turn ends with an
        // error.
        const deltas = ["a", "b", "c", "d"].map(sseDelta);
        const endpoint = await startFakeStreamEndpoint(emitEvery(deltas, 60, false));
        try {
            const outcome = await drive(providerOver(endpoint.baseURL, 150), { live: true });

            expect(outcome.deltas).toEqual(["a", "b", "c", "d"]);
            const failure = providerErrorOf(outcome);
            expect(failure.type).toBe("provider");
            expect(failure.retryable).toBe(true);
            expect(failure.message).toContain("150");
        } finally {
            await endpoint.close();
        }
    });

    it("bounds each gap of a buffered call too, inside its attempt", async () => {
        const deltas = ["a", "b"].map(sseDelta);
        const endpoint = await startFakeStreamEndpoint(emitEvery(deltas, 40, false));
        try {
            const outcome = await drive(providerOver(endpoint.baseURL, 150), { live: false });

            // A buffered call shows the reader nothing of an attempt that failed.
            expect(outcome.deltas).toEqual([]);
            expect(providerErrorOf(outcome).message).toContain("150");
        } finally {
            await endpoint.close();
        }
    });

    it("trips when a stalled stream sends no content at all", async () => {
        const endpoint = await startFakeStreamEndpoint(emitEvery([], 20, false));
        try {
            const outcome = await drive(providerOver(endpoint.baseURL, 150), { live: true });

            expect(outcome.deltas).toEqual([]);
            const failure = providerErrorOf(outcome);
            expect(failure.retryable).toBe(true);
            expect(failure.message).toContain("150");
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
            const outcome = await drive(providerOver(endpoint.baseURL, 150), { live: true });

            expect(outcome.deltas).toEqual(["a"]);
            expect(providerErrorOf(outcome).message).toContain("150");
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
            const outcome = await drive(providerOver(endpoint.baseURL, 150), { live: true });

            expect(outcome.failure).toBeUndefined();
            expect(outcome.text).toBe("abcdefgh");
        } finally {
            await endpoint.close();
        }
    }, 10_000);

    it("keeps a caller abort a cancellation rather than a timeout", async () => {
        // A bound of 5 s cannot fire inside this test, thus only the caller abort
        // ends the stalled stream.
        const endpoint = await startFakeStreamEndpoint(emitEvery([sseDelta("a")], 20, false));
        const controller = new AbortController();
        try {
            // The stream sends one delta at 20 ms and then stays open, so the abort at 120 ms lands while the stream flows.
            const pending = drive(providerOver(endpoint.baseURL, 5_000), { live: true, signal: controller.signal });
            await sleep(120);
            controller.abort();
            const outcome = await pending;

            expect(outcome.deltas).toEqual(["a"]);
            expect(outcome.aborted).toBe(true);
            expect(outcome.failure).toBeUndefined();
        } finally {
            await endpoint.close();
        }
    });
});
