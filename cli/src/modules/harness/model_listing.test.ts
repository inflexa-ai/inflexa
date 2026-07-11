import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";

import "../../extensions/index.ts"; // installs Response.prototype.jsonWith, which listConnectionModels uses
import type { ChatSetupError } from "../proxy/models.ts";
import type { ResolvedModelConnection } from "./config.ts";
import { listConnectionModels, type ListModelsSeams } from "./model_listing.ts";

// Drives `listConnectionModels` through injected seams so the per-mode request shaping (cliproxy vs.
// direct OpenAI-compatible vs. direct Anthropic) and the Result-channel degradations are exercised with
// no proxy config file, no `process.env`, and no network. Each test records the URL + headers the seam
// saw, pinning the exact request each connection mode issues.

/** Build seams over a fixed connection, a recorded fetch, and configurable credential reads. */
function seamsFor(opts: {
    connection: ResolvedModelConnection;
    // A thunk (not a bare Result): the neverthrow must-use rule flags a Result passed as an argument, so
    // the test hands back a reader whose Result is in RETURN position.
    readProxyKey?: () => Promise<Result<string, ChatSetupError>>;
    modelApiKey?: string | undefined;
    fetch: (url: string, headers: Record<string, string>) => Promise<Response>;
}): ListModelsSeams {
    return {
        resolveConnection: () => opts.connection,
        readProxyKey: opts.readProxyKey ?? (async () => ok("sk-proxy")),
        readModelApiKey: () => opts.modelApiKey,
        fetch: opts.fetch,
    };
}

function modelsResponse(ids: string[], init?: ResponseInit): Response {
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), init);
}

/** A fetch that records its call and answers with `res`. */
function recordingFetch(res: () => Promise<Response>): { fetch: ListModelsSeams["fetch"]; calls: { url: string; headers: Record<string, string> }[] } {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    return {
        calls,
        fetch: (url, headers) => {
            calls.push({ url, headers });
            return res();
        },
    };
}

describe("listConnectionModels — per-mode request shape", () => {
    test("cliproxy hits the proxy /models with a bearer token and returns the id list", async () => {
        const rec = recordingFetch(() => Promise.resolve(modelsResponse(["claude-sonnet-4-5", "claude-opus-4-8"])));
        const result = await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: rec.fetch }));

        expect(result._unsafeUnwrap()).toEqual(["claude-sonnet-4-5", "claude-opus-4-8"]);
        expect(rec.calls).toHaveLength(1);
        expect(rec.calls[0]?.url).toContain("/v1/models");
        expect(rec.calls[0]?.headers).toEqual({ Authorization: "Bearer sk-proxy" });
    });

    test("direct openai-compatible hits {baseURL}/models with a bearer token", async () => {
        const rec = recordingFetch(() => Promise.resolve(modelsResponse(["gpt-4o", "gpt-4o-mini"])));
        const result = await listConnectionModels(
            seamsFor({
                connection: { mode: "direct", provider: "openai", baseURL: "https://api.example.com/v1", protocol: "openai-compatible", agents: {} },
                modelApiKey: "sk-direct",
                fetch: rec.fetch,
            }),
        );

        expect(result._unsafeUnwrap()).toEqual(["gpt-4o", "gpt-4o-mini"]);
        expect(rec.calls[0]?.url).toBe("https://api.example.com/v1/models");
        expect(rec.calls[0]?.headers).toEqual({ Authorization: "Bearer sk-direct" });
    });

    test("direct anthropic appends /models to the same /v1-terminated baseURL the chat path uses", async () => {
        const rec = recordingFetch(() => Promise.resolve(modelsResponse(["claude-sonnet-4-5"])));
        const result = await listConnectionModels(
            seamsFor({
                // The `/v1`-terminated protocol root the chat path POSTs `{baseURL}/messages` to; the
                // listing appends `/models` to that SAME value, so one configured URL serves both paths.
                connection: { mode: "direct", provider: "anthropic", baseURL: "https://api.anthropic.com/v1", protocol: "anthropic", agents: {} },
                modelApiKey: "sk-ant",
                fetch: rec.fetch,
            }),
        );

        expect(result._unsafeUnwrap()).toEqual(["claude-sonnet-4-5"]);
        expect(rec.calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
        expect(rec.calls[0]?.headers).toEqual({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
    });
});

describe("listConnectionModels — expected failures degrade on the Result channel", () => {
    test("a malformed models block reports connection_invalid without touching the network", async () => {
        const rec = recordingFetch(() => Promise.reject(new Error("must not fetch")));
        const result = await listConnectionModels(
            seamsFor({
                connection: { mode: "cliproxy", provider: "anthropic", agents: {}, configError: { issues: "models.agents.sandbox: expected string" } },
                fetch: rec.fetch,
            }),
        );

        expect(result._unsafeUnwrapErr()).toEqual({ type: "connection_invalid", issues: "models.agents.sandbox: expected string" });
        expect(rec.calls).toHaveLength(0);
    });

    test("cliproxy with no proxy key is key_missing and issues no request", async () => {
        const rec = recordingFetch(() => Promise.reject(new Error("must not fetch")));
        const result = await listConnectionModels(
            seamsFor({
                connection: { mode: "cliproxy", provider: "anthropic", agents: {} },
                readProxyKey: async () => err({ type: "proxy_key_missing" }),
                fetch: rec.fetch,
            }),
        );

        expect(result._unsafeUnwrapErr()).toEqual({ type: "key_missing" });
        expect(rec.calls).toHaveLength(0);
    });

    test("direct mode with INFLEXA_MODEL_API_KEY unset is key_missing and issues no request", async () => {
        const rec = recordingFetch(() => Promise.reject(new Error("must not fetch")));
        const result = await listConnectionModels(
            seamsFor({
                connection: { mode: "direct", provider: "openai", baseURL: "https://api.example.com/v1", protocol: "openai-compatible", agents: {} },
                modelApiKey: undefined,
                fetch: rec.fetch,
            }),
        );

        expect(result._unsafeUnwrapErr()).toEqual({ type: "key_missing" });
        expect(rec.calls).toHaveLength(0);
    });

    test("a dead endpoint (fetch throws) is unreachable carrying the throw's message", async () => {
        const rec = recordingFetch(() => Promise.reject(new Error("connect ECONNREFUSED")));
        const result = await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: rec.fetch }));

        expect(result._unsafeUnwrapErr()).toEqual({ type: "unreachable", detail: "connect ECONNREFUSED" });
    });

    test("a non-ok response is unreachable naming the status", async () => {
        const rec = recordingFetch(() => Promise.resolve(new Response("nope", { status: 503 })));
        const result = await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: rec.fetch }));

        expect(result._unsafeUnwrapErr()).toEqual({ type: "unreachable", detail: "HTTP 503" });
    });

    test("an empty list — or a body that fails the schema — is no_models", async () => {
        const empty = recordingFetch(() => Promise.resolve(modelsResponse([])));
        expect(
            (
                await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: empty.fetch }))
            )._unsafeUnwrapErr(),
        ).toEqual({
            type: "no_models",
        });

        const garbage = recordingFetch(() => Promise.resolve(new Response("not json at all")));
        expect(
            (
                await listConnectionModels(seamsFor({ connection: { mode: "cliproxy", provider: "anthropic", agents: {} }, fetch: garbage.fetch }))
            )._unsafeUnwrapErr(),
        ).toEqual({
            type: "no_models",
        });
    });
});
