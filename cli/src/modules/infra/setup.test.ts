import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ok, err } from "neverthrow";
import {
    adoptedConnection,
    askProxy,
    classifyModelResolution,
    credentialHelperDetected,
    detectCredentialHelperFrom,
    detectedAdoptable,
    collectDirectModel,
    detectedGatewayURL,
    directModelPrefill,
    ensureLiveCredential,
    explicitPostgresFields,
    hasProviderCredential,
    normalizeAdoptedBaseURL,
    parseConnectionMode,
    probeCredentialSource,
    probeOnce,
    providerKindForSlug,
    recordCliproxyProvider,
    retryWhileUnreachable,
    selectDefaultModel,
    setup,
    warnStalePins,
    writeDirectConnection,
    type DirectModelDeps,
    type ProbeAttempt,
} from "./setup.ts";
import { type PostgresConnection } from "./postgres_types.ts";
import * as embeddingSetup from "../embedding/setup.ts";
import * as refsCommands from "../refs/commands.ts";
import { writeAgentModel, type ResolvedModelConnection } from "../harness/config.ts";
import { __resetModelCacheForTest, type ModelAccess } from "../proxy/models.ts";
import { readConfig } from "../../lib/config.ts";
import * as container from "../../lib/container.ts";
import { env, type ProviderEnvSnapshot } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";

/** Build a provider-env snapshot for the adoption helpers; every field defaults to "absent". */
function snapshot(overrides: Partial<ProviderEnvSnapshot> = {}): ProviderEnvSnapshot {
    return { anthropicApiKeySet: false, anthropicBaseURL: undefined, openaiApiKeySet: false, openaiBaseURL: undefined, ...overrides };
}

// generateApiKey + proxyConfig live in proxy_config.ts alongside writeProxyConfig; their unit tests
// live beside them in proxy_config.test.ts.

describe("parseConnectionMode", () => {
    test("an absent flag resolves to undefined (mode chosen interactively / defaulted)", () => {
        expect(parseConnectionMode(undefined)._unsafeUnwrap()).toBeUndefined();
    });

    test("accepts the two valid modes verbatim", () => {
        expect(parseConnectionMode("cliproxy")._unsafeUnwrap()).toBe("cliproxy");
        expect(parseConnectionMode("direct")._unsafeUnwrap()).toBe("direct");
    });

    test("rejects any other value with an actionable message", () => {
        const error = parseConnectionMode("proxy").match(
            () => null,
            (e) => e,
        );
        expect(error).not.toBeNull();
        expect(error?.message).toContain("cliproxy, direct");
    });
});

