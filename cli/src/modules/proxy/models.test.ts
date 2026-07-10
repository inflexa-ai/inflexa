import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import "../../extensions/index.ts"; // installs Response.prototype.jsonWith, which resolveModelId uses
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { __resetModelCacheForTest, modelMatchesProvider, pickDefaultModel, readApiKey, resolveModelId } from "./models.ts";

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

describe("pickDefaultModel", () => {
    test("prefers claude over other families regardless of list order", () => {
        expect(pickDefaultModel(["gpt-4o", "claude-sonnet", "gemini-pro"])).toBe("claude-sonnet");
    });

    test("falls through the preference order: gpt before gemini before qwen", () => {
        expect(pickDefaultModel(["gemini-pro", "gpt-4o"])).toBe("gpt-4o");
        expect(pickDefaultModel(["qwen-72b", "gemini-pro"])).toBe("gemini-pro");
    });

    test("matches case-insensitively and by substring", () => {
        expect(pickDefaultModel(["My-Claude-3.5"])).toBe("My-Claude-3.5");
    });

    test("falls back to the first id when no preferred family is present", () => {
        expect(pickDefaultModel(["llama-3", "mistral-7b"])).toBe("llama-3");
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

// `resolveModelId`'s three failure modes are all reachable only through `fetch`, and its cache is
// process-wide by design. Swap the global rather than inject a seam: the function deliberately has no
// fetch parameter (the endpoint is env-owned, not user-overridable), and adding one for the test would
// widen a surface the design keeps closed.
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
     * stub answers only the one call shape `resolveModelId` makes, while `typeof fetch` also carries
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

    test("the ok path ranks the list and sends the key as a bearer token", async () => {
        const seenAuth: Array<string | null> = [];
        globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            seenAuth.push(new Headers(init?.headers).get("Authorization"));
            return modelsResponse(["gpt-4o", "claude-sonnet"]);
        }) as unknown as typeof fetch;

        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-sonnet");
        expect(seenAuth).toEqual(["Bearer sk-test"]);
    });

    test("caches the ok path — a second call issues no request", async () => {
        const calls = stubFetch(() => Promise.resolve(modelsResponse(["claude-sonnet"])));
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-sonnet");
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-sonnet");
        expect(calls()).toBe(1);
    });

    test("does NOT cache a failure — a transient outage must not poison the process", async () => {
        const failing = stubFetch(() => Promise.reject(new Error("down")));
        expect((await resolveModelId("sk-test")).isErr()).toBe(true);
        expect(failing()).toBe(1);

        const ok = stubFetch(() => Promise.resolve(modelsResponse(["claude-sonnet"])));
        expect((await resolveModelId("sk-test"))._unsafeUnwrap()).toBe("claude-sonnet");
        expect(ok()).toBe(1); // the retry really went out; the error path left no cached value
    });
});
