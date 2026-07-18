import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import "../../extensions/index.ts"; // installs Response.prototype.jsonWith, which resolveModelId + checkModelAccess use
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import {
    __resetModelCacheForTest,
    checkModelAccess,
    modelMatchesProvider,
    rankModelCandidates,
    readApiKey,
    resolveModelId,
    type ModelCandidate,
} from "./models.ts";

describe("modelMatchesProvider", () => {
    test("a resolved id whose family matches the configured provider agrees (provider→family, case-insensitive)", () => {
        expect(modelMatchesProvider("anthropic", "claude-sonnet-4-5")).toBe(true);
        expect(modelMatchesProvider("anthropic", "My-Claude-3.5")).toBe(true);
        expect(modelMatchesProvider("openai", "gpt-4o")).toBe(true);
        expect(modelMatchesProvider("google", "gemini-2.5-pro")).toBe(true);
        expect(modelMatchesProvider("qwen", "qwen-72b")).toBe(true);
    });

    test("a family from a different provider is a mismatch (the old Claude check degenerates from this)", () => {
        expect(modelMatchesProvider("anthropic", "gpt-4o")).toBe(false);
        expect(modelMatchesProvider("openai", "claude-sonnet-4-5")).toBe(false);
    });

    test("a provider absent from the table matches nothing — never derives an identity, just reports mismatch", () => {
        expect(modelMatchesProvider("deepseek", "some-alias-v2")).toBe(false);
        expect(modelMatchesProvider("deepseek", "deepseek-r1")).toBe(false);
    });
});

describe("rankModelCandidates", () => {
    test("family preference holds regardless of serving order: claude > gpt > gemini > qwen", () => {
        expect(rankModelCandidates([{ id: "gpt-4o" }, { id: "claude-sonnet" }, { id: "gemini-pro" }])[0]).toBe("claude-sonnet");
        expect(rankModelCandidates([{ id: "gemini-pro" }, { id: "gpt-4o" }])[0]).toBe("gpt-4o");
        expect(rankModelCandidates([{ id: "qwen-72b" }, { id: "gemini-pro" }])[0]).toBe("gemini-pro");
    });

    test("family match is case-insensitive and by substring", () => {
        expect(rankModelCandidates([{ id: "My-Claude-3.5" }])[0]).toBe("My-Claude-3.5");
    });

    test("recency outranks serving position within the matched family", () => {
        expect(
            rankModelCandidates([
                { id: "claude-old", created: 100 },
                { id: "claude-new", created: 200 },
            ]),
        ).toEqual(["claude-new", "claude-old"]);
    });

    test("the same set in any serving order yields the identical ranked sequence (total order)", () => {
        const set: ModelCandidate[] = [
            { id: "claude-a", created: 300 },
            { id: "claude-b", created: 200 },
            { id: "claude-c", created: 100 },
        ];
        const forward = rankModelCandidates(set);
        const shuffled = rankModelCandidates([set[2]!, set[0]!, set[1]!]);
        expect(forward).toEqual(["claude-a", "claude-b", "claude-c"]);
        expect(shuffled).toEqual(forward);
    });

    test("a missing `created` sorts oldest — after every dated sibling", () => {
        expect(rankModelCandidates([{ id: "claude-dated", created: 100 }, { id: "claude-undated" }])).toEqual(["claude-dated", "claude-undated"]);
    });

    test("ties on `created` (or both missing) break by id ascending, never as the primary sort", () => {
        expect(
            rankModelCandidates([
                { id: "claude-b", created: 100 },
                { id: "claude-a", created: 100 },
            ]),
        ).toEqual(["claude-a", "claude-b"]);
        expect(rankModelCandidates([{ id: "claude-z" }, { id: "claude-a" }])).toEqual(["claude-a", "claude-z"]);
    });

    test("no family match → the whole list, recency-sorted (not raw serving order, not byte order)", () => {
        expect(
            rankModelCandidates([
                { id: "llama-3", created: 100 },
                { id: "mistral-7b", created: 200 },
            ]),
        ).toEqual(["mistral-7b", "llama-3"]);
    });

    test("does not mutate the caller's array", () => {
        const input: ModelCandidate[] = [
            { id: "llama-b", created: 100 },
            { id: "llama-a", created: 200 },
        ];
        rankModelCandidates(input);
        expect(input.map((m) => m.id)).toEqual(["llama-b", "llama-a"]);
    });
});