describe("normalizeAdoptedBaseURL", () => {
    test("a bare anthropic root gets /v1 appended (the wire layer needs the terminated form)", () => {
        expect(normalizeAdoptedBaseURL("anthropic", "https://api.anthropic.com")).toBe("https://api.anthropic.com/v1");
    });

    test("an already /v1-terminated URL is left unchanged (the openai convention)", () => {
        expect(normalizeAdoptedBaseURL("openai", "https://gw.corp/v1")).toBe("https://gw.corp/v1");
        expect(normalizeAdoptedBaseURL("anthropic", "https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1");
    });

    test("any /vN version segment counts as terminated (not just v1)", () => {
        expect(normalizeAdoptedBaseURL("openai", "https://gw.corp/v2")).toBe("https://gw.corp/v2");
    });

    test("an ambiguous gateway root without a version segment gets /v1 appended (the confirmable best guess)", () => {
        expect(normalizeAdoptedBaseURL("anthropic", "https://gw.corp/anthropic")).toBe("https://gw.corp/anthropic/v1");
    });

    test("a trailing slash never produces a doubled //v1", () => {
        expect(normalizeAdoptedBaseURL("anthropic", "https://api.anthropic.com/")).toBe("https://api.anthropic.com/v1");
    });

    test("an unset base URL defaults to the provider public root", () => {
        expect(normalizeAdoptedBaseURL("anthropic", undefined)).toBe("https://api.anthropic.com/v1");
        expect(normalizeAdoptedBaseURL("openai", undefined)).toBe("https://api.openai.com/v1");
        expect(normalizeAdoptedBaseURL("openai", "  ")).toBe("https://api.openai.com/v1");
    });
});

describe("ecosystem env adoption — detection → non-secret connection", () => {
    test("anthropic detection adopts the normalized connection (no key)", () => {
        const snap = snapshot({ anthropicApiKeySet: true, anthropicBaseURL: "https://api.anthropic.com" });
        expect(detectedAdoptable(snap)).toEqual(["anthropic"]);
        expect(adoptedConnection("anthropic", snap)).toEqual({
            provider: "anthropic",
            baseURL: "https://api.anthropic.com/v1",
            protocol: "anthropic",
        });
    });

    test("openai detection adopts its /v1-terminated gateway verbatim as openai-compatible", () => {
        const snap = snapshot({ openaiApiKeySet: true, openaiBaseURL: "https://gw.corp/v1" });
        expect(detectedAdoptable(snap)).toEqual(["openai"]);
        expect(adoptedConnection("openai", snap)).toEqual({
            provider: "openai",
            baseURL: "https://gw.corp/v1",
            protocol: "openai-compatible",
        });
    });

    test("key present but base URL absent defaults to the provider root", () => {
        expect(adoptedConnection("anthropic", snapshot({ anthropicApiKeySet: true })).baseURL).toBe("https://api.anthropic.com/v1");
        expect(adoptedConnection("openai", snapshot({ openaiApiKeySet: true })).baseURL).toBe("https://api.openai.com/v1");
    });

    test("both ecosystems present tiebreak deterministically anthropic-before-openai", () => {
        expect(detectedAdoptable(snapshot({ anthropicApiKeySet: true, openaiApiKeySet: true }))).toEqual(["anthropic", "openai"]);
    });

    test("no provider env is detected as nothing adoptable", () => {
        expect(detectedAdoptable(snapshot())).toEqual([]);
    });

    test("an adopted connection carries only the non-secret fields (never a key)", () => {
        const conn = adoptedConnection("anthropic", snapshot({ anthropicApiKeySet: true, anthropicBaseURL: "https://api.anthropic.com" }));
        expect(Object.keys(conn).sort()).toEqual(["baseURL", "protocol", "provider"]);
    });
});

// The credential-helper detection is a pure shape over its raw signals, so the offer logic and the
// "managed helper is never executed without explicit confirmation" guarantee are testable without
// touching the filesystem or env.
describe("credential-helper detection", () => {
    test("a user-level apiKeyHelper is detected and carried as a pre-fillable command", () => {
        const d = detectCredentialHelperFrom("/opt/mint-token", null, false);
        expect(credentialHelperDetected(d)).toBe(true);
        expect(d.userHelperCommand).toBe("/opt/mint-token");
    });

    test("ANTHROPIC_AUTH_TOKEN alone is a detected signal (env-bearer offerable)", () => {
        const d = detectCredentialHelperFrom(null, null, true);
        expect(credentialHelperDetected(d)).toBe(true);
        expect(d.authTokenEnvSet).toBe(true);
    });

    test("an org-managed helper alone is detected, carried as its own explicit choice — never merged into the user path", () => {
        const d = detectCredentialHelperFrom(null, "company-code token", false);
        expect(credentialHelperDetected(d)).toBe(true);
        expect(d.managedHelperCommand).toBe("company-code token");
        // Kept apart from the user's own helper: the offer labels it as the organization's, and the
        // command is only ever run after the user selects it and confirms it in the editable prompt.
        expect(d.userHelperCommand).toBeNull();
    });

    test("no signals → nothing detected", () => {
        expect(credentialHelperDetected(detectCredentialHelperFrom(null, null, false))).toBe(false);
    });

    test("a settings env.ANTHROPIC_BASE_URL rides the detection beside the helper", () => {
        const d = detectCredentialHelperFrom(null, "company-code token", false, "https://gw.corp");
        expect(d.settingsBaseURL).toBe("https://gw.corp");
    });
});

// The gateway-endpoint offer is a pure decision over the detection + env snapshot, so the
// "no credential signal → no offer" guarantee and the settings-over-shell precedence are unit-testable.
describe("detectedGatewayURL", () => {
    test("a settings URL beside a helper is offered", () => {
        const d = detectCredentialHelperFrom(null, "company-code token", false, "https://gw.corp");
        expect(detectedGatewayURL(d, snapshot())).toBe("https://gw.corp");
    });

    test("settings URL wins over a shell ANTHROPIC_BASE_URL", () => {
        const d = detectCredentialHelperFrom("/opt/mint-token", null, false, "https://gw.corp");
        expect(detectedGatewayURL(d, snapshot({ anthropicBaseURL: "https://other.example" }))).toBe("https://gw.corp");
    });

    test("a key-less shell ANTHROPIC_BASE_URL is offered when a credential signal exists", () => {
        const d = detectCredentialHelperFrom(null, null, true);
        expect(detectedGatewayURL(d, snapshot({ anthropicBaseURL: "https://gw.corp" }))).toBe("https://gw.corp");
    });

    test("no credential signal → no offer, even with URLs present (nothing could authenticate it)", () => {
        const d = detectCredentialHelperFrom(null, null, false, "https://gw.corp");
        expect(detectedGatewayURL(d, snapshot({ anthropicBaseURL: "https://gw.corp" }))).toBeNull();
    });

    test("credential signals without any URL → no offer", () => {
        const d = detectCredentialHelperFrom("/opt/mint-token", null, false);
        expect(detectedGatewayURL(d, snapshot())).toBeNull();
    });
});

// The setup validation probe (design D6): run the source once, then a cheap authenticated GET {baseURL}/models.
// A stubbed fetch drives the HTTP outcomes; the credential command is a real deterministic shell command.
describe("probeCredentialSource", () => {
    /** A recording fetch serving per-route responses; keys are URL path suffixes. Unmapped routes 404. */
    function routeFetch(routes: Record<string, () => Response>): {
        doFetch: (url: string, init: RequestInit) => Promise<Response>;
        calls: { url: string; method: string; headers: Headers; body: string | null }[];
    } {
        const calls: { url: string; method: string; headers: Headers; body: string | null }[] = [];
        return {
            calls,
            doFetch: (url, init) => {
                calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : null });
                const route = Object.keys(routes).find((suffix) => url.endsWith(suffix));
                return Promise.resolve(route !== undefined ? routes[route]!() : new Response(null, { status: 404 }));
            },
        };
    }

    test("a 2xx /models validates, sends the scheme + version headers, and returns the listed ids", async () => {
        const { doFetch, calls } = routeFetch({ "/models": () => Response.json({ data: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5" }] }) });
        const result = await probeCredentialSource(
            "https://api.anthropic.com/v1",
            "anthropic",
            { kind: "command", command: "printf tok-123", scheme: "x-api-key" },
            "claude-sonnet-5",
            doFetch,
        );
        const value = result._unsafeUnwrap();
        expect(value.outcome).toBe("pass");
        if (value.outcome === "pass") {
            expect(value.listedModels).toEqual(["claude-sonnet-5", "claude-haiku-4-5"]);
            expect(value.validatedModel).toBeNull(); // rung 1 validated the credential, not a model
        }
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
        expect(calls[0]!.headers.get("x-api-key")).toBe("tok-123");
        expect(calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    });

    test("a 401 on /models fails the probe with a message naming the scheme (the bad-config gate)", async () => {
        const { doFetch } = routeFetch({ "/models": () => new Response(null, { status: 401 }) });
        const result = await probeCredentialSource(
            "https://gw.corp/v1",
            "openai-compatible",
            { kind: "command", command: "printf gw-tok", scheme: "bearer" },
            "gpt-5",
            doFetch,
        );
        expect(result._unsafeUnwrapErr().message).toContain("bearer");
    });

    test("a 404 /models escalates to the messages ping; a 200 ping passes with the model validated (the enterprise-gateway shape)", async () => {
        const { doFetch, calls } = routeFetch({
            "/models": () => new Response(null, { status: 404 }),
            "/messages": () => Response.json({ type: "message" }),
        });
        const result = await probeCredentialSource(
            "https://gw.corp/v1",
            "anthropic",
            { kind: "command", command: "printf gw-tok", scheme: "bearer" },
            "claude-sonnet-5",
            doFetch,
        );
        const value = result._unsafeUnwrap();
        expect(value.outcome).toBe("pass");
        if (value.outcome === "pass") expect(value.validatedModel).toBe("claude-sonnet-5");
        // The ping is protocol-shaped: POST {baseURL}/messages, bearer + version headers, max_tokens 1.
        expect(calls[1]!.url).toBe("https://gw.corp/v1/messages");
        expect(calls[1]!.method).toBe("POST");
        expect(calls[1]!.headers.get("authorization")).toBe("Bearer gw-tok");
        expect(calls[1]!.headers.get("x-api-key")).toBeNull();
        expect(calls[1]!.headers.get("anthropic-version")).toBe("2023-06-01");
        expect(JSON.parse(calls[1]!.body!)).toEqual({ model: "claude-sonnet-5", max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
    });

    test("an openai-compatible ping targets /chat/completions", async () => {
        const { doFetch, calls } = routeFetch({
            "/models": () => new Response(null, { status: 404 }),
            "/chat/completions": () => Response.json({ choices: [] }),
        });
        const result = await probeCredentialSource(
            "https://gw.corp/v1",
            "openai-compatible",
            { kind: "command", command: "printf gw-tok", scheme: "bearer" },
            "gpt-5",
            doFetch,
        );
        expect(result._unsafeUnwrap().outcome).toBe("pass");
        expect(calls[1]!.url).toBe("https://gw.corp/v1/chat/completions");
        expect(calls[1]!.headers.get("anthropic-version")).toBeNull();
    });

    test("a definite model-not-found on the ping still passes the CREDENTIAL probe (auth + routing proven)", async () => {
        const { doFetch } = routeFetch({
            "/models": () => new Response(null, { status: 404 }),
            "/messages": () => Response.json({ error: { type: "not_found_error", message: "model: nope-1" } }, { status: 404 }),
        });
        const result = await probeCredentialSource(
            "https://gw.corp/v1",
            "anthropic",
            { kind: "command", command: "printf gw-tok", scheme: "bearer" },
            "nope-1",
            doFetch,
        );
        const value = result._unsafeUnwrap();
        expect(value.outcome).toBe("pass");
        if (value.outcome === "pass") expect(value.validatedModel).toBeNull(); // the model itself was NOT validated
    });

    test("a 401 on the ping fails; a non-standard rejection (500 invalid token) is AMBIGUOUS with the excerpt", async () => {
        const auth = { kind: "command", command: "printf gw-tok", scheme: "bearer" } as const;
        const unauthorized = routeFetch({ "/models": () => new Response(null, { status: 404 }), "/messages": () => new Response(null, { status: 401 }) });
        expect((await probeCredentialSource("https://gw.corp/v1", "anthropic", auth, "m", unauthorized.doFetch))._unsafeUnwrapErr().message).toContain(
            "bearer",
        );
        const weird = routeFetch({
            "/models": () => new Response(null, { status: 404 }),
            "/messages": () => new Response("invalid token", { status: 500 }),
        });
        const value = (await probeCredentialSource("https://gw.corp/v1", "anthropic", auth, "m", weird.doFetch))._unsafeUnwrap();
        expect(value.outcome).toBe("ambiguous");
        if (value.outcome === "ambiguous") {
            expect(value.status).toBe(500);
            expect(value.excerpt).toBe("invalid token");
        }
    });

    test("a credential that produces no token fails BEFORE any fetch (the command/env cause)", async () => {
        const { doFetch, calls } = routeFetch({ "/models": () => new Response(null, { status: 200 }) });
        // `true` exits 0 with empty stdout → command_empty_output, so the endpoint is never contacted.
        const result = await probeCredentialSource(
            "https://api.anthropic.com/v1",
            "anthropic",
            { kind: "command", command: "true", scheme: "x-api-key" },
            "claude-sonnet-5",
            doFetch,
        );
        expect(result.isErr()).toBe(true);
        expect(calls).toHaveLength(0);
    });
});

describe("directModelPrefill", () => {
    test("the ranked listing wins over the conventional default, which wins over the empty free-text prompt", () => {
        // gpt ranks below claude in the family preference, so the claude id is the top-ranked pre-fill.
        expect(directModelPrefill(["gpt-5", "claude-sonnet-5"], "anthropic")).toBe("claude-sonnet-5");
        expect(directModelPrefill(null, "anthropic")).toBe("claude-sonnet-5");
        expect(directModelPrefill([], "google")).toBe("gemini-2.5-pro");
        // No listing and no convention for the slug: no guess at all.
        expect(directModelPrefill(null, "my-corp-gateway")).toBe("");
    });
});

describe("collectDirectModel", () => {
    /** Deps whose collaborators record; overrides shape each case. */
    function harness(overrides: Partial<DirectModelDeps> = {}): { deps: DirectModelDeps; written: string[]; prompts: (string | null)[] } {
        const written: string[] = [];
        const prompts: (string | null)[] = [];
        const deps: DirectModelDeps = {
            prefill: "claude-sonnet-5",
            validatedModel: null,
            promptModel: (prefill, retryDetail) => {
                prompts.push(retryDetail);
                return Promise.resolve(prefill);
            },
            validate: () => Promise.resolve({ kind: "pass" }),
            confirmSave: () => Promise.resolve(false),
            writeBoth: (model) => {
                written.push(model);
                return ok(undefined);
            },
            warn: () => {},
            success: () => {},
            ...overrides,
        };
        return { deps, written, prompts };
    }

    test("a validated pick persists to both agents via the injected write", async () => {
        const { deps, written } = harness();
        await collectDirectModel(deps);
        expect(written).toEqual(["claude-sonnet-5"]);
    });

    test("a pick matching the probe-validated model skips re-validation", async () => {
        let validations = 0;
        const { deps, written } = harness({
            validatedModel: "claude-sonnet-5",
            validate: () => {
                validations += 1;
                return Promise.resolve({ kind: "pass" });
            },
        });
        await collectDirectModel(deps);
        expect(validations).toBe(0);
        expect(written).toEqual(["claude-sonnet-5"]);
    });

    test("no validation capability persists the pick unvalidated", async () => {
        const { deps, written } = harness({ validate: null });
        await collectDirectModel(deps);
        expect(written).toEqual(["claude-sonnet-5"]);
    });

    test("a definite model-not-found re-prompts with the endpoint's rejection, then the corrected pick persists", async () => {
        const entries = ["nope-1", "claude-sonnet-5"];
        const { deps, written, prompts } = harness({
            promptModel: (_prefill, retryDetail) => {
                prompts.push(retryDetail);
                return Promise.resolve(entries.shift()!);
            },
            validate: (model) =>
                Promise.resolve(model === "nope-1" ? { kind: "model_not_found", excerpt: `{"error":{"message":"model: nope-1"}}` } : { kind: "pass" }),
        });
        await collectDirectModel(deps);
        expect(written).toEqual(["claude-sonnet-5"]);
        expect(prompts).toEqual([null, `{"error":{"message":"model: nope-1"}}`]); // the rejection rides into the re-prompt
    });

    test("an ambiguous validation persists on save-anyway and re-prompts on decline", async () => {
        const accepted = harness({
            validate: () => Promise.resolve({ kind: "ambiguous", status: 500, excerpt: "invalid token" }),
            confirmSave: () => Promise.resolve(true),
        });
        await collectDirectModel(accepted.deps);
        expect(accepted.written).toEqual(["claude-sonnet-5"]);

        let declines = 1;
        const declined = harness({
            validate: () => Promise.resolve({ kind: "ambiguous", status: 500, excerpt: "invalid token" }),
            confirmSave: () => Promise.resolve(declines-- <= 0), // decline once, accept the retry
        });
        await collectDirectModel(declined.deps);
        expect(declined.prompts).toHaveLength(2);
        expect(declined.written).toEqual(["claude-sonnet-5"]);
    });
});

// The config-writing tests round-trip through the real readConfig()/writeConfig() surface against the
// sandboxed env.configPath (set by the test preload). Guard first, in the hooks: at the monorepo root
// that path is the developer's REAL config.json (data-loss guard — test_support/sandbox.ts).
describe("connection config writes", () => {
    beforeEach(() => {
        assertTestSandbox(env.configPath);
    });

    afterEach(() => {
        assertTestSandbox(env.configPath);
        rmSync(env.configPath, { force: true });
    });

    // `readConfig().models` is `unknown` (validated downstream); read it as a record to inspect what
    // the setup writers persisted.
    function readModels(): Record<string, unknown> {
        return (readConfig().models ?? {}) as Record<string, unknown>;
    }

    function seedConfig(value: Record<string, unknown>): void {
        mkdirSync(dirname(env.configPath), { recursive: true });
        writeFileSync(env.configPath, JSON.stringify(value));
    }

    test("recordCliproxyProvider maps the account kind to its provider slug", () => {
        // _unsafeUnwrap throws on an Err (a test file may — an unexpected write failure IS the failure).
        recordCliproxyProvider("claude")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "anthropic" });
    });

    test("every account kind maps to the documented slug", () => {
        recordCliproxyProvider("openai")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "openai" });
        recordCliproxyProvider("gemini")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "google" });
        recordCliproxyProvider("qwen")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "qwen" });
        recordCliproxyProvider("iflow")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "iflow" });
    });

    test("re-authenticating a different account kind rewrites the provider slug", () => {
        recordCliproxyProvider("claude")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "anthropic" });
        recordCliproxyProvider("gemini")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "google" });
    });

    test("recording is spread-preserving — other config keys and other models keys survive", () => {
        // A pre-existing sibling inside the models block (the `agents` block, opaque to the connection
        // writer) and an unrelated top-level key must both survive the connection rewrite.
        seedConfig({ telemetry: true, models: { agents: { chat: "x" }, connection: { mode: "cliproxy", provider: "openai" } } });
        recordCliproxyProvider("claude")._unsafeUnwrap();
        expect(readConfig().telemetry).toBe(true);
        expect(readModels().agents).toEqual({ chat: "x" });
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "anthropic" });
    });

    test("writeDirectConnection persists mode/provider/baseURL and omits protocol when unset", () => {
        writeDirectConnection({ provider: "openai", baseURL: "https://api.openai.com/v1" })._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "direct", provider: "openai", baseURL: "https://api.openai.com/v1" });
    });

    test("writeDirectConnection persists an explicit protocol override", () => {
        writeDirectConnection({ provider: "anthropic", baseURL: "https://gw.example/v1", protocol: "openai-compatible" })._unsafeUnwrap();
        expect(readModels().connection).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://gw.example/v1",
            protocol: "openai-compatible",
        });
    });

    test("an adopted ecosystem connection persists to config with no key material", () => {
        // Adopt an anthropic env, write it, and assert config.json carries the three non-secret fields and
        // no key: the whole config text must not contain any key-shaped material.
        const conn = adoptedConnection("anthropic", snapshot({ anthropicApiKeySet: true, anthropicBaseURL: "https://api.anthropic.com" }));
        writeDirectConnection(conn)._unsafeUnwrap();
        expect(readModels().connection).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://api.anthropic.com/v1",
            protocol: "anthropic",
        });
        const configText = JSON.stringify(readConfig());
        expect(configText.toLowerCase()).not.toContain("apikey");
        expect(configText).not.toContain("ANTHROPIC_API_KEY");
    });

    test("writeDirectConnection writes only endpoint facts (no secret key) and preserves models siblings", () => {
        seedConfig({ telemetry: false, models: { agents: { chat: "y" } } });
        writeDirectConnection({ provider: "deepseek", baseURL: "https://api.deepseek.com/v1" })._unsafeUnwrap();
        expect(readModels().agents).toEqual({ chat: "y" });
        // The written connection carries exactly mode/provider/baseURL — no apiKey/token field. The
        // direct-mode secret lives only in INFLEXA_MODEL_API_KEY, never in config.
        expect(Object.keys(readModels().connection as Record<string, unknown>).sort()).toEqual(["baseURL", "mode", "provider"]);
    });

    test("writeDirectConnection persists a command credential source ({command, scheme}) and no token", () => {
        writeDirectConnection({
            provider: "anthropic",
            baseURL: "https://api.anthropic.com/v1",
            protocol: "anthropic",
            auth: { kind: "command", command: "/opt/mint-token", scheme: "x-api-key" },
        })._unsafeUnwrap();
        expect(readModels().connection).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://api.anthropic.com/v1",
            protocol: "anthropic",
            auth: { kind: "command", command: "/opt/mint-token", scheme: "x-api-key" },
        });
        // The whole config text carries the command + scheme but never a token value.
        const configText = JSON.stringify(readConfig());
        expect(configText).toContain("/opt/mint-token");
        expect(configText.toLowerCase()).not.toContain('token":"sk-');
    });

    test("writeDirectConnection persists an env-bearer credential source with no token", () => {
        writeDirectConnection({
            provider: "anthropic",
            baseURL: "https://api.anthropic.com/v1",
            auth: { kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" },
        })._unsafeUnwrap();
        const connection = readModels().connection as Record<string, unknown>;
        expect(connection.auth).toEqual({ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" });
        // Only the variable NAME is stored — never a resolved token value.
        expect(JSON.stringify(connection)).not.toContain("sk-ant");
    });
});

// The persist-only-explicit rule for the Postgres prompt: config.json is shared by both build channels,
// so only a value that DIFFERS from its default is persisted, and the block is rebuilt fresh each run — an
// accepted default writes nothing, and a re-accept heals a default an earlier run froze. The port test is
// reserved-ness (8432 AND 8434), not "equals this channel's default", so setup on either channel drops
// either channel's default. Tested via the pure helper (the prompt itself is a clack TTY flow).
describe("explicitPostgresFields — persist-only-explicit", () => {
    // The all-defaults connection for a given default port — what a fully-accepted prompt yields.
    function defaults(port: number): PostgresConnection {
        return { host: "localhost", port, database: "inflexa", user: "inflexa", password: "inflexa" };
    }

    test("all defaults persist nothing — an empty block the caller drops entirely", () => {
        expect(explicitPostgresFields(defaults(env.postgresPort))).toEqual({});
    });

    test("a single custom field persists alone; accepted defaults (including the port) do not", () => {
        const conn = { ...defaults(env.postgresPort), password: "s3cret" };
        expect(explicitPostgresFields(conn)).toEqual({ password: "s3cret" });
    });

    test("a custom user, host, and non-default port each persist", () => {
        const conn: PostgresConnection = { host: "db.internal", port: 6000, database: "inflexa", user: "alice", password: "inflexa" };
        expect(explicitPostgresFields(conn)).toEqual({ host: "db.internal", port: 6000, user: "alice" });
    });

    test("this channel's default port drops (healing a frozen pin); a genuinely custom port persists", () => {
        // Re-accepting the prompt when a stale pin equalled the default rebuilds an empty port field.
        expect(explicitPostgresFields(defaults(env.postgresPort)).port).toBeUndefined();
        // A value that is not a channel default is a real choice, kept.
        expect(explicitPostgresFields({ ...defaults(env.postgresPort), port: 6000 }).port).toBe(6000);
    });

    test("the OTHER channel's default port also drops — a reserved value is never persisted from either channel", () => {
        // 8432 (prod default) and 8434 (dev default) are BOTH reserved. Persisting either from any channel
        // would pin one channel's default into the shared config.json and override the other's — the freeze
        // this filter prevents. So each is dropped regardless of which channel's process runs the filter.
        expect(explicitPostgresFields({ ...defaults(env.postgresPort), port: 8432 }).port).toBeUndefined();
        expect(explicitPostgresFields({ ...defaults(env.postgresPort), port: 8434 }).port).toBeUndefined();
    });
});

// hasProviderCredential takes the dir as a parameter, so these run against plain temp dirs — no env
// sandbox involvement, no shared state.
describe("hasProviderCredential", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "inflexa-cred-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("a missing dir is unauthenticated (the ordinary never-logged-in state)", async () => {
        expect(await hasProviderCredential(join(dir, "absent"))).toBe(false);
    });

    test("a logs-only dir is unauthenticated — the vendor writes logs/ beside credentials", async () => {
        mkdirSync(join(dir, "logs"));
        expect(await hasProviderCredential(dir)).toBe(false);
    });

    test("an operator-disabled credential is unauthenticated", async () => {
        writeFileSync(join(dir, "claude-user@example.com.json"), JSON.stringify({ disabled: true, expired: "2099-01-01T00:00:00Z" }));
        expect(await hasProviderCredential(dir)).toBe(false);
    });

    test("a PAST expired timestamp does not fail the static check — the proxy refreshes access tokens", async () => {
        writeFileSync(join(dir, "claude-user@example.com.json"), JSON.stringify({ disabled: false, expired: "2020-01-01T00:00:00Z" }));
        expect(await hasProviderCredential(dir)).toBe(true);
    });

    test("an unparseable credential counts as present — the live probe adjudicates validity, not the parser", async () => {
        writeFileSync(join(dir, "claude-user@example.com.json"), "{not json");
        expect(await hasProviderCredential(dir)).toBe(true);
    });

    test("dotfiles and non-json entries never count", async () => {
        mkdirSync(join(dir, "logs"));
        writeFileSync(join(dir, ".hidden.json"), "{}");
        writeFileSync(join(dir, "readme.txt"), "hi");
        expect(await hasProviderCredential(dir)).toBe(false);
    });
});

