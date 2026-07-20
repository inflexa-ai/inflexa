import { afterEach, describe, expect, test } from "bun:test";

import { listEmbeddingModels } from "./api_models.ts";

// The listing is a fetch + filter with no other state, so these stub globalThis.fetch and assert on the
// returned Result — no network and no endpoint is ever touched. Every failure shape is covered because
// the caller's remedy (fall back to free-text model entry) hinges on them all landing on the err channel
// rather than throwing.
describe("listEmbeddingModels", () => {
    // Captured ONCE so the per-test stub is always restored regardless of which test set it.
    const realFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    /** Stub fetch to serve `body` as JSON with `status`, recording the URL and auth header it saw. */
    function stubFetch(body: unknown, status = 200): { calls: { url: string; auth: string | null }[] } {
        const spy = { calls: [] as { url: string; auth: string | null }[] };
        // Test-only replacement of the global fetch: the cast is required because a bare recorder is
        // narrower than fetch's overloaded signature; it is sound because afterEach restores realFetch.
        globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            spy.calls.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization") });
            return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
        }) as unknown as typeof globalThis.fetch;
        return spy;
    }

    test("returns only embedding-capable ids, sorted for a stable picker order", async () => {
        stubFetch({ data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "nomic-embed-text" }, { id: "whisper-1" }] });
        const result = await listEmbeddingModels("https://api.openai.com/v1", "sk-test");
        expect(result._unsafeUnwrap()).toEqual(["nomic-embed-text", "text-embedding-3-small"]);
    });

    test("requests {baseURL}/models with a bearer key, tolerating a trailing slash", async () => {
        const spy = stubFetch({ data: [{ id: "text-embedding-3-small" }] });
        await listEmbeddingModels("https://gw.corp/v1/", "sk-abc");
        expect(spy.calls[0]!.url).toBe("https://gw.corp/v1/models");
        expect(spy.calls[0]!.auth).toBe("Bearer sk-abc");
    });

    test("a listing whose ids are all non-embedding is no_models — the free-text fallback case", async () => {
        stubFetch({ data: [{ id: "gpt-4o" }, { id: "whisper-1" }] });
        expect((await listEmbeddingModels("https://api.openai.com/v1", "sk-test"))._unsafeUnwrapErr().type).toBe("no_models");
    });

    test("an empty listing is no_models", async () => {
        stubFetch({ data: [] });
        expect((await listEmbeddingModels("https://x/v1", "k"))._unsafeUnwrapErr().type).toBe("no_models");
    });

    test("a schema-mismatched body is no_models, never a throw", async () => {
        stubFetch({ unexpected: true });
        expect((await listEmbeddingModels("https://x/v1", "k"))._unsafeUnwrapErr().type).toBe("no_models");
    });

    test("a non-2xx is http_error carrying the status", async () => {
        stubFetch({ error: "unauthorized" }, 401);
        expect((await listEmbeddingModels("https://x/v1", "k"))._unsafeUnwrapErr()).toEqual({ type: "http_error", status: 401 });
    });

    test("a dead endpoint is unreachable, never a throw", async () => {
        // A rejecting fetch is the dead-host/aborted-signal path; it must bridge into the Result channel.
        globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof globalThis.fetch;
        const e = (await listEmbeddingModels("https://x/v1", "k"))._unsafeUnwrapErr();
        expect(e.type).toBe("unreachable");
        expect(e).toMatchObject({ detail: "ECONNREFUSED" });
    });
});
