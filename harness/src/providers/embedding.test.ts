import { describe, expect, it } from "bun:test";

import { createEmbeddingProvider } from "./embedding.js";
import { makeSession } from "./__fixtures__/session.js";
import type { FetchLike } from "./types.js";

const billingMap: Record<string, string> = {
    "X-Billing-Context": "billing-ctx-emb",
    "X-Billing-Virtual-Key": "sk-billing-emb-key",
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
            resolveBilling: async () => billingMap,
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
            resolveBilling: async () => billingMap,
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
            resolveBilling: async () => billingMap,
            fetch: fake.fetch,
        });

        expect((await provider.embed([], makeSession()))._unsafeUnwrap()).toEqual([]);
        expect(() => fake.lastHeaders()).toThrow("fetch was never called");
    });
});