describe("providerKindForSlug", () => {
    test("maps recorded slugs back to their account kind and everything else to undefined", () => {
        expect(providerKindForSlug("anthropic")).toBe("claude");
        expect(providerKindForSlug("openai")).toBe("openai");
        expect(providerKindForSlug("deepseek")).toBeUndefined();
        expect(providerKindForSlug(undefined)).toBeUndefined();
    });
});

// The launch-gate policy matrix, driven through injected seams — no terminal, container runtime, or
// clack involved. `probes` is consumed in order so each call observes the scripted next outcome. The
// re-login is now a confirmable prompt (confirmRelogin), recorded as "confirm" so accept/decline are
// pinned; the four non-verdict outcomes (unobservable, cooling_down, client_key_drift, empty_at_deadline)
// must all warn-and-proceed and NEVER reach "relogin".
describe("ensureLiveCredential", () => {
    type Probe = Awaited<ReturnType<Parameters<typeof ensureLiveCredential>[0]["probe"]>>;

    // `confirmResult` decides accept (true) vs decline (false) while ALWAYS recording the "confirm" step,
    // so the decline path is scripted without overriding the seam (a bare override would drop the record).
    function scripted(probes: Probe[], over: Partial<Parameters<typeof ensureLiveCredential>[0]> = {}, confirmResult = true) {
        const calls: string[] = [];
        const deps: Parameters<typeof ensureLiveCredential>[0] = {
            probe: async () => {
                calls.push("probe");
                return probes.shift() ?? { kind: "ok" };
            },
            confirmRelogin: async () => {
                calls.push("confirm");
                return confirmResult;
            },
            relogin: async () => {
                calls.push("relogin");
                return true;
            },
            restartProxy: async () => {
                calls.push("restart");
                return ok<void, { message: string }>(undefined);
            },
            isInteractive: () => true,
            // Not recorded: announcing is narration, not a policy step, and asserting it would pin the
            // wording of every re-login message into the matrix below.
            announce: () => {},
            warn: () => {
                calls.push("warn");
            },
            ...over,
        };
        return { deps, calls };
    }

    test("a healthy probe proceeds without touching the login", async () => {
        const { deps, calls } = scripted([{ kind: "ok" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe"]);
    });

    test("an unobservable probe (outage, timeout, cold container) warns and proceeds — never blocks launch", async () => {
        const { deps, calls } = scripted([{ kind: "unobservable", detail: "HTTP 503" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe", "warn"]);
    });

    test("a cooldown warns and proceeds without ever offering a login (a healthy credential must not be churned)", async () => {
        const { deps, calls } = scripted([{ kind: "cooling_down" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe", "warn"]);
    });

    test("an empty-at-deadline (ambiguous) warns naming both causes and proceeds — never a login", async () => {
        const { deps, calls } = scripted([{ kind: "empty_at_deadline" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe", "warn"]);
    });

    test("a client-key drift warns naming inflexa setup and proceeds — a re-login cannot fix it", async () => {
        const warnings: string[] = [];
        const { deps, calls } = scripted([{ kind: "client_key_drift" }], { warn: (m) => warnings.push(m) });
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe"]); // warn is redirected to `warnings`, so it is absent from calls
        expect(warnings[0]).toContain("inflexa setup");
    });

    test("a 401 on a non-TTY fails actionably naming the forced re-login command", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }], { isInteractive: () => false });
        const result = await ensureLiveCredential(deps);
        expect(result.isErr()).toBe(true);
        expect(result.isErr() ? result.error.message : "").toContain("inflexa setup --provider");
        expect(calls).toEqual(["probe"]);
    });

    test("a 401 on a TTY OFFERS the login, and accepting drives re-login → restart → re-probe, then proceeds", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }, { kind: "ok" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe", "confirm", "relogin", "restart", "probe"]);
    });

    test("declining the offered re-login warns and proceeds — no login, no restart, no re-probe", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }], {}, false);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe", "confirm", "warn"]);
    });

    test("an incomplete re-login fails without restarting or re-probing", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }], { relogin: async () => false });
        const result = await ensureLiveCredential(deps);
        expect(result.isErr() ? result.error.message : "").toContain("didn't complete");
        expect(calls).toEqual(["probe", "confirm"]);
    });

    test("a failed proxy restart fails rather than re-probing a proxy that never saw the fresh login", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }], {
            restartProxy: async () => err({ message: "compose exploded" }),
        });
        const result = await ensureLiveCredential(deps);
        expect(result.isErr() ? result.error.message : "").toContain("restart");
        expect(calls).toEqual(["probe", "confirm", "relogin"]);
    });

    test("a second 401 after re-login fails hard naming both remaining causes", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }, { kind: "unauthorized" }]);
        const result = await ensureLiveCredential(deps);
        expect(result.isErr() ? result.error.message : "").toContain("Still unauthorized");
        expect(calls).toEqual(["probe", "confirm", "relogin", "restart", "probe"]);
    });

    test("an unobservable re-probe after re-login warns and proceeds", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }, { kind: "unobservable", detail: "HTTP 502" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe", "confirm", "relogin", "restart", "probe", "warn"]);
    });

    test("an ambiguous re-probe after re-login warns and proceeds — the post-bounce empty window is never a hard fail", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }, { kind: "empty_at_deadline" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe", "confirm", "relogin", "restart", "probe", "warn"]);
    });
});