// `checkModelAccess` bounds the credential check to the proxy's unbilled count_tokens route; its three
// verdicts are all EXPECTED outcomes, so the tests assert the returned union member, never a throw.
describe("checkModelAccess", () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    function stubOnce(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
        globalThis.fetch = (async (url: string, init?: RequestInit) => impl(url, init)) as unknown as typeof fetch;
    }

    function notFoundBody(modelId: string): Response {
        return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `model: ${modelId}` } }), { status: 404 });
    }

    test("a 200 → served", async () => {
        stubOnce(() => new Response("{}", { status: 200 }));
        expect(await checkModelAccess("sk-test", "claude-x")).toBe("served");
    });

    test("a 404 carrying not_found_error → not_found (the credential definitively cannot serve it)", async () => {
        stubOnce((_url, init) => notFoundBody(JSON.parse(String(init?.body)).model));
        expect(await checkModelAccess("sk-test", "claude-x")).toBe("not_found");
    });

    test("a 404 whose body is not the not_found_error shape → inconclusive (a fork that never routes count_tokens 404s everything)", async () => {
        stubOnce(() => new Response("Not Found", { status: 404 }));
        expect(await checkModelAccess("sk-test", "claude-x")).toBe("inconclusive");

        stubOnce(() => new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 404 }));
        expect(await checkModelAccess("sk-test", "claude-x")).toBe("inconclusive");
    });

    test("a 5xx → inconclusive (never a verdict on the model)", async () => {
        stubOnce(() => new Response("boom", { status: 503 }));
        expect(await checkModelAccess("sk-test", "claude-x")).toBe("inconclusive");
    });

    test("a fetch throw (timeout/network/abort) → inconclusive", async () => {
        stubOnce(() => Promise.reject(new Error("The operation was aborted")));
        expect(await checkModelAccess("sk-test", "claude-x")).toBe("inconclusive");
    });

    test("issues the count_tokens POST carrying the model in the body and a bearer token", async () => {
        // Collect into an array (not narrowable closure-assigned locals) so the property reads keep their
        // `string | null` type at the assertion sites rather than narrowing to the seed value.
        const seen: Array<{ url: string; auth: string | null; model: string }> = [];
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            seen.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), model: JSON.parse(String(init?.body)).model });
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;

        await checkModelAccess("sk-test", "claude-x");
        expect(seen).toHaveLength(1);
        expect(seen[0]!.url.endsWith("/messages/count_tokens")).toBe(true);
        expect(seen[0]!.auth).toBe("Bearer sk-test");
        expect(seen[0]!.model).toBe("claude-x");
    });
});

// `readApiKey` reads a REAL file at env.cliproxyConfigPath. Under the test preload that path is inside
// the sandbox, but the write is still guarded — a suite run without the preload would otherwise clobber
// the developer's actual proxy config (incident 2's shape exactly).
function writeProxyConfig(contents: string): void {
    assertTestSandbox(env.cliproxyConfigPath);
    mkdirSync(dirname(env.cliproxyConfigPath), { recursive: true });
    writeFileSync(env.cliproxyConfigPath, contents);
}

function removeProxyConfig(): void {
    assertTestSandbox(env.cliproxyConfigPath);
    rmSync(env.cliproxyConfigPath, { force: true });
}

