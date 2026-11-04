import { afterEach, describe, expect, test } from "bun:test";

import { fakeFetch, fetchInputUrl } from "../../../test_support/fake_fetch.ts";
import { listEmbeddingModels } from "../api_models.ts";
import { present } from "../../../lib/present.ts";
import { awaitOk } from "../../../test_support/result.ts";

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
        const spy: { calls: { url: string; auth: string | null }[] } = { calls: [] };
        // Test-only replacement of the global fetch; afterEach restores realFetch.
        globalThis.fetch = fakeFetch((input, init) => {
            spy.calls.push({ url: fetchInputUrl(input), auth: new Headers(init?.headers).get("Authorization") });
            return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
        });
        return spy;
    }

    test("returns only embedding-capable ids, sorted for a stable picker order", async () => {
        stubFetch({ data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "nomic-embed-text" }, { id: "whisper-1" }] });
        const result = await listEmbeddingModels("https://api.openai.com/v1", "sk-test");
        expect(result._unsafeUnwrap()).toEqual(["nomic-embed-text", "text-embedding-3-small"]);
    });

    test("requests {baseURL}/models with a bearer key, tolerating a trailing slash", async () => {
        const spy = stubFetch({ data: [{ id: "text-embedding-3-small" }] });
        await awaitOk(listEmbeddingModels("https://gw.corp/v1/", "sk-abc"));
        expect(present(spy.calls[0]).url).toBe("https://gw.corp/v1/models");
        expect(present(spy.calls[0]).auth).toBe("Bearer sk-abc");
    });

    test("plain-http loopback endpoints are accepted so the fetch runs (ollama, llama.cpp server)", async () => {
        const spy = stubFetch({ data: [{ id: "nomic-embed-text" }] });
        expect((await listEmbeddingModels("http://localhost:11434/v1", "k"))._unsafeUnwrap()).toEqual(["nomic-embed-text"]);
        expect((await listEmbeddingModels("http://127.0.0.1:8080", "k"))._unsafeUnwrap()).toEqual(["nomic-embed-text"]);
        expect(spy.calls.map((c) => c.url)).toEqual(["http://localhost:11434/v1/models", "http://127.0.0.1:8080/models"]);
    });

    test("cleartext http to a non-loopback host is invalid_url and the key never leaves — fetch is not called", async () => {
        const spy = stubFetch({ data: [{ id: "text-embedding-3-small" }] });
        expect((await listEmbeddingModels("http://gw.corp/v1", "sk-secret"))._unsafeUnwrapErr().type).toBe("invalid_url");
        expect(spy.calls).toHaveLength(0);
    });

    test("a non-http(s) protocol is invalid_url and fetch is not called", async () => {
        const spy = stubFetch({ data: [{ id: "text-embedding-3-small" }] });
        expect((await listEmbeddingModels("ftp://x/v1", "k"))._unsafeUnwrapErr().type).toBe("invalid_url");
        expect(spy.calls).toHaveLength(0);
    });

    test("an unparseable URL is invalid_url and fetch is not called", async () => {
        const spy = stubFetch({ data: [{ id: "text-embedding-3-small" }] });
        expect((await listEmbeddingModels("not a url", "k"))._unsafeUnwrapErr().type).toBe("invalid_url");
        expect(spy.calls).toHaveLength(0);
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
        globalThis.fetch = fakeFetch(() => Promise.reject(new Error("ECONNREFUSED")));
        const e = (await listEmbeddingModels("https://x/v1", "k"))._unsafeUnwrapErr();
        expect(e.type).toBe("unreachable");
        expect(e).toMatchObject({ detail: "ECONNREFUSED" });
    });
});