// How a raw attempt becomes a verdict the policy above can act on. These are the seams where a misread
// used to turn the launch gate into a spurious re-login: an answering-but-cold-boot empty list read as a
// dead credential, and a client-key-middleware 401 read as a provider rejection.
describe("classifyModelResolution", () => {
    test("an empty model list is NOT a verdict — it is `not_ready`, waited out for the auth-registration window", () => {
        expect(classifyModelResolution({ type: "no_models" })).toEqual({ kind: "not_ready" });
    });

    test("a 401 from /models is a client-key drift (middleware-only), never a provider-credential verdict", () => {
        expect(classifyModelResolution({ type: "proxy_unreachable", detail: "HTTP 401" })).toEqual({ kind: "client_key_drift" });
    });

    test("a cooldown from model resolution stays a cooldown, not an outage", () => {
        expect(classifyModelResolution({ type: "cooling_down" })).toEqual({ kind: "cooling_down" });
    });

    test("a served status that is not 401 is unobservable — a fault, but not one about the credential", () => {
        expect(classifyModelResolution({ type: "proxy_unreachable", detail: "HTTP 503" })).toEqual({
            kind: "unobservable",
            detail: "proxy_unreachable: HTTP 503",
        });
    });

    test("silence is unreachable, NOT unobservable — it is the retryable one", () => {
        // The shape resolveModelId reports for a refused connection (see its own tests).
        expect(classifyModelResolution({ type: "proxy_unreachable", detail: "socket hang up" })).toEqual({
            kind: "unreachable",
            detail: "socket hang up",
        });
    });

    test("a missing client key is unobservable — nothing was asked, so nothing was learned", () => {
        expect(classifyModelResolution({ type: "proxy_key_missing" })).toEqual({ kind: "unobservable", detail: "proxy_key_missing" });
    });
});