describe("readApiKey", () => {
    afterEach(() => {
        removeProxyConfig();
    });

    test("extracts the first api key from the setup-generated config", async () => {
        writeProxyConfig(["api-keys:", '  - "sk-generated-at-setup"', "port: 8317", ""].join("\n"));
        const result = await readApiKey();
        expect(result._unsafeUnwrap()).toBe("sk-generated-at-setup");
    });

    test("a missing config file is `proxy_key_missing`, not a crash", async () => {
        removeProxyConfig(); // ensure absence — Bun.file().text() rejects, the impl swallows it to ""
        const result = await readApiKey();
        expect(result._unsafeUnwrapErr()).toEqual({ type: "proxy_key_missing" });
    });

    test("a config with no api-keys block is `proxy_key_missing`", async () => {
        writeProxyConfig("port: 8317\ndebug: false\n");
        expect((await readApiKey())._unsafeUnwrapErr()).toEqual({ type: "proxy_key_missing" });
    });

    test("an empty or unquoted api-keys list is `proxy_key_missing` — the key must be a quoted scalar", async () => {
        writeProxyConfig("api-keys: []\n");
        expect((await readApiKey())._unsafeUnwrapErr()).toEqual({ type: "proxy_key_missing" });

        writeProxyConfig("api-keys:\n  - sk-unquoted\n");
        expect((await readApiKey())._unsafeUnwrapErr()).toEqual({ type: "proxy_key_missing" });
    });
});

