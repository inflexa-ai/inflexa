import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";

import { createEmbeddingProvider } from "./embedding.js";
import { makeSession } from "./__fixtures__/session.js";
import type { FetchLike } from "./types.js";

const hostHeaders: Record<string, string> = {
    "X-Attribution-Context": "ctx-emb",
    "X-Attribution-Key": "key-emb",
};

interface FakeEmbedding {
    object: "embedding";
    index: number;
    embedding: number[];
}

/** A `fetch` that records request headers and replays a canned embedding response. */
function fakeEmbeddingFetch(data: FakeEmbedding[]): {
    fetch: FetchLike;
    lastHeaders: () => Headers;
} {
    let captured: Headers | undefined;
    const fetchImpl: FetchLike = async (_input, init) => {
        captured = new Headers(init?.headers);
        return new Response(
            JSON.stringify({
                object: "list",
                model: "text-embedding-3-small",
                data,
                usage: { prompt_tokens: 6, total_tokens: 6 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    };
    return {
        fetch: fetchImpl,
        lastHeaders: () => {
            if (!captured) throw new Error("fetch was never called");
            return captured;
        },
    };
}

describe("createEmbeddingProvider.embed", () => {
    it("maps a fake embedding response to number[][]", async () => {
        const fake = fakeEmbeddingFetch([
            { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
            { object: "embedding", index: 1, embedding: [0.4, 0.5, 0.6] },
        ]);
        const provider = createEmbeddingProvider({
            baseURL: "http://billing.test/openai",
            token: "test-token",
            resolveRequestHeaders: () => okAsync(hostHeaders),
            fetch: fake.fetch,
        });

        const result = (await provider.embed(["alpha", "beta"], makeSession()))._unsafeUnwrap();

        expect(result).toEqual([
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
        ]);
    });

    it("re-keys out-of-order response data by index", async () => {
        const fake = fakeEmbeddingFetch([
            { object: "embedding", index: 1, embedding: [0.4, 0.5, 0.6] },
            { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
        ]);
        const provider = createEmbeddingProvider({
            baseURL: "http://billing.test/openai",
            token: "test-token",
            resolveRequestHeaders: () => okAsync(hostHeaders),
            fetch: fake.fetch,
        });

        const result = (await provider.embed(["alpha", "beta"], makeSession()))._unsafeUnwrap();

        expect(result).toEqual([
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
        ]);
    });

    it("short-circuits on empty input without a wire call", async () => {
        const fake = fakeEmbeddingFetch([]);
        const provider = createEmbeddingProvider({
            baseURL: "http://billing.test/openai",
            token: "test-token",
            resolveRequestHeaders: () => okAsync(hostHeaders),
            fetch: fake.fetch,
        });

        expect((await provider.embed([], makeSession()))._unsafeUnwrap()).toEqual([]);
        expect(() => fake.lastHeaders()).toThrow("fetch was never called");
    });

    it("adds the headers of the hook to the request as the hook gives them", async () => {
        const fake = fakeEmbeddingFetch([{ object: "embedding", index: 0, embedding: [0.1] }]);
        const provider = createEmbeddingProvider({
            baseURL: "http://gateway.test/openai",
            token: "test-token",
            resolveRequestHeaders: () => okAsync(hostHeaders),
            fetch: fake.fetch,
        });

        (await provider.embed(["alpha"], makeSession()))._unsafeUnwrap();

        expect(fake.lastHeaders().get("x-attribution-context")).toBe("ctx-emb");
        expect(fake.lastHeaders().get("x-attribution-key")).toBe("key-emb");
    });

    it("sends no request when the hook refuses, and gives the refusal as a provider error", async () => {
        const fake = fakeEmbeddingFetch([{ object: "embedding", index: 0, embedding: [0.1] }]);
        const refusing = (suspend: boolean) =>
            createEmbeddingProvider({
                baseURL: "http://gateway.test/openai",
                token: "test-token",
                resolveRequestHeaders: () => errAsync({ reason: "no_funds", suspend }),
                fetch: fake.fetch,
            });

        expect((await refusing(false).embed(["alpha"], makeSession()))._unsafeUnwrapErr()).toMatchObject({ type: "provider", retryable: false });
        expect((await refusing(true).embed(["alpha"], makeSession()))._unsafeUnwrapErr()).toMatchObject({
            type: "suspend",
            reason: "no_funds",
            retryable: false,
        });
        expect(() => fake.lastHeaders()).toThrow("fetch was never called");
    });

    it("calls the hook before each attempt", async () => {
        let fetches = 0;
        let hookCalls = 0;
        const sent: string[] = [];
        const served = fakeEmbeddingFetch([{ object: "embedding", index: 0, embedding: [0.1] }]);
        const provider = createEmbeddingProvider({
            baseURL: "http://gateway.test/openai",
            token: "test-token",
            resolveRequestHeaders: () => {
                hookCalls += 1;
                return okAsync({ "x-attempt": `attempt-${hookCalls}` });
            },
            fetch: async (input, init) => {
                fetches += 1;
                sent.push(new Headers(init?.headers).get("x-attempt") ?? "");
                if (fetches === 1) return new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 });
                return served.fetch(input, init);
            },
        });

        expect((await provider.embed(["alpha"], makeSession()))._unsafeUnwrap()).toEqual([[0.1]]);
        expect(hookCalls).toBe(2);
        expect(sent).toEqual(["attempt-1", "attempt-2"]);
    }, 10_000);

    it("never retries a status that the map of the host holds", async () => {
        let fetches = 0;
        const provider = createEmbeddingProvider({
            baseURL: "http://gateway.test/openai",
            token: "test-token",
            suspendOn: { 429: "quota_exhausted" },
            fetch: async () => {
                fetches += 1;
                return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
            },
        });

        expect((await provider.embed(["alpha"], makeSession()))._unsafeUnwrapErr()).toMatchObject({ type: "suspend", reason: "quota_exhausted" });
        expect(fetches).toBe(1);
    });
});