// The readiness wait the probe has instead of a health endpoint. Budget/pause are injected so these
// run in milliseconds rather than the production 10s.
describe("retryWhileUnreachable", () => {
    test("retries silence until the proxy answers, then returns that verdict", async () => {
        const outcomes: ProbeAttempt[] = [{ kind: "unreachable", detail: "ECONNREFUSED" }, { kind: "unreachable", detail: "ECONNREFUSED" }, { kind: "ok" }];
        let tries = 0;
        const result = await retryWhileUnreachable(
            async () => {
                tries++;
                return outcomes.shift() ?? { kind: "ok" };
            },
            1_000,
            1,
        );
        expect(result).toEqual({ kind: "ok" });
        expect(tries).toBe(3);
    });

    test("a 401 behind a cold container is still caught — the wait does not swallow the verdict it exists to reach", async () => {
        const outcomes: ProbeAttempt[] = [{ kind: "unreachable", detail: "ECONNREFUSED" }, { kind: "unauthorized" }];
        const result = await retryWhileUnreachable(async () => outcomes.shift() ?? { kind: "ok" }, 1_000, 1);
        expect(result).toEqual({ kind: "unauthorized" });
    });

    test("a proxy silent past the budget degrades to unobservable — warn and proceed, never block", async () => {
        const result = await retryWhileUnreachable(async () => ({ kind: "unreachable", detail: "ECONNREFUSED" }), 5, 1);
        expect(result).toEqual({ kind: "unobservable", detail: "ECONNREFUSED" });
    });

    test("an answering proxy is never paced — one try, no wait", async () => {
        let tries = 0;
        const result = await retryWhileUnreachable(async () => {
            tries++;
            return { kind: "unauthorized" };
        });
        expect(result).toEqual({ kind: "unauthorized" });
        expect(tries).toBe(1);
    });

    test("a not_ready (answering, auth not yet registered) is retried like silence until the list populates, then returns that verdict", async () => {
        // The cold-boot window: an empty list, then the registered proxy's real verdict. Interleave an
        // unreachable try to prove both "keep waiting" kinds retry under the one budget.
        const outcomes: ProbeAttempt[] = [
            { kind: "not_ready" },
            { kind: "unreachable", detail: "ECONNREFUSED" },
            { kind: "not_ready" },
            { kind: "unauthorized" },
        ];
        let tries = 0;
        const result = await retryWhileUnreachable(
            async () => {
                tries++;
                return outcomes.shift() ?? { kind: "ok" };
            },
            1_000,
            1,
        );
        expect(result).toEqual({ kind: "unauthorized" });
        expect(tries).toBe(4);
    });

    test("a list still empty at the deadline is the ambiguous empty_at_deadline — never a login, and distinct from an outage's unobservable", async () => {
        const result = await retryWhileUnreachable(async () => ({ kind: "not_ready" }), 5, 1);
        expect(result).toEqual({ kind: "empty_at_deadline" });
    });
});