// `resolveModelId`'s failure modes are reachable only through the `/models` `fetch`, and its cache is
// process-wide by design. Swap the global rather than inject a seam: the function deliberately has no
// fetch parameter (the endpoint is env-owned, not user-overridable), and adding one for the test would
// widen a surface the design keeps closed. The election's second request shape — the `count_tokens` POST
// — is discriminated by URL in the same global stub.
describe("resolveModelId", () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        __resetModelCacheForTest();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        __resetModelCacheForTest();
    });

    /**
     * Replace `fetch` and record how many times it was called. The double cast is unavoidable: the
     * stub answers only the one call shape the error paths make, while `typeof fetch` also carries
     * the unrelated `preconnect` static.
     */
    function stubFetch(impl: () => Promise<Response>): () => number {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return impl();
        }) as unknown as typeof fetch;
        return () => calls;
    }

    function modelsResponse(ids: string[], init?: ResponseInit): Response {
        return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), init);
    }

    function served(): Response {
        return new Response("{}", { status: 200 });
    }

    function notFound(modelId: string): Response {
        return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `model: ${modelId}` } }), { status: 404 });
    }

    /**
     * Stub fetch discriminating the election's two request shapes by URL: the `/models` GET (answered
     * from `candidates`) and each `/messages/count_tokens` POST (answered by `access`, keyed by the model
     * id read from the POST body). Records both the total call count and the count_tokens subset so a test
     * can prove the walk did — or did not — validate.
     */
    function stubElection(
        candidates: ModelCandidate[],
        access: (modelId: string) => Promise<Response> | Response,
    ): { calls: () => number; validations: () => number } {
        let calls = 0;
        let validations = 0;
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            calls += 1;
            if (String(url).endsWith("/messages/count_tokens")) {
                validations += 1;
                return access(JSON.parse(String(init?.body)).model);
            }
            return new Response(JSON.stringify({ data: candidates }));
        }) as unknown as typeof fetch;
        return { calls: () => calls, validations: () => validations };
    }

    test("a dead endpoint (fetch throws) → proxy_unreachable carrying the throw's message", async () => {
        stubFetch(() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8317")));
        const result = await resolveModelId("sk-test");
        expect(result._unsafeUnwrapErr()).toEqual({ type: "proxy_unreachable", detail: "connect ECONNREFUSED 127.0.0.1:8317" });
    });

    test("a non-Error throw still yields a string detail", async () => {
        stubFetch(() => Promise.reject("socket hang up"));
        expect((await resolveModelId("sk-test"))._unsafeUnwrapErr()).toEqual({ type: "proxy_unreachable", detail: "socket hang up" });
    });

    test("a non-ok response → proxy_unreachable naming the status", async () => {
        stubFetch(() => Promise.resolve(new Response("nope", { status: 401 })));
        expect((await resolveModelId("sk-test"))._unsafeUnwrapErr()).toEqual({ type: "proxy_unreachable", detail: "HTTP 401" });
    });

    test("an empty model list → no_models", async () => {
        stubFetch(() => Promise.resolve(modelsResponse([])));
        expect((await resolveModelId("sk-test"))._unsafeUnwrapErr()).toEqual({ type: "no_models" });
    });

    test("a body that fails the schema → no_models (jsonWith yields null, never a throw)", async () => {
        stubFetch(() => Promise.resolve(new Response("not json at all")));
        expect((await resolveModelId("sk-test"))._unsafeUnwrapErr()).toEqual({ type: "no_models" });
    });

    test("the ok path elects the ranked claude id and sends the key as a bearer token on both requests", async () => {
        const seenAuth: Array<string | null> = [];
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            seenAuth.push(new Headers(init?.headers).get("Authorization"));
            return String(url).endsWith("/messages/count_tokens") ? served() : modelsResponse(["gpt-4o", "claude-sonnet"]);
        }) as unknown as typeof fetch;

        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-sonnet");
        expect(seenAuth).toEqual(["Bearer sk-test", "Bearer sk-test"]); // /models GET, then the count_tokens POST
    });

    test("the election walks past a not_found top candidate to the next served one", async () => {
        const stub = stubElection(
            [
                { id: "claude-old", created: 100 },
                { id: "claude-new", created: 200 },
            ],
            (id) => (id === "claude-new" ? notFound(id) : served()),
        );
        // Ranked newest-first: claude-new 404s, so the walk elects claude-old.
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-old");
        expect(stub.validations()).toBe(2);
    });

    test("a 5xx on the top candidate is inconclusive — it is elected, not walked past", async () => {
        const stub = stubElection(
            [
                { id: "claude-new", created: 200 },
                { id: "claude-old", created: 100 },
            ],
            (id) => (id === "claude-new" ? new Response("boom", { status: 503 }) : served()),
        );
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-new");
        expect(stub.validations()).toBe(1); // stopped at the top candidate
    });

    test("a count_tokens timeout/network throw is inconclusive — the top candidate is elected", async () => {
        stubElection(
            [
                { id: "claude-new", created: 200 },
                { id: "claude-old", created: 100 },
            ],
            () => Promise.reject(new Error("timed out")),
        );
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-new");
    });

    test("an all-404 list elects the top-ranked candidate unvalidated for downstream reporting", async () => {
        const stub = stubElection(
            [
                { id: "claude-old", created: 100 },
                { id: "claude-new", created: 200 },
            ],
            (id) => notFound(id),
        );
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-new"); // rank[0] = newest
        expect(stub.validations()).toBe(2); // both candidates walked
    });

    test("a non-claude list elects by rank alone — no count_tokens validation exists for it", async () => {
        const stub = stubElection(
            [
                { id: "gpt-4o", created: 100 },
                { id: "gpt-4o-mini", created: 200 },
            ],
            () => served(),
        );
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("gpt-4o-mini"); // recency wins
        expect(stub.validations()).toBe(0);
    });

    test("the elected winner is cached — a second resolve issues zero requests (probe and boot share one election)", async () => {
        const stub = stubElection([{ id: "claude-sonnet", created: 100 }], () => served());
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-sonnet");
        const afterFirst = stub.calls();
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-sonnet");
        expect(stub.calls()).toBe(afterFirst); // the cached path went out over the wire zero times
    });

    test("does NOT cache a failure — a transient outage must not poison the process", async () => {
        const failing = stubFetch(() => Promise.reject(new Error("down")));
        expect((await resolveModelId("sk-test")).isErr()).toBe(true);
        expect(failing()).toBe(1);

        // The error path left no cached value, so the retry really re-fetches /models and elects.
        const recovered = stubElection([{ id: "claude-sonnet", created: 100 }], () => served());
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-sonnet");
        expect(recovered.calls()).toBeGreaterThan(0);
    });
});
