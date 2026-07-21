import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";

import "../../extensions/index.ts"; // installs Response.prototype.jsonWith, which listConnectionModels uses
import type { ChatSetupError, ModelAccess } from "../proxy/models.ts";
import type { ResolvedModelConnection } from "./config.ts";
import { listConnectionModels, validateModelSelection, type ListModelsSeams, type ValidateSelectionSeams } from "./model_listing.ts";

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
    resolveAuthCredential?: ListModelsSeams["resolveAuthCredential"];
    fetch: (url: string, headers: Record<string, string>) => Promise<Response>;
}): ListModelsSeams {
    return {
        resolveConnection: () => opts.connection,
        readProxyKey: opts.readProxyKey ?? (async () => ok("sk-proxy")),
        readModelApiKey: () => opts.modelApiKey,
        resolveAuthCredential:
            opts.resolveAuthCredential ??
            (() => {
                throw new Error("resolveAuthCredential must not be called without an auth block");
            }),
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

    test("a configured bearer auth block authenticates the listing like the chat path — Authorization, never x-api-key", async () => {
        const rec = recordingFetch(() => Promise.resolve(modelsResponse(["claude-sonnet-5"])));
        const result = await listConnectionModels(
            seamsFor({
                connection: {
                    mode: "direct",
                    provider: "anthropic",
                    baseURL: "https://gw.corp/v1",
                    protocol: "anthropic",
                    auth: { kind: "command", command: "corp token", scheme: "bearer" },
                    agents: {},
                },
                // The env key is ALSO set: the auth block must supersede it (the chat path's precedence).
                modelApiKey: "sk-env-must-not-be-used",
                resolveAuthCredential: async () => ok({ token: "gw-jwt", scheme: "bearer" }),
                fetch: rec.fetch,
            }),
        );
        expect(result._unsafeUnwrap()).toEqual(["claude-sonnet-5"]);
        expect(rec.calls[0]?.headers).toEqual({ Authorization: "Bearer gw-jwt", "anthropic-version": "2023-06-01" });
    });

    test("an unresolvable auth source degrades to key_missing (free-text picker), issuing no request", async () => {
        const rec = recordingFetch(() => Promise.reject(new Error("must not fetch")));
        const result = await listConnectionModels(
            seamsFor({
                connection: {
                    mode: "direct",
                    provider: "anthropic",
                    baseURL: "https://gw.corp/v1",
                    protocol: "anthropic",
                    auth: { kind: "command", command: "corp token", scheme: "bearer" },
                    agents: {},
                },
                resolveAuthCredential: async () => err({ type: "command_exit_nonzero", command: "corp token", exitCode: 1, stderr: "idp down" }),
                fetch: rec.fetch,
            }),
        );
        expect(result._unsafeUnwrapErr()).toEqual({ type: "key_missing" });
        expect(rec.calls).toHaveLength(0);
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

// Drives `validateModelSelection` (the picker's commit-time accessibility check) through injected seams:
// the cliproxy verdict is DELEGATED to checkModelAccess (asserted, never reimplemented here), the
// direct-anthropic `count_tokens` request is shaped + mapped in-file, and every can't-decide branch
// resolves to `inconclusive` so a switch is never blocked by validation. No network, no proxy config.

/** Build validate seams; every effect that a given test does NOT expect throws, so an unwanted call fails loudly. */
function validateSeamsFor(opts: {
    connection: ResolvedModelConnection;
    readProxyKey?: () => Promise<Result<string, ChatSetupError>>;
    modelApiKey?: string | undefined;
    resolveAuthCredential?: ValidateSelectionSeams["resolveAuthCredential"];
    checkModelAccess?: (apiKey: string, modelId: string, signal?: AbortSignal) => Promise<ModelAccess>;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): ValidateSelectionSeams {
    return {
        resolveConnection: () => opts.connection,
        readProxyKey: opts.readProxyKey ?? (async () => ok("sk-proxy")),
        readModelApiKey: () => opts.modelApiKey,
        resolveAuthCredential:
            opts.resolveAuthCredential ??
            (() => {
                throw new Error("resolveAuthCredential must not be called without an auth block");
            }),
        checkModelAccess:
            opts.checkModelAccess ??
            (() => {
                throw new Error("checkModelAccess must not be called");
            }),
        fetch:
            opts.fetch ??
            (() => {
                throw new Error("fetch must not be called");
            }),
    };
}

const DIRECT_ANTHROPIC: ResolvedModelConnection = {
    mode: "direct",
    provider: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    protocol: "anthropic",
    agents: {},
};

describe("validateModelSelection — per-mode commit validation", () => {
    test("cliproxy delegates to checkModelAccess with the proxy key and returns its verdict", async () => {
        const seen: { apiKey: string; modelId: string }[] = [];
        const result = await validateModelSelection(
            "claude-opus-4-8",
            validateSeamsFor({
                connection: { mode: "cliproxy", provider: "anthropic", agents: {} },
                checkModelAccess: async (apiKey, modelId) => {
                    seen.push({ apiKey, modelId });
                    return "served";
                },
            }),
        );
        expect(result).toBe("served");
        expect(seen).toEqual([{ apiKey: "sk-proxy", modelId: "claude-opus-4-8" }]);
    });

    test("cliproxy with no proxy key is inconclusive and never delegates", async () => {
        let delegated = 0;
        const result = await validateModelSelection(
            "claude-opus-4-8",
            validateSeamsFor({
                connection: { mode: "cliproxy", provider: "anthropic", agents: {} },
                readProxyKey: async () => err({ type: "proxy_key_missing" }),
                checkModelAccess: async () => {
                    delegated++;
                    return "served";
                },
            }),
        );
        expect(result).toBe("inconclusive");
        expect(delegated).toBe(0);
    });

    test("direct-anthropic 200 is served, POSTing count_tokens with the x-api-key + version headers", async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const result = await validateModelSelection(
            "claude-sonnet-4-5",
            validateSeamsFor({
                connection: DIRECT_ANTHROPIC,
                modelApiKey: "sk-ant",
                fetch: async (url, init) => {
                    calls.push({ url, init });
                    return new Response("{}", { status: 200 });
                },
            }),
        );
        expect(result).toBe("served");
        expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
        expect(calls[0]?.init.method).toBe("POST");
        expect(calls[0]?.init.headers).toMatchObject({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
    });

    test("a configured bearer auth block authenticates count_tokens like the chat path, superseding the env key", async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const result = await validateModelSelection(
            "claude-sonnet-5",
            validateSeamsFor({
                connection: { ...DIRECT_ANTHROPIC, auth: { kind: "command", command: "corp token", scheme: "bearer" } },
                modelApiKey: "sk-env-must-not-be-used",
                resolveAuthCredential: async () => ok({ token: "gw-jwt", scheme: "bearer" }),
                fetch: async (url, init) => {
                    calls.push({ url, init });
                    return new Response("{}", { status: 200 });
                },
            }),
        );
        expect(result).toBe("served");
        expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer gw-jwt", "anthropic-version": "2023-06-01" });
        expect((calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
    });

    test("an unresolvable auth source is inconclusive — the switch commits, no request is issued", async () => {
        let fetched = 0;
        const result = await validateModelSelection(
            "claude-sonnet-5",
            validateSeamsFor({
                connection: { ...DIRECT_ANTHROPIC, auth: { kind: "env", var: "CORP_TOKEN", scheme: "bearer" } },
                resolveAuthCredential: async () => err({ type: "env_var_unset", var: "CORP_TOKEN" }),
                fetch: async () => {
                    fetched++;
                    return new Response("{}", { status: 200 });
                },
            }),
        );
        expect(result).toBe("inconclusive");
        expect(fetched).toBe(0);
    });

    test("direct-anthropic 404 with a not_found_error body is not_found", async () => {
        const result = await validateModelSelection(
            "claude-nope",
            validateSeamsFor({
                connection: DIRECT_ANTHROPIC,
                modelApiKey: "sk-ant",
                fetch: async () => new Response(JSON.stringify({ error: { type: "not_found_error" } }), { status: 404 }),
            }),
        );
        expect(result).toBe("not_found");
    });

    test("direct-anthropic 404 WITHOUT a not_found_error body is inconclusive (matches checkModelAccess)", async () => {
        const result = await validateModelSelection(
            "claude-sonnet-4-5",
            validateSeamsFor({
                connection: DIRECT_ANTHROPIC,
                modelApiKey: "sk-ant",
                // A proxy/gateway that does not route count_tokens 404s everything — a bare 404 must NOT read
                // as inaccessible, only `not_found_error` does.
                fetch: async () => new Response("Not Found", { status: 404 }),
            }),
        );
        expect(result).toBe("inconclusive");
    });

    test("direct-anthropic whose request throws (timeout/abort) is inconclusive", async () => {
        const result = await validateModelSelection(
            "claude-sonnet-4-5",
            validateSeamsFor({
                connection: DIRECT_ANTHROPIC,
                modelApiKey: "sk-ant",
                fetch: async () => {
                    throw new Error("The operation timed out");
                },
            }),
        );
        expect(result).toBe("inconclusive");
    });

    test("direct openai-compatible is inconclusive without issuing any request", async () => {
        let fetchCount = 0;
        const result = await validateModelSelection(
            "gpt-4o",
            validateSeamsFor({
                connection: { mode: "direct", provider: "openai", baseURL: "https://api.example.com/v1", protocol: "openai-compatible", agents: {} },
                modelApiKey: "sk-direct",
                fetch: async () => {
                    fetchCount++;
                    return new Response("{}");
                },
            }),
        );
        expect(result).toBe("inconclusive");
        expect(fetchCount).toBe(0);
    });

    test("an invalid connection config is inconclusive without touching any validation effect", async () => {
        let touched = 0;
        const result = await validateModelSelection(
            "claude-opus-4-8",
            validateSeamsFor({
                connection: { mode: "cliproxy", provider: "anthropic", agents: {}, configError: { issues: "models.agents.sandbox: expected string" } },
                checkModelAccess: async () => {
                    touched++;
                    return "served";
                },
                fetch: async () => {
                    touched++;
                    return new Response("{}");
                },
            }),
        );
        expect(result).toBe("inconclusive");
        expect(touched).toBe(0);
    });
});