// askProxy's 503 discrimination: a served 503 carrying the proxy's `auth_unavailable` cooldown body is a
// distinct `cooling_down` outcome (never a login), while any other 503 (or an unparseable body) stays on
// the generic unobservable path. Global-fetch stub — askProxy issues a real /messages POST.
describe("askProxy — 503 cooldown discrimination", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    function stubStatus(status: number, body: string): void {
        globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
    }

    test("a 503 carrying the proxy's auth_unavailable marker is `cooling_down`", async () => {
        stubStatus(
            503,
            JSON.stringify({
                type: "error",
                error: { type: "api_error", message: "auth_unavailable: no auth available (providers=claude, model=claude-x); check credentials" },
            }),
        );
        expect(await askProxy("sk-x", "claude-x")).toEqual({ kind: "cooling_down" });
    });

    test("a 503 whose body carries no recognized marker stays unobservable — the generic warn-and-proceed path", async () => {
        stubStatus(503, JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream temporarily unavailable" } }));
        expect(await askProxy("sk-x", "claude-x")).toEqual({ kind: "unobservable", detail: "HTTP 503" });
    });

    test("a 503 with a non-JSON body degrades to unobservable, never a throw", async () => {
        stubStatus(503, "Service Unavailable");
        expect(await askProxy("sk-x", "claude-x")).toEqual({ kind: "unobservable", detail: "HTTP 503" });
    });

    test("a 200 completion is ok; a 401 is the definite unauthorized verdict", async () => {
        stubStatus(200, "{}");
        expect(await askProxy("sk-x", "claude-x")).toEqual({ kind: "ok" });
        stubStatus(401, "nope");
        expect(await askProxy("sk-x", "claude-x")).toEqual({ kind: "unauthorized" });
    });
});

// Drives the `setup()` command through the repo's spyOn seam pattern (mirroring compose.test.ts's
// "entry-point wiring" block): the runtime gate and the embedding step are stubbed, so no real
// container runtime is spawned and no real model is acquired. These assert design D9 — a preselected
// `--embeddings` mode is configured AHEAD of the runtime gate (so an air-gapped host with no ready
// runtime still configures embeddings), and the in-flow embedding step does not run a second time.
describe("setup() — preselected embeddings run ahead of the runtime gate", () => {
    const spies: { mockRestore: () => void }[] = [];

    beforeEach(() => {
        assertTestSandbox(env.configPath);
    });
    afterEach(() => {
        for (const s of spies.splice(0)) s.mockRestore();
        // setup() sets process.exitCode as a global side effect; reset so it never leaks to sibling tests.
        process.exitCode = 0;
        assertTestSandbox(env.configPath);
        rmSync(env.configPath, { force: true });
    });

    test("a preselected --embeddings mode is configured even when NO container runtime is ready", async () => {
        // mockImplementation (not mockResolvedValue) so the returned Result is consumed, per the neverthrow
        // must-use-result rule (same reasoning as compose.test.ts's wiring block).
        const embedSpy = spyOn(embeddingSetup, "runEmbeddingSetup").mockImplementation(async () => ok(undefined));
        const runtimeSpy = spyOn(container, "firstReadyRuntime").mockImplementation(async () => err(new container.ContainerRuntimeError("no usable runtime")));
        spies.push(embedSpy, runtimeSpy);

        await setup({ auth: false, start: false, force: false, postgres: true, embeddings: "local" });

        // The embedding step ran (hoisted ahead of the gate) with the preselected mode — configured despite
        // the dead runtime.
        expect(embedSpy).toHaveBeenCalledTimes(1);
        expect(embedSpy.mock.calls[0]).toEqual([process.stdin.isTTY, "local"]);
        // ...and setup still reports the missing runtime and takes the failure exit (the remainder genuinely
        // needs a runtime).
        expect(runtimeSpy).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBe(1);
    });

    test("with a ready runtime and a preselected mode, the embedding step runs exactly once", async () => {
        const embedSpy = spyOn(embeddingSetup, "runEmbeddingSetup").mockImplementation(async () => ok(undefined));
        spies.push(embedSpy);
        spies.push(spyOn(container, "firstReadyRuntime").mockImplementation(async () => ok(container.runtimes.docker)));
        // Stub the reference-data step so the full non-interactive flow reaches (and skips) the in-flow
        // embedding site without doing real reference provisioning.
        spies.push(spyOn(refsCommands, "runReferenceSetup").mockImplementation(async () => ok(undefined)));

        // postgres:false skips the compose/engine block (which would spawn a real runtime); the flow still
        // runs past the in-flow embedding site so its guard is exercised.
        await setup({ auth: false, start: false, force: false, postgres: false, embeddings: "local" });

        // Called exactly once — the preselected step ahead of the gate; the in-flow site is guarded and skipped.
        expect(embedSpy).toHaveBeenCalledTimes(1);
        expect(embedSpy.mock.calls[0]).toEqual([process.stdin.isTTY, "local"]);
    });
});

/** Write a setup-shaped proxy config carrying `key`, so `readApiKey` (which reads a REAL file) resolves. */
function writeProxyKey(key: string): void {
    assertTestSandbox(env.cliproxyConfigPath);
    mkdirSync(dirname(env.cliproxyConfigPath), { recursive: true });
    writeFileSync(env.cliproxyConfigPath, ["api-keys:", `  - "${key}"`, "port: 8317", ""].join("\n"));
}

// The election lives INSIDE resolveModelId, so the launch probe inherits it with no adaptation: a
// top-ranked candidate the credential cannot serve is walked past BEFORE the completion probe runs, so
// the probe verifies a model the credential can actually use. Global-fetch pattern (from models.test.ts)
// because the real /models → count_tokens → /messages path is under test.
describe("probeOnce — the election feeds the probe a servable model", () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        __resetModelCacheForTest();
        writeProxyKey("sk-probe");
    });
    afterEach(() => {
        globalThis.fetch = realFetch;
        __resetModelCacheForTest();
        assertTestSandbox(env.cliproxyConfigPath);
        rmSync(env.cliproxyConfigPath, { force: true });
    });

    test("an inaccessible top candidate is walked past, so the completion probe reads ok — not 'not verifiable'", async () => {
        // /models advertises two claude ids (newest ranks first by recency); the newest 404s the
        // count_tokens check, so the election walks to the older served one and the /messages completion 200s.
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            const target = String(url);
            if (target.endsWith("/messages/count_tokens")) {
                const model = JSON.parse(String(init?.body)).model;
                return model === "claude-new"
                    ? new Response(JSON.stringify({ error: { type: "not_found_error" } }), { status: 404 })
                    : new Response("{}", { status: 200 });
            }
            if (target.endsWith("/messages")) return new Response("{}", { status: 200 });
            return new Response(
                JSON.stringify({
                    data: [
                        { id: "claude-new", created: 200 },
                        { id: "claude-old", created: 100 },
                    ],
                }),
            );
        }) as unknown as typeof fetch;

        expect(await probeOnce()).toEqual({ kind: "ok" });
    });
});

// The launch gate's stale-pin warning: warn — NEVER block — when an explicitly-pinned model no longer
// serves. Driven through injected seams (no proxy, container, or real config). `warnStalePins` returns
// void, so it structurally cannot gate the launch it runs after; the assertions below only pin which
// pins are checked and which warn.
describe("warnStalePins", () => {
    function cliproxy(agents: ResolvedModelConnection["agents"] = {}, provider = "anthropic"): ResolvedModelConnection {
        return { mode: "cliproxy", provider, agents };
    }

    function run(connection: ResolvedModelConnection, modelPin: string | null, verdict: (id: string) => ModelAccess) {
        const checked: string[] = [];
        const warnings: string[] = [];
        const done = warnStalePins({
            connection,
            modelPin,
            check: async (id) => {
                checked.push(id);
                return verdict(id);
            },
            warn: (m) => warnings.push(m),
        });
        return { checked, warnings, done };
    }

    test("a not_found pin warns, naming the model and the agent that resolves to it", async () => {
        const r = run(cliproxy({ conversation: "claude-stale" }), null, () => "not_found");
        await r.done;
        expect(r.checked).toEqual(["claude-stale"]);
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]).toContain("claude-stale");
        expect(r.warnings[0]).toContain("conversation");
    });

    test("a served pin is silent", async () => {
        const r = run(cliproxy({ conversation: "claude-ok" }), null, () => "served");
        await r.done;
        expect(r.checked).toEqual(["claude-ok"]);
        expect(r.warnings).toEqual([]);
    });

    test("an inconclusive check is silent — only a definite verdict interrupts launch output", async () => {
        const r = run(cliproxy({ conversation: "claude-maybe" }), null, () => "inconclusive");
        await r.done;
        expect(r.checked).toEqual(["claude-maybe"]);
        expect(r.warnings).toEqual([]);
    });

    test("no pins → nothing is checked (auto-resolved sessions are untouched — election already validated)", async () => {
        const r = run(cliproxy({}), null, () => "not_found");
        await r.done;
        expect(r.checked).toEqual([]);
        expect(r.warnings).toEqual([]);
    });

    test("a non-anthropic connection is never checked (count_tokens is anthropic-protocol only)", async () => {
        const r = run(cliproxy({ conversation: "gpt-4o" }, "openai"), null, () => "not_found");
        await r.done;
        expect(r.checked).toEqual([]);
    });

    test("direct mode is never checked (a user's own endpoint is not ours to spend on validation)", async () => {
        const conn: ResolvedModelConnection = {
            mode: "direct",
            provider: "anthropic",
            baseURL: "http://localhost:1",
            protocol: "anthropic",
            agents: { conversation: "claude-x" },
        };
        const r = run(conn, null, () => "not_found");
        await r.done;
        expect(r.checked).toEqual([]);
    });

    test("a harness.model pin covers BOTH agents in one check and one warning", async () => {
        const r = run(cliproxy({}), "claude-both", () => "not_found");
        await r.done;
        expect(r.checked).toEqual(["claude-both"]); // one distinct id, checked once
        expect(r.warnings).toHaveLength(1);
        // The warning names every agent that resolves to the shared pin (not a hardcoded count word).
        expect(r.warnings[0]).toContain("conversation");
        expect(r.warnings[0]).toContain("sandbox");
    });

    test("an agent override redirects one agent, splitting harness.model into two distinct pins", async () => {
        // conversation → its override (claude-conv); sandbox → the harness.model fallback (claude-both).
        const r = run(cliproxy({ conversation: "claude-conv" }), "claude-both", () => "not_found");
        await r.done;
        expect(new Set(r.checked)).toEqual(new Set(["claude-conv", "claude-both"]));
        expect(r.warnings).toHaveLength(2);
    });
});

// The interactive setup default-model step, driven through injected seams (no clack, proxy, or TTY).
// Writes land in the sandboxed config; each test starts and ends from a clean config.
describe("selectDefaultModel", () => {
    beforeEach(() => {
        assertTestSandbox(env.configPath);
        rmSync(env.configPath, { force: true });
    });
    afterEach(() => {
        assertTestSandbox(env.configPath);
        rmSync(env.configPath, { force: true });
    });

    const writeBoth = (id: string) => writeAgentModel("conversation", id).andThen(() => writeAgentModel("sandbox", id));

    function deps(over: Partial<Parameters<typeof selectDefaultModel>[0]>): Parameters<typeof selectDefaultModel>[0] {
        return {
            isInteractive: () => true,
            candidates: async () => ["claude-a"],
            check: async () => "served",
            prompt: async () => ({ auto: true }),
            writeBoth,
            warn: () => {},
            ...over,
        };
    }

    /** Read back the persisted per-agent overrides; `models` is `unknown` in lib/config.ts (validated elsewhere). */
    function persistedAgents(): Record<string, string> | undefined {
        return (readConfig().models as { agents?: Record<string, string> } | undefined)?.agents;
    }

    test("accepting Auto writes nothing — the default stays adaptive", async () => {
        await selectDefaultModel(deps({ prompt: async () => ({ auto: true }) }));
        expect(readConfig().models).toBeUndefined();
    });

    test("an explicit pick pins BOTH user-facing agents to the chosen id", async () => {
        await selectDefaultModel(deps({ candidates: async () => ["claude-pick"], prompt: async () => ({ auto: false, modelId: "claude-pick" }) }));
        expect(persistedAgents()).toEqual({ conversation: "claude-pick", sandbox: "claude-pick" });
    });

    test("the offered list hides a not_found model but keeps an inconclusive one", async () => {
        let offered: string[] = [];
        await selectDefaultModel(
            deps({
                candidates: async () => ["claude-404", "claude-maybe"],
                check: async (id) => (id === "claude-404" ? "not_found" : "inconclusive"),
                prompt: async (_elected, models) => {
                    offered = models;
                    return { auto: true };
                },
            }),
        );
        expect(offered).toEqual(["claude-maybe"]);
    });

    test("the Auto recommendation is the first accessible candidate in rank order, past a not_found", async () => {
        let recommended = "";
        await selectDefaultModel(
            deps({
                candidates: async () => ["claude-404", "claude-newest", "claude-older"],
                check: async (id) => (id === "claude-404" ? "not_found" : "served"),
                prompt: async (electedId) => {
                    recommended = electedId;
                    return { auto: true };
                },
            }),
        );
        expect(recommended).toBe("claude-newest");
    });

    test("every candidate not_found → skip: nothing to recommend, no prompt, no write", async () => {
        let prompted = false;
        await selectDefaultModel(
            deps({
                candidates: async () => ["claude-404a", "claude-404b"],
                check: async () => "not_found",
                prompt: async () => {
                    prompted = true;
                    return { auto: true };
                },
            }),
        );
        expect(prompted).toBe(false);
        expect(readConfig().models).toBeUndefined();
    });

    test("a non-TTY skips the step entirely — no listing, no prompt, no write", async () => {
        let listed = false;
        let prompted = false;
        await selectDefaultModel(
            deps({
                isInteractive: () => false,
                candidates: async () => {
                    listed = true;
                    return ["claude-x"];
                },
                prompt: async () => {
                    prompted = true;
                    return { auto: true };
                },
            }),
        );
        expect(listed).toBe(false);
        expect(prompted).toBe(false);
        expect(readConfig().models).toBeUndefined();
    });

    test("a down/unreachable proxy (no candidates) skips gracefully — no prompt, no write", async () => {
        let prompted = false;
        await selectDefaultModel(
            deps({
                candidates: async () => [],
                prompt: async () => {
                    prompted = true;
                    return { auto: true };
                },
            }),
        );
        expect(prompted).toBe(false);
        expect(readConfig().models).toBeUndefined();
    });
});
