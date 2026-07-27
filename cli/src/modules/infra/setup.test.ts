import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { REFERENCE_DATA_CATALOG } from "@inflexa-ai/harness";
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
import { answerSpelling, type AnswerKey, type AnswerValueKey, type SetupAnswerFlags } from "./setup_answers.ts";
import * as compose from "./compose.ts";
import * as embeddingSetup from "../embedding/setup.ts";
import * as sandboxPullModule from "../libs/pull.ts";
import * as refsCommands from "../refs/commands.ts";
import * as refsStore from "../refs/store.ts";
import { detectedMachine, writeAgentModel, type ResolvedModelConnection } from "../harness/config.ts";
import { __resetModelCacheForTest, type ModelAccess } from "../proxy/models.ts";
import { readConfig, writeConfig } from "../../lib/config.ts";
import * as container from "../../lib/container.ts";
import * as cliPrompts from "../../lib/cli.ts";
// Namespace import beside the named one purely so `detectProviderEnv` is spyable at the seam setup.ts
// calls it through; `env` itself is a value the assertions read, so it stays a named import.
import * as envModule from "../../lib/env.ts";
import { EMBEDDING_API_KEY_VAR, env, type ProviderEnvSnapshot } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";

/** Build a provider-env snapshot for the adoption helpers; every field defaults to "absent". */
function snapshot(overrides: Partial<ProviderEnvSnapshot> = {}): ProviderEnvSnapshot {
    return { anthropicApiKeySet: false, anthropicBaseURL: undefined, openaiApiKeySet: false, openaiBaseURL: undefined, ...overrides };
}

/**
 * Two ids the reference catalog really declares, and one it cannot. Read off the LIVE catalog rather
 * than hardcoded, because setup now resolves an answered `--refs` id list against that catalog BEFORE
 * anything mutates (design D2): a hardcoded id that a catalog revision renames would fail these runs
 * upfront and report the wrong defect. The non-`null` assertions are safe because the catalog schema
 * requires a non-empty dataset list, and a catalog with fewer than two datasets would fail its own
 * validation long before this file loads.
 */
const CATALOG_ID = REFERENCE_DATA_CATALOG.datasets[0]!.id;
const OTHER_CATALOG_ID = REFERENCE_DATA_CATALOG.datasets[1]!.id;
/** Shaped like a plausible typo of a real id, which is exactly the mistake the upfront check exists to catch. */
const UNKNOWN_CATALOG_ID = "gtex-typo";

// generateApiKey + proxyConfig live in proxy_config.ts alongside writeProxyConfig; their unit tests
// live beside them in proxy_config.test.ts.

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
// container runtime is spawned and no real model is acquired. These assert design D9 — an ANSWERED
// embedding mode is configured AHEAD of the runtime gate (so an air-gapped host with no ready runtime
// still configures embeddings), and the in-flow embedding step does not run a second time.
describe("setup() — an answered embedding mode runs ahead of the runtime gate", () => {
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

    test("an answered --embeddings mode is configured even when NO container runtime is ready", async () => {
        // mockImplementation (not mockResolvedValue) so the returned Result is consumed, per the neverthrow
        // must-use-result rule (same reasoning as compose.test.ts's wiring block).
        const embedSpy = spyOn(embeddingSetup, "runEmbeddingSetup").mockImplementation(async () => ok(undefined));
        const runtimeSpy = spyOn(container, "firstReadyRuntime").mockImplementation(async () => err(new container.ContainerRuntimeError("no usable runtime")));
        spies.push(embedSpy, runtimeSpy);

        await setup({ auth: false, start: false, force: false, postgres: true, yes: true, flags: { embeddings: "local" } });

        // The embedding step ran (hoisted ahead of the gate) with the answered mode — configured despite
        // the dead runtime — and it receives the whole answer block, values included.
        expect(embedSpy).toHaveBeenCalledTimes(1);
        const [interactive, answers] = embedSpy.mock.calls[0]!;
        expect(interactive).toBe(false); // `--yes` withdraws the terminal, so the step may not prompt
        expect(answers?.mode).toBe("local");
        expect(answers?.validate).toBe(true);
        // ...and setup still reports the missing runtime and takes the failure exit (the remainder genuinely
        // needs a runtime).
        expect(runtimeSpy).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBe(1);
    });

    test("a config-file embedding mode (no flag) fires the same pre-gate", async () => {
        // The reorder is keyed on the RESOLVED answer, so the file front-end reaches it identically — the
        // regression this pins is a pre-gate that only ever looked at `--embeddings`.
        const dir = mkdtempSync(join(tmpdir(), "inflexa-answers-"));
        const answersPath = join(dir, "fleet.yml");
        writeFileSync(answersPath, "embedding:\n  mode: local\n");

        const embedSpy = spyOn(embeddingSetup, "runEmbeddingSetup").mockImplementation(async () => ok(undefined));
        const runtimeSpy = spyOn(container, "firstReadyRuntime").mockImplementation(async () => err(new container.ContainerRuntimeError("no usable runtime")));
        spies.push(embedSpy, runtimeSpy);

        await setup({ auth: false, start: false, force: false, postgres: true, yes: true, flags: { config: answersPath } });
        rmSync(dir, { recursive: true, force: true });

        expect(embedSpy).toHaveBeenCalledTimes(1);
        expect(embedSpy.mock.calls[0]![1]?.mode).toBe("local");
        expect(process.exitCode).toBe(1);
    });

    test("with a ready runtime and an answered mode, the embedding step runs exactly once", async () => {
        const embedSpy = spyOn(embeddingSetup, "runEmbeddingSetup").mockImplementation(async () => ok(undefined));
        spies.push(embedSpy);
        spies.push(spyOn(container, "firstReadyRuntime").mockImplementation(async () => ok(container.runtimes.docker)));
        // Stub the reference-data step so the full non-interactive flow reaches (and skips) the in-flow
        // embedding site without doing real reference provisioning.
        spies.push(spyOn(refsCommands, "runReferenceSetup").mockImplementation(async () => ok(undefined)));

        // postgres:false skips the compose/engine block (which would spawn a real runtime); the flow still
        // runs past the in-flow embedding site so its guard is exercised.
        await setup({ auth: false, start: false, force: false, postgres: false, yes: true, flags: { embeddings: "local" } });

        // Called exactly once — the answered step ahead of the gate; the in-flow site is guarded and skipped.
        expect(embedSpy).toHaveBeenCalledTimes(1);
        expect(embedSpy.mock.calls[0]![1]?.mode).toBe("local");
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
            promptManual: async () => null,
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

    test("no offerable list → manual entry: a served typed id pins BOTH agents", async () => {
        await selectDefaultModel(
            deps({
                candidates: async () => ["claude-404"],
                promptManual: async () => "claude-x",
                check: async (id) => (id === "claude-x" ? "served" : "not_found"),
            }),
        );
        expect(persistedAgents()).toEqual({ conversation: "claude-x", sandbox: "claude-x" });
    });

    test("no offerable list → manual entry declined keeps Auto — nothing persisted", async () => {
        await selectDefaultModel(
            deps({
                candidates: async () => [],
                promptManual: async () => null,
            }),
        );
        expect(readConfig().models).toBeUndefined();
    });

    test("nothing servable → a manually typed not_found id is rejected — warns, keeps Auto", async () => {
        const warnings: string[] = [];
        await selectDefaultModel(
            deps({
                candidates: async () => ["claude-404"],
                promptManual: async () => "bad",
                check: async () => "not_found",
                warn: (m) => warnings.push(m),
            }),
        );
        expect(readConfig().models).toBeUndefined();
        expect(warnings.length).toBe(1);
    });

    // An unanswered listing means the same round-trip would only time out again on the typed id, and its
    // `inconclusive` verdict persists anyway — so the id is trusted rather than bought with a silent wait.
    test("an unavailable listing trusts the typed id — no second check, still pins BOTH agents", async () => {
        const checked: string[] = [];
        await selectDefaultModel(
            deps({
                candidates: async () => [],
                promptManual: async () => "claude-unlisted",
                check: async (id) => {
                    checked.push(id);
                    return "not_found";
                },
            }),
        );
        expect(checked).toEqual([]);
        expect(persistedAgents()).toEqual({ conversation: "claude-unlisted", sandbox: "claude-unlisted" });
    });

    test("a sweep that rules out EVERY candidate also routes to manual entry", async () => {
        let manualCalled = false;
        let listPrompted = false;
        await selectDefaultModel(
            deps({
                candidates: async () => ["claude-404a", "claude-404b"],
                check: async () => "not_found",
                prompt: async () => {
                    listPrompted = true;
                    return { auto: true };
                },
                promptManual: async () => {
                    manualCalled = true;
                    return null;
                },
            }),
        );
        expect(manualCalled).toBe(true);
        expect(listPrompted).toBe(false);
        expect(readConfig().models).toBeUndefined();
    });

    // The reason drives what setup TELLS the user before prompting (a proxy that never answered vs an
    // account that can serve nothing it lists), so the two causes must stay distinguishable at the seam.
    test("manual entry is told WHY there is no list — unanswered listing vs nothing servable", async () => {
        const reasons: string[] = [];
        const record = deps({
            promptManual: async (reason) => {
                reasons.push(reason);
                return null;
            },
        });
        await selectDefaultModel({ ...record, candidates: async () => [] });
        await selectDefaultModel({ ...record, candidates: async () => ["claude-404"], check: async () => "not_found" });
        expect(reasons).toEqual(["listing-unavailable", "none-servable"]);
    });
});

// The batch orchestrator, end to end through `setup()`. Everything that would touch a container
// engine, the network, or a real model download is a seam: `firstReadyRuntime`/`ensureReady` (the
// runtime gate), `runEmbeddingSetup`, `runReferenceSetup`, `sandboxPull`, the compose writer, and
// `globalThis.fetch` for the validation probes. What is deliberately NOT stubbed is the writing —
// every assertion below reads the REAL sandboxed `config.json` back, because "the answers changed
// where values come from, never where they go" is the property under test.
describe("setup() — batch orchestration", () => {
    const realFetch = globalThis.fetch;
    const spies: { mockRestore: () => void }[] = [];
    let firstReady: ReturnType<typeof spyOn<typeof container, "firstReadyRuntime">>;
    let embedStep: ReturnType<typeof spyOn<typeof embeddingSetup, "runEmbeddingSetup">>;
    let refsStep: ReturnType<typeof spyOn<typeof refsCommands, "runReferenceSetup">>;

    /** Serve per-route responses keyed by URL suffix; an unmapped route 404s (mirrors probeCredentialSource's own tests). */
    function routeFetch(routes: Record<string, () => Response>): void {
        globalThis.fetch = ((url: string | URL) => {
            const target = String(url);
            const route = Object.keys(routes).find((suffix) => target.endsWith(suffix));
            return Promise.resolve(route !== undefined ? routes[route]!() : new Response(null, { status: 404 }));
        }) as unknown as typeof fetch;
    }

    /**
     * Run `setup()` with stdout captured and returned. clack writes every notice, log line, and note
     * through `process.stdout.write`, so this both quiets the suite and makes the batch-only notices
     * (the pre-staging line, the `--no-validate` escape) assertable.
     */
    async function runSetup(options: Parameters<typeof setup>[0]): Promise<string> {
        const chunks: string[] = [];
        const write = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
            chunks.push(String(chunk));
            return true;
        });
        try {
            await setup(options);
        } finally {
            write.mockRestore();
        }
        return chunks.join("");
    }

    /**
     * `setup()` reports its pre-`intro()` refusals through `console.error` (it is refusing before the
     * clack session opens, or before the first mutation), so the stdout capture `runSetup` installs does
     * not see them. Collect that channel too, for the tests that assert the message as well as the exit
     * code.
     */
    async function runCapturingStderr(options: Parameters<typeof setup>[0]): Promise<string> {
        const errors: string[] = [];
        const consoleError = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            errors.push(args.map(String).join(" "));
        });
        try {
            await runSetup(options);
        } finally {
            consoleError.mockRestore();
        }
        return errors.join("\n");
    }

    /** The batch invocation shape every test below shares: no containers started, no images pulled. */
    function batch(flags: NonNullable<Parameters<typeof setup>[0]["flags"]>, over: Partial<Parameters<typeof setup>[0]> = {}) {
        return { auth: true, start: false, force: false, postgres: false, yes: true, flags, ...over };
    }

    /** A direct connection answered end to end, plus a token-free credential source to validate. */
    const directFlags = {
        connection: "direct",
        baseUrl: "https://gw.corp/v1",
        provider: "anthropic",
        model: "m-1",
        // A real, deterministic command — the probe genuinely runs it, so nothing here mocks the mint.
        // The format string is deliberate: the MINTED token (`tok_123`) is nowhere in the command TEXT,
        // so "the token never reaches config" is assertable against the whole config document.
        authCommand: "printf tok%s _123",
        authScheme: "x-api-key",
    } as const;

    beforeEach(() => {
        assertTestSandbox(env.configPath);
        assertTestSandbox(env.cliproxyConfigPath);
        assertTestSandbox(env.cliproxyAuthDir);
        rmSync(env.configPath, { force: true });
        rmSync(env.cliproxyConfigPath, { force: true });
        rmSync(env.cliproxyAuthDir, { recursive: true, force: true });
        process.exitCode = 0;

        firstReady = spyOn(container, "firstReadyRuntime").mockImplementation(async () => ok(container.runtimes.docker));
        embedStep = spyOn(embeddingSetup, "runEmbeddingSetup").mockImplementation(async () => ok(undefined));
        refsStep = spyOn(refsCommands, "runReferenceSetup").mockImplementation(async () => ok(undefined));
        spies.push(firstReady, embedStep, refsStep);
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        for (const s of spies.splice(0)) s.mockRestore();
        process.exitCode = 0;
        assertTestSandbox(env.configPath);
        rmSync(env.configPath, { force: true });
        rmSync(env.cliproxyConfigPath, { force: true });
        rmSync(env.cliproxyAuthDir, { recursive: true, force: true });
    });

    /** `readConfig().models` is `unknown` (validated downstream); read it as a record to inspect the writes. */
    function models(): Record<string, unknown> | undefined {
        return readConfig().models as Record<string, unknown> | undefined;
    }

    test("bare `--yes` takes every default: cliproxy, no model pin, no downloads, embeddings untouched, exit 0", async () => {
        const output = await runSetup(batch({}));

        expect(process.exitCode).toBe(0);
        // No model was answered, so nothing is pinned and the launch election stays adaptive (Auto).
        expect(models()).toBeUndefined();
        // The embedding step ran with NO mode answer, which leaves the configured backend unchanged.
        expect(embedStep.mock.calls[0]![1]?.mode).toBeUndefined();
        // No reference selection was named, so nothing is downloaded — the value IS the consent.
        expect(refsStep.mock.calls[0]![0].selection).toBeUndefined();
        expect(refsStep.mock.calls[0]![0].interactive).toBe(false);
        // The sandbox image is never pulled implicitly; the hint names the explicit command instead.
        expect(output).toContain("inflexa sandbox pull");
        // Pre-staging (design D10): no credential in the auth dir is a NOTICE plus a successful run —
        // the remaining steps still ran (refs above) and the exit code stays 0.
        expect(output).toContain("first `inflexa` launch");
    });

    describe("a step switched OFF consumes no answers", () => {
        test("--no-postgres refuses an answered postgres field rather than dropping it", async () => {
            const errors = await runCapturingStderr(batch({ postgresPort: "6000", postgresUser: "fleet" }, { postgres: false }));

            expect(process.exitCode).toBe(1);
            expect(errors).toContain("--no-postgres");
            expect(errors).toContain("`postgres.port`");
            expect(errors).toContain("`postgres.user`");
            // Refused BEFORE the runtime probe, so nothing about the machine was touched.
            expect(firstReady).not.toHaveBeenCalled();
        });

        test("--no-auth refuses an answered cliproxy provider rather than dropping it", async () => {
            // Interactive: batch cliproxy rejects a provider answer upfront (the sign-in needs a browser),
            // so the stranding this guards is only reachable on a run that COULD have signed in. The
            // answered mode means no prompt is reached before the refusal.
            const wasTTY = process.stdin.isTTY;
            Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
            try {
                const errors = await runCapturingStderr({
                    auth: false,
                    start: false,
                    force: false,
                    postgres: false,
                    flags: { connection: "cliproxy", provider: "claude" },
                });

                expect(process.exitCode).toBe(1);
                expect(errors).toContain("--no-auth");
                expect(errors).toContain("`--provider` / `connection.provider`");
            } finally {
                Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
            }
        });

        test("--no-auth alone is untouched — it is only an answer that has nowhere to land that fails", async () => {
            const output = await runSetup(batch({}, { auth: false }));

            expect(process.exitCode).toBe(0);
            expect(output).toContain("Setup complete");
        });
    });

    test("batch direct persists the connection, the credential source, and the model from answers", async () => {
        routeFetch({
            "/models": () => Response.json({ data: [{ id: "m-1" }] }),
            "/messages": () => Response.json({ type: "message" }),
        });

        await runSetup(batch({ ...directFlags }));

        expect(process.exitCode).toBe(0);
        // Written by the same writer the wizard uses, from the extracted answers — and carrying no token.
        expect(models()?.connection).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://gw.corp/v1",
            auth: { kind: "command", command: "printf tok%s _123", scheme: "x-api-key" },
        });
        // A batch model answer pins BOTH user-facing agents.
        expect(models()?.agents).toEqual({ conversation: "m-1", sandbox: "m-1" });
        // Token-free by construction: the source was RUN (the probe minted `tok_123` and sent it), and
        // only the command + scheme were written.
        expect(JSON.stringify(readConfig())).not.toContain("tok_123");
    });

    test("a resolver error fails BEFORE any mutation — no config, no proxy config, no step ran", async () => {
        // `--connection direct` under batch without baseURL/provider/model: three upfront errors.
        await runSetup(batch({ connection: "direct" }));

        expect(process.exitCode).toBe(1);
        expect(existsSync(env.configPath)).toBe(false);
        expect(existsSync(env.cliproxyConfigPath)).toBe(false);
        // The three earliest mutators are all downstream of the resolver, and none of them ran.
        expect(embedStep).not.toHaveBeenCalled();
        expect(firstReady).not.toHaveBeenCalled();
        expect(refsStep).not.toHaveBeenCalled();
    });

    test("an ambiguous credential-source probe fails the run and persists nothing", async () => {
        // The enterprise-gateway shape: no listing route, and a non-standard 500 for the test message.
        routeFetch({
            "/models": () => new Response(null, { status: 404 }),
            "/messages": () => new Response("invalid token", { status: 500 }),
        });

        const output = await runSetup(batch({ ...directFlags }));

        expect(process.exitCode).toBe(1);
        // Batch has no save-anyway confirm, so an unclassifiable answer is as fatal as a rejection —
        // and the connection write happens only after this validation, so nothing landed.
        expect(models()).toBeUndefined();
        expect(output).toContain("--no-validate");
    });

    // Design D1: the answered model's 1-token validation runs BEFORE `writeDirectConnection`, so a
    // rejected id costs the operator an error message and nothing else. The assertion is on the config
    // FILE's bytes rather than on the absence of `models.agents`, because the defect this replaces was
    // precisely a run that pinned no model and still left a `models.connection` behind — a client that
    // boots into `model_required`, the state the batch model requirement exists to prevent.
    describe("a rejected batch direct model leaves config.json untouched", () => {
        /**
         * Pin the runtime BEFORE the run so the runtime write (the one legitimate mutation that precedes
         * the direct path) is a no-op and the whole file becomes comparable. `readConfig()` supplies the
         * schema-shaped rest, so the seeded document is exactly what `writeConfig` would have produced.
         */
        function seedPinnedRuntime(): string {
            writeConfig({ ...readConfig(), runtime: "docker" })._unsafeUnwrap();
            return readFileSync(env.configPath, "utf8");
        }

        test("a definite model-not-found writes nothing — neither a connection nor a pin", async () => {
            // The credential itself validates (2xx listing); the model's own ping is definitively rejected.
            routeFetch({
                "/models": () => Response.json({ data: [{ id: "m-1" }] }),
                "/messages": () => Response.json({ error: { type: "not_found_error", message: "model m-1 not found" } }, { status: 404 }),
            });
            const before = seedPinnedRuntime();

            const output = await runSetup(batch({ ...directFlags }));

            expect(process.exitCode).toBe(1);
            expect(readFileSync(env.configPath, "utf8")).toBe(before);
            expect(models()).toBeUndefined();
            expect(output).toContain("m-1");
        });

        test("an unclassifiable model validation is equally fatal, and equally write-free", async () => {
            // Batch has no save-anyway confirm, so an outcome nobody can classify fails exactly like a
            // rejection — and, per D1, at the same point: before anything is persisted.
            routeFetch({
                "/models": () => Response.json({ data: [{ id: "m-1" }] }),
                "/messages": () => new Response("gateway says no", { status: 500 }),
            });
            const before = seedPinnedRuntime();

            const output = await runSetup(batch({ ...directFlags }));

            expect(process.exitCode).toBe(1);
            expect(readFileSync(env.configPath, "utf8")).toBe(before);
            expect(output).toContain("--no-validate");
        });
    });

    test("`--no-validate` persists the same answers with no probe at all", async () => {
        // Any fetch here would be a bug: the escape skips the NETWORK probes, and there are no others
        // on this path (the offline GGUF verification lives in the embedding step).
        globalThis.fetch = (() => {
            throw new Error("no network call should be made under --no-validate");
        }) as unknown as typeof fetch;

        await runSetup(batch({ ...directFlags }, { validate: false }));

        expect(process.exitCode).toBe(0);
        expect(models()?.agents).toEqual({ conversation: "m-1", sandbox: "m-1" });
        expect((models()?.connection as Record<string, unknown>).auth).toEqual({ kind: "command", command: "printf tok%s _123", scheme: "x-api-key" });
    });

    test("a second identical batch run converges to a byte-identical config", async () => {
        routeFetch({
            "/models": () => Response.json({ data: [{ id: "m-1" }] }),
            "/messages": () => Response.json({ type: "message" }),
        });

        await runSetup(batch({ ...directFlags }));
        const first = readFileSync(env.configPath, "utf8");
        await runSetup(batch({ ...directFlags }));
        const second = readFileSync(env.configPath, "utf8");

        expect(process.exitCode).toBe(0);
        expect(second).toBe(first);
        // Each run drives each step exactly once — the pre-gate/in-flow embedding guard holds across runs.
        expect(embedStep).toHaveBeenCalledTimes(2);
        expect(refsStep).toHaveBeenCalledTimes(2);
    });

    test("a POSTGRES-PROVISIONING run converges byte-identically, proxy config and minted key included", async () => {
        // The direct-mode idempotency case above exercises none of the writers a real fleet provision
        // uses. This one turns them all on: the rebuilt `postgres` block (persist-only-explicit), the
        // resource budget, and — cliproxy mode — the proxy config with its once-minted client key, which
        // a second run must find and leave alone rather than re-mint.
        //
        // The headline assertion is on BYTES from the very first run, which is what makes it a real
        // idempotency check: the second run starts from a document containing `harness` (created by the
        // first run's resource write) while the first started from one without it, so the two spreads
        // insert that key at different positions. `writeConfig` emits a canonical, schema-derived key
        // order precisely so that difference cannot reach the file.
        spies.push(spyOn(compose, "composeAvailable").mockImplementation(async () => true));
        spies.push(spyOn(compose, "writeComposeFile").mockImplementation(() => ok(undefined)));
        // Batch cliproxy with no model answer asks the proxy nothing, so any fetch here is a defect.
        globalThis.fetch = (() => {
            throw new Error("a postgres-provisioning batch run should make no network call");
        }) as unknown as typeof fetch;

        const flags = { postgresPassword: "s3cret", postgresPort: "6000", resourceShare: "40" } as const;
        await runSetup(batch(flags, { postgres: true }));
        const firstConfig = readFileSync(env.configPath, "utf8");
        const firstProxyConfig = readFileSync(env.cliproxyConfigPath, "utf8");

        await runSetup(batch(flags, { postgres: true }));

        expect(process.exitCode).toBe(0);
        expect(readFileSync(env.configPath, "utf8")).toBe(firstConfig);
        // The minted client key is read back, never re-minted.
        expect(readFileSync(env.cliproxyConfigPath, "utf8")).toBe(firstProxyConfig);
        // Sanity on WHAT converged: an empty document would satisfy the comparisons just as well.
        expect(readConfig().postgres).toEqual({ password: "s3cret", port: 6000 });
        expect((readConfig().harness as { resourceLimits?: { budget?: unknown } }).resourceLimits?.budget).toBeDefined();
    });

    // Design D2: an answered `--refs` id list is resolved against the OFFERED catalog immediately after
    // answer resolution — before the embedding pre-gate, the runtime pin, the proxy config, and the
    // download. Before this, a typo'd id surfaced at download time, second-to-last step, on a machine
    // that had already been provisioned.
    describe("reference ids validate before any mutation", () => {
        test("an unknown id fails naming both spellings and the id, with nothing mutated", async () => {
            const errors = await runCapturingStderr(batch({ refs: `${CATALOG_ID},${UNKNOWN_CATALOG_ID}` }));

            expect(process.exitCode).toBe(1);
            expect(errors).toContain("`--refs` / `refs`");
            expect(errors).toContain(UNKNOWN_CATALOG_ID);
            // The valid sibling is not reported — only what the operator has to fix.
            expect(errors).not.toContain(`\`${CATALOG_ID}\``);
            // No config write, no container command, no download: every mutator sits downstream of this.
            expect(existsSync(env.configPath)).toBe(false);
            expect(existsSync(env.cliproxyConfigPath)).toBe(false);
            expect(embedStep).not.toHaveBeenCalled();
            expect(firstReady).not.toHaveBeenCalled();
            expect(refsStep).not.toHaveBeenCalled();
        });

        test("an already-installed id is a valid answer — the second run of the same command passes", async () => {
            // The offered catalog EXCLUDES what is installed, so resolving against it alone would make
            // `--refs <id>` fail on the very datasets its own first run installed. Stubbing the store
            // inspection is how a "second run" is expressed without a multi-gigabyte download.
            spies.push(
                spyOn(refsStore, "inspectReferenceStore").mockImplementation(async () =>
                    ok({
                        exists: true,
                        datasets: REFERENCE_DATA_CATALOG.datasets.map((dataset) => ({
                            dataset,
                            state: dataset.id === CATALOG_ID ? ("installed" as const) : ("missing" as const),
                        })),
                        userContent: [],
                    }),
                ),
            );

            await runSetup(batch({ refs: CATALOG_ID }));

            expect(process.exitCode).toBe(0);
            expect(refsStep.mock.calls[0]![0].selection).toEqual({ ids: [CATALOG_ID] });
        });

        test("a valid id list lets the run continue — the answered sandbox pull still happens", async () => {
            const pull = spyOn(sandboxPullModule, "sandboxPull").mockImplementation(async () =>
                ok({ type: "pulled" as const, variant: "python" as const, image: "ghcr.io/x/sandbox-python:latest" }),
            );
            spies.push(pull);

            await runSetup(batch({ refs: `${CATALOG_ID},${OTHER_CATALOG_ID}`, sandbox: "python" }));

            expect(process.exitCode).toBe(0);
            expect(refsStep.mock.calls[0]![0].selection).toEqual({ ids: [CATALOG_ID, OTHER_CATALOG_ID] });
            expect(pull.mock.calls[0]![0]).toEqual({ variant: "python", yes: true });
        });
    });

    test("a mode-carrying flag superseding the file's leaves prints the note naming each dropped key", async () => {
        // Design D5, at the orchestration level: the resolver produces the advisory as DATA, and this is
        // the layer that has to RENDER it — an unrendered note turns the documented per-machine override
        // (`--config fleet.yml --embeddings off`) back into a silent drop.
        const dir = mkdtempSync(join(tmpdir(), "inflexa-answers-"));
        const answersPath = join(dir, "fleet.yml");
        writeFileSync(answersPath, "embedding:\n  mode: api-key\n  baseURL: https://embeds.internal/v1\n  model: text-embedding-3-large\n");

        const output = await runSetup(batch({ config: answersPath, embeddings: "off" }));
        rmSync(dir, { recursive: true, force: true });

        expect(process.exitCode).toBe(0);
        expect(output).toContain("--embeddings off");
        expect(output).toContain("embedding.baseURL");
        expect(output).toContain("embedding.model");
        // The flag won, and the file's now-moot leaves reached no writer.
        expect(embedStep.mock.calls[0]![1]?.mode).toBe("off");
        expect(embedStep.mock.calls[0]![1]?.baseURL).toBeUndefined();
        expect(embedStep.mock.calls[0]![1]?.model).toBeUndefined();
    });

    // The batch cliproxy model PIN, which is deliberately asymmetric to the direct-endpoint validation:
    // only a definite not-found fails, because a pre-staged proxy has no credential loaded and its check
    // is inconclusive by construction — failing on that would make pre-staging impossible.
    describe("the answered cliproxy model pin", () => {
        test("a definite not-found fails the run naming the model, and pins nothing", async () => {
            routeFetch({
                "/messages/count_tokens": () => Response.json({ error: { type: "not_found_error" } }, { status: 404 }),
            });

            const output = await runSetup(batch({ model: "claude-nope" }));

            expect(process.exitCode).toBe(1);
            expect(output).toContain("claude-nope");
            expect(models()?.agents).toBeUndefined();
        });

        test("an inconclusive check proceeds and pins BOTH agents", async () => {
            // Every route 404s with an unparseable body — exactly what an unauthenticated pre-staged proxy
            // answers, and what `checkModelAccess` classifies as `inconclusive` rather than a verdict.
            routeFetch({});

            await runSetup(batch({ model: "claude-maybe" }));

            expect(process.exitCode).toBe(0);
            expect(models()?.agents).toEqual({ conversation: "claude-maybe", sandbox: "claude-maybe" });
        });
    });

    test("`--yes --no-auth` provisions the stack without printing the sign-in notice", async () => {
        // The auth dir is empty (the beforeEach removes it), which is exactly the state that earns the
        // pre-staging notice on a normal batch run — so its absence here can only be the `--no-auth` gate.
        const output = await runSetup(batch({}, { auth: false }));

        expect(process.exitCode).toBe(0);
        expect(output).toContain("Setup complete");
        expect(output).not.toContain("Provider sign-in pending");
        expect(output).not.toContain("first `inflexa` launch");
        // The step being silent is not the step being skipped: the stack is still provisioned.
        expect(existsSync(env.cliproxyConfigPath)).toBe(true);
    });

    test("a fully non-interactive run prints no prompt-shaped banner for a step that cannot prompt", async () => {
        const output = await runSetup(batch({ resourceShare: "40" }));

        expect(process.exitCode).toBe(0);
        // The allowance is still reported — as a statement about the machine, not an instruction to a
        // reader who is never going to be asked anything.
        expect(output).toContain("Analysis resource allowance");
        expect(output).not.toContain("Configure the analysis resource allowance");
    });

    test("an answered runtime is a hard gate: probed alone, never switched away from", async () => {
        // Podman is answered and dead while Docker is ready — the fallback must NOT rescue it, or one
        // fleet member would silently provision on a different engine than its siblings.
        spies.push(
            spyOn(container, "ensureReady").mockImplementation(async (rt) =>
                rt.id === "docker" ? ok(undefined) : err(new container.ContainerRuntimeError("Podman is installed but not ready.")),
            ),
        );

        await runSetup(batch({ runtime: "podman" }));

        expect(process.exitCode).toBe(1);
        expect(firstReady).not.toHaveBeenCalled();
        expect(existsSync(env.configPath)).toBe(false);
    });

    test("an answered runtime that IS ready is persisted like a detected choice", async () => {
        spies.push(spyOn(container, "ensureReady").mockImplementation(async () => ok(undefined)));

        await runSetup(batch({ runtime: "podman" }));

        expect(process.exitCode).toBe(0);
        expect(readConfig().runtime).toBe("podman");
        expect(firstReady).not.toHaveBeenCalled();
    });

    test("an answered sandbox variant pulls without a size confirmation", async () => {
        const pull = spyOn(sandboxPullModule, "sandboxPull").mockImplementation(async () =>
            ok({ type: "pulled" as const, variant: "python" as const, image: "ghcr.io/x/sandbox-python:latest" }),
        );
        spies.push(pull);

        await runSetup(batch({ sandbox: "python" }));

        expect(process.exitCode).toBe(0);
        // The ANSWER is the multi-GB consent, so `yes` rides the call and no confirm is reached.
        expect(pull.mock.calls[0]![0]).toEqual({ variant: "python", yes: true });
    });

    test("an answered resource share persists the machine-relative absolute budget", async () => {
        await runSetup(batch({ resourceShare: "50" }));

        const machine = detectedMachine();
        const harness = readConfig().harness as { resourceLimits?: { budget?: unknown } } | undefined;
        expect(harness?.resourceLimits?.budget).toEqual({
            cpu: Math.max(1, Math.floor((machine.cpu * 50) / 100)),
            memoryGb: Math.max(1, Math.floor((machine.memoryGb * 50) / 100)),
        });
    });

    test("answered Postgres fields persist through the persist-only-explicit filter; unanswered batch persists nothing", async () => {
        // The compose layer is a seam here: this test is about which ANSWERS land in config.json, and
        // `--no-start`/`--no-force` already keep every engine command out of the run.
        spies.push(spyOn(compose, "composeAvailable").mockImplementation(async () => true));
        spies.push(spyOn(compose, "writeComposeFile").mockImplementation(() => ok(undefined)));

        await runSetup(batch({ postgresPassword: "s3cret" }, { postgres: true }));
        // Only the field that DIFFERS from its default is written — the accepted defaults stay unfrozen.
        expect(readConfig().postgres).toEqual({ password: "s3cret" });

        rmSync(env.configPath, { force: true });
        await runSetup(batch({}, { postgres: true }));
        // Unanswered batch resolves the current configuration silently and writes no `postgres` block.
        expect(readConfig().postgres).toBeUndefined();
    });

    // The precedence rule's INTERACTIVE half: "a supplied answer SHALL skip its prompt even in an
    // interactive run, so a partially-filled config file composes with prompts for the remaining
    // questions." The batch cases above cannot see it — batch has no prompts to skip — so these flip the
    // TTY on and assert on which questions were actually asked. Every prompt seam is stubbed, so a
    // question that WAS reached shows up as a recorded label rather than a hung suite.
    describe("an answer skips exactly its own prompt on an interactive run", () => {
        let wasTTY: boolean | undefined;
        let prompts: string[];
        let selects: string[];

        beforeEach(() => {
            wasTTY = process.stdin.isTTY;
            Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
            prompts = [];
            selects = [];
            spies.push(
                spyOn(cliPrompts, "promptText").mockImplementation(async (message: string, opts?: { defaultValue?: string }) => {
                    prompts.push(message);
                    // Accept the pre-fill wherever there is one (what "press Enter" does), and type
                    // `openai` where there is not — the only such prompt these flows reach is the provider
                    // slug, and an openai-compatible connection keeps the anthropic-only credential-helper
                    // offer (which reads the developer's REAL ~/.claude settings) out of the run.
                    return opts?.defaultValue ?? "openai";
                }),
                spyOn(cliPrompts, "select").mockImplementation(async (message: string, options: { value: string; label: string }[]) => {
                    selects.push(message);
                    // The first option is each of these selects' documented default ("infer", "cliproxy").
                    return options[0]!.value;
                }),
                spyOn(sandboxPullModule, "sandboxPull").mockImplementation(async () => ok({ type: "declined" as const })),
            );
            // The interactive default-model step lists models off the proxy; every route 404s, so the
            // candidate list is empty and the step skips without a prompt (its own tests cover the rest).
            globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 404 }))) as unknown as typeof fetch;
        });

        afterEach(() => {
            Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
        });

        /** An interactive invocation: no `--yes`, and the TTY the surrounding `beforeEach` installed. */
        function interactive(flags: NonNullable<Parameters<typeof setup>[0]["flags"]>, over: Partial<Parameters<typeof setup>[0]> = {}) {
            return { auth: false, start: false, force: false, postgres: false, flags, ...over };
        }

        /** Whether any recorded prompt/select message contains `fragment` — the labels are the observable. */
        function asked(messages: readonly string[], fragment: string): boolean {
            return messages.some((message) => message.includes(fragment));
        }

        test("`--postgres-password` skips ONLY the password prompt — user and port are still asked", async () => {
            spies.push(spyOn(compose, "composeAvailable").mockImplementation(async () => true));
            spies.push(spyOn(compose, "writeComposeFile").mockImplementation(() => ok(undefined)));

            await runSetup(interactive({ connection: "cliproxy", postgresPassword: "s3cret" }, { postgres: true }));

            expect(process.exitCode).toBe(0);
            expect(asked(prompts, "Password")).toBe(false);
            expect(asked(prompts, "Username")).toBe(true);
            expect(asked(prompts, "Port")).toBe(true);
            // The answer still landed, through the same persist-only-explicit writer the prompt feeds.
            expect(readConfig().postgres).toEqual({ password: "s3cret" });
        });

        test("promptManualDirectConnection asks only for what is still open", async () => {
            await runSetup(
                interactive({ connection: "direct", baseUrl: "https://gw.corp/v1", protocol: "openai-compatible", model: "m-1" }, { validate: false }),
            );

            expect(process.exitCode).toBe(0);
            expect(asked(prompts, "Provider slug")).toBe(true);
            expect(asked(prompts, "Model endpoint URL")).toBe(false);
            // An answered model takes the persist path, not the wizard's collect-and-re-prompt loop.
            expect(asked(prompts, "Model id the endpoint serves")).toBe(false);
            // The connection mode and the wire protocol were both answered, so no select ran at all.
            expect(selects).toEqual([]);
            expect(models()?.connection).toEqual({ mode: "direct", provider: "openai", baseURL: "https://gw.corp/v1", protocol: "openai-compatible" });
            expect(models()?.agents).toEqual({ conversation: "m-1", sandbox: "m-1" });
        });

        test("an answered `--base-url` suppresses the ecosystem-adoption ladder entirely", async () => {
            // A machine set up for the Anthropic SDK: without an answer, setup would OFFER to adopt this
            // environment. With one, offering to replace the endpoint the operator just declared is how an
            // answer gets silently overwritten — so the detection must not even be consulted.
            const detect = spyOn(envModule, "detectProviderEnv").mockImplementation(() =>
                snapshot({ anthropicApiKeySet: true, anthropicBaseURL: "https://api.anthropic.com" }),
            );
            spies.push(detect);

            await runSetup(interactive({ connection: "direct", baseUrl: "https://gw.corp/v1", model: "m-1" }, { validate: false }));

            expect(process.exitCode).toBe(0);
            expect(detect).not.toHaveBeenCalled();
            // The only select left is the wire-protocol question, which nothing answered.
            expect(selects).toEqual(["Wire protocol"]);
            // The answered endpoint survived — not the adoptable https://api.anthropic.com/v1.
            expect((models()?.connection as Record<string, unknown>).baseURL).toBe("https://gw.corp/v1");
        });
    });

    // THE INVARIANT: every answer this CLI accepts reaches a destination the run can be observed at.
    //
    // The defect class this pins is an answer that PARSES, VALIDATES, and is then never consumed by the
    // orchestrator — `setup` exits 0 having silently ignored what the operator asked for. It is invisible
    // to both existing layers of test: setup_answers.test.ts proves a flag turns into an ANSWER, and the
    // orchestration cases above spot-check the handful of answers whose wiring someone thought to assert.
    // Neither can catch the NEXT one, because nothing asserted the set was complete.
    //
    // So the table below is keyed on `AnswerKey` — `satisfies Record<AnswerKey, AnswerCase>` makes a
    // missing entry a compile error — AND the completeness test re-derives the key set from the source at
    // runtime, so an entry dropped alongside a `@ts-expect-error`-style silencing of that compile error
    // still fails. Each entry then RUNS `setup()` under batch with that answer supplied, and asserts the
    // observable effect: what landed in the real sandboxed config.json, or what the stubbed step was
    // handed. Both front-ends are exercised — a `file:` entry answers through a `--config` YAML document
    // instead of argv — because an answer can be dropped on one path while landing on the other.
    describe("every answer reaches its destination", () => {
        let answersDir: string;
        let pullStep: ReturnType<typeof spyOn<typeof sandboxPullModule, "sandboxPull">>;
        let composeWriter: ReturnType<typeof spyOn<typeof compose, "writeComposeFile">>;

        beforeEach(() => {
            answersDir = mkdtempSync(join(tmpdir(), "inflexa-answers-"));
            pullStep = spyOn(sandboxPullModule, "sandboxPull").mockImplementation(async () =>
                ok({ type: "pulled" as const, variant: "python-r" as const, image: "ghcr.io/x/sandbox-python-r:latest" }),
            );
            composeWriter = spyOn(compose, "writeComposeFile").mockImplementation(() => ok(undefined));
            spies.push(
                pullStep,
                composeWriter,
                spyOn(compose, "composeAvailable").mockImplementation(async () => true),
                spyOn(container, "ensureReady").mockImplementation(async () => ok(undefined)),
            );
            // Every case here is hermetic BY CONSTRUCTION — batch cliproxy never lists models, and the
            // direct cases run under `--no-validate` — so a fetch reaching this stub is a defect in the
            // flow, not a missing route. Restored by the outer afterEach.
            globalThis.fetch = (() => {
                throw new Error("an answer-coverage case must make no network call");
            }) as unknown as typeof fetch;
        });

        afterEach(() => {
            rmSync(answersDir, { recursive: true, force: true });
        });

        /** Everything one `setup()` run exposes to an assertion: the REAL config on disk, plus each stubbed step's argument. */
        function observe() {
            const config = readConfig();
            // `models` and `harness` are `unknown` in lib/config.ts (each validated downstream by its
            // owning module), so both are read here as the record shapes the setup writers produce.
            const models = config.models as { connection?: Record<string, unknown>; agents?: Record<string, string> } | undefined;
            return {
                config,
                connection: models?.connection,
                agents: models?.agents,
                harness: config.harness as { resourceLimits?: { budget?: unknown } } | undefined,
                embedding: embedStep.mock.calls[0]?.[1],
                refs: refsStep.mock.calls[0]?.[0].selection,
                sandbox: pullStep.mock.calls[0]?.[0],
                /** The connection handed to the compose writer — the run's own resolution, whatever was persisted. */
                compose: composeWriter.mock.calls[0]?.[0],
            };
        }

        type SetupRun = ReturnType<typeof observe>;

        /** One answer key's coverage: how the answer is supplied, and the effect it must have produced by the time `setup()` returns. */
        type AnswerCase = {
            /** Commander-shaped option values, exactly as the registry hands them over. */
            readonly flags?: SetupAnswerFlags;
            /** A `--config` answers document — written into the temp dir and passed as `--config <path>`. */
            readonly file?: string;
            /** Execution modifiers, never answers: `postgres: true` to reach the compose writer, `validate: false` to stay offline. */
            readonly options?: Partial<Parameters<typeof setup>[0]>;
            /** Environment this case needs — the api-key embedding secret has no answer channel by design (D7). */
            readonly env?: Readonly<Record<string, string>>;
            readonly effect: (run: SetupRun) => void;
        };

        /** The mode plus the three answers a batch DIRECT connection requires; each connection case overrides the one field it observes. */
        const direct = { connection: "direct", provider: "anthropic", baseUrl: "https://gw.corp/v1", model: "m-1" } as const satisfies SetupAnswerFlags;

        /**
         * `--no-validate` on every direct case. The probe ladder is not the property under test and is
         * pinned by its own cases above; skipping it keeps these runs offline WITHOUT changing where an
         * answer lands (the `--no-validate` case above pins exactly that equivalence).
         */
        const offline = { validate: false } as const;

        /** `postgres: true` is what makes the compose writer run, and its argument is the strongest observation of a postgres answer. */
        const provisioned = { postgres: true } as const;

        /**
         * The credential source is ONE question spelled as four flags, so its sub-keys share a case that
         * asserts the WHOLE persisted `auth` block. Two cases are needed rather than one because the
         * sources are mutually exclusive: a command (the only kind that may carry `format`) and a variable.
         */
        const authCommandCase: AnswerCase = {
            flags: { ...direct, authCommand: "/opt/mint-token", authScheme: "bearer", authFormat: "exec-credential" },
            options: offline,
            effect: (run) => {
                expect(run.connection?.auth).toEqual({ kind: "command", command: "/opt/mint-token", scheme: "bearer", format: "exec-credential" });
            },
        };

        const authEnvCase: AnswerCase = {
            flags: { ...direct, authEnv: "MY_GATEWAY_TOKEN", authScheme: "x-api-key" },
            options: offline,
            effect: (run) => {
                expect(run.connection?.auth).toEqual({ kind: "env", var: "MY_GATEWAY_TOKEN", scheme: "x-api-key" });
            },
        };

        const ANSWER_COVERAGE = {
            "connection.mode": {
                flags: direct,
                options: offline,
                // Reaching the direct writer at all is the effect: under batch an unconsumed mode answer
                // resolves to cliproxy, and the direct-only answers beside it then fail the resolver.
                effect: (run) => {
                    expect(run.connection?.mode).toBe("direct");
                },
            },
            "connection.provider": {
                flags: { ...direct, provider: "deepseek" },
                options: offline,
                effect: (run) => {
                    expect(run.connection?.provider).toBe("deepseek");
                },
            },
            "connection.baseURL": {
                flags: { ...direct, baseUrl: "https://endpoint.internal/v1" },
                options: offline,
                effect: (run) => {
                    expect(run.connection?.baseURL).toBe("https://endpoint.internal/v1");
                },
            },
            "connection.protocol": {
                // The provider stays `anthropic`, whose INFERRED protocol is `anthropic` — so a persisted
                // `openai-compatible` can only have come from the answer, never from the inference.
                flags: { ...direct, protocol: "openai-compatible" },
                options: offline,
                effect: (run) => {
                    expect(run.connection?.protocol).toBe("openai-compatible");
                },
            },
            "connection.model": {
                flags: { ...direct, model: "pinned-1" },
                options: offline,
                effect: (run) => {
                    expect(run.agents).toEqual({ conversation: "pinned-1", sandbox: "pinned-1" });
                },
            },
            "connection.auth": authCommandCase,
            "connection.auth.kind": authCommandCase,
            "connection.auth.command": authCommandCase,
            "connection.auth.scheme": authCommandCase,
            "connection.auth.format": authCommandCase,
            "connection.auth.var": authEnvCase,
            "connection.auth.ttlMs": {
                // The TTL has no flag, so the FILE front-end is the only way to answer it — which makes
                // this the case that also proves a whole `--config`-authored connection block lands.
                file: [
                    "connection:",
                    "  mode: direct",
                    "  provider: anthropic",
                    "  baseURL: https://gw.corp/v1",
                    "  model: m-1",
                    "  auth:",
                    "    kind: command",
                    "    command: /opt/mint-token",
                    "    scheme: bearer",
                    "    ttlMs: 90000",
                    "",
                ].join("\n"),
                options: offline,
                effect: (run) => {
                    expect(run.connection?.auth).toEqual({ kind: "command", command: "/opt/mint-token", scheme: "bearer", ttlMs: 90000 });
                },
            },
            "postgres.user": {
                flags: { postgresUser: "alice" },
                options: provisioned,
                effect: (run) => {
                    expect(run.config.postgres?.user).toBe("alice");
                    expect(run.compose?.user).toBe("alice");
                },
            },
            "postgres.password": {
                flags: { postgresPassword: "s3cret" },
                options: provisioned,
                effect: (run) => {
                    expect(run.config.postgres?.password).toBe("s3cret");
                    expect(run.compose?.password).toBe("s3cret");
                },
            },
            "postgres.port": {
                // 6000 is neither channel's reserved default, so persist-only-explicit keeps it (a value
                // equal to a default would persist nothing and prove nothing).
                flags: { postgresPort: "6000" },
                options: provisioned,
                effect: (run) => {
                    expect(run.config.postgres?.port).toBe(6000);
                    expect(run.compose?.port).toBe(6000);
                },
            },
            "postgres.database": {
                // Answered through the FILE so the pair of questions that were dropped in the orchestrator
                // is proven on BOTH front-ends: the database from a `--config` document, the host from argv.
                file: "postgres:\n  database: atlas\n",
                options: provisioned,
                effect: (run) => {
                    expect(run.config.postgres?.database).toBe("atlas");
                    expect(run.compose?.database).toBe("atlas");
                },
            },
            "postgres.host": {
                flags: { postgresHost: "db.internal" },
                options: provisioned,
                effect: (run) => {
                    expect(run.config.postgres?.host).toBe("db.internal");
                    expect(run.compose?.host).toBe("db.internal");
                },
            },
            "resources.sharePct": {
                // 37 is deliberately not the resolved default (half the machine): a dropped answer skips
                // the step entirely under batch, and a half-honored one would still read as 50.
                file: "resources:\n  sharePct: 37\n",
                effect: (run) => {
                    const machine = detectedMachine();
                    expect(run.harness?.resourceLimits?.budget).toEqual({
                        cpu: Math.max(1, Math.floor((machine.cpu * 37) / 100)),
                        memoryGb: Math.max(1, Math.floor((machine.memoryGb * 37) / 100)),
                    });
                },
            },
            "embedding.mode": {
                flags: { embeddings: "off" },
                effect: (run) => {
                    expect(run.embedding?.mode).toBe("off");
                },
            },
            "embedding.baseURL": {
                // An api-key backend, so the secret's presence gate must pass; the secret itself never
                // rides an answer, which is why this is the one case that needs an environment.
                flags: { embeddings: "api-key", embeddingsUrl: "https://embeds.internal/v1" },
                env: { [EMBEDDING_API_KEY_VAR]: "sk-embed" },
                effect: (run) => {
                    expect(run.embedding?.baseURL).toBe("https://embeds.internal/v1");
                },
            },
            "embedding.model": {
                flags: { embeddings: "api-key", embeddingsModel: "text-embedding-3-large" },
                env: { [EMBEDDING_API_KEY_VAR]: "sk-embed" },
                effect: (run) => {
                    expect(run.embedding?.model).toBe("text-embedding-3-large");
                },
            },
            "embedding.gguf": {
                flags: { embeddings: "local", embeddingsGguf: "/models/custom.gguf" },
                effect: (run) => {
                    expect(run.embedding?.gguf).toBe("/models/custom.gguf");
                },
            },
            refs: {
                // Real catalog ids: the orchestrator now resolves an answered id list against the offered
                // catalog BEFORE anything mutates (design D2), so an invented id would fail this run
                // upfront rather than reaching the step whose consumption is under test.
                file: `refs:\n  - ${CATALOG_ID}\n  - ${OTHER_CATALOG_ID}\n`,
                effect: (run) => {
                    expect(run.refs).toEqual({ ids: [CATALOG_ID, OTHER_CATALOG_ID] });
                },
            },
            sandbox: {
                flags: { sandbox: "python-r" },
                effect: (run) => {
                    // The ANSWER is the multi-GB consent, so the pull carries `yes` and reaches no confirm.
                    expect(run.sandbox).toEqual({ variant: "python-r", yes: true });
                },
            },
            runtime: {
                flags: { runtime: "podman" },
                effect: (run) => {
                    // Docker is what the (stubbed) detection would otherwise pin, so podman is the answer.
                    expect(run.config.runtime).toBe("podman");
                },
            },
        } satisfies Record<AnswerValueKey, AnswerCase>;

        /**
         * The answer keys as the SOURCE declares them, read out of `ANSWER_QUESTIONS`'s object literal —
         * the ONE table setup_answers.ts derives its spellings, its merge, and its schema link from. That
         * table is module-private and exporting it would be a production change made for a test, so the
         * source text is the honest runtime enumeration. It is cross-checked against the LIVE table below
         * — `answerSpelling` throws on a key the table does not own — so a pattern that drifted from the
         * declaration fails loudly instead of quietly shrinking the guard.
         *
         * Block entries (`at: "block"`) are excluded: a block is spellable, so a block-shaped file error
         * names both spellings, but it holds answers rather than being one and so has no destination of
         * its own to reach. That is the same cut `AnswerValueKey` makes at the type level.
         */
        function declaredAnswerKeys(): string[] {
            const source = readFileSync(join(import.meta.dir, "setup_answers.ts"), "utf8");
            const table = /const ANSWER_QUESTIONS = \{\n([\s\S]*?)\n\} as const satisfies/.exec(source)?.[1];
            expect(table).toBeDefined();
            // Both capture groups are mandatory in the pattern, so every match carries them.
            return [...(table ?? "").matchAll(/^ {4}"?([A-Za-z][\w.]*)"?: \{(.*)\},$/gm)]
                .filter((match) => !match[2]!.includes('at: "block"'))
                .map((match) => match[1]!);
        }

        test("the coverage table names every answerable question — a new answer cannot ship unproven", () => {
            const declared = declaredAnswerKeys();
            for (const key of declared) {
                // The cast is checked by the assertion it feeds: a key `ANSWER_QUESTIONS` does not own has
                // no entry to read a flag off, so `answerSpelling` throws rather than rendering a spelling.
                expect(answerSpelling(key as AnswerKey)).toContain(`\`${key}\``);
            }
            // Both directions in one comparison, which is also what catches a pattern that matched nothing.
            expect(declared.toSorted()).toEqual(Object.keys(ANSWER_COVERAGE).toSorted());
        });

        // Annotated because `satisfies` keeps each entry's own literal type, so a bare `Object.entries`
        // yields a 25-member union with no common property to read.
        const cases: readonly (readonly [string, AnswerCase])[] = Object.entries(ANSWER_COVERAGE);

        for (const [key, entry] of cases) {
            test(`${key} is consumed, not merely parsed`, async () => {
                const configPath = entry.file === undefined ? undefined : join(answersDir, "answers.yml");
                if (configPath !== undefined && entry.file !== undefined) writeFileSync(configPath, entry.file);
                const flags: SetupAnswerFlags = { ...entry.flags, ...(configPath !== undefined && { config: configPath }) };

                // `Bun.env` rather than `process.env` — the same object (Bun aliases it), spelled the way
                // gen_docs.test.ts already does to stay clear of the `no-restricted-properties` ban on
                // reading the environment outside lib/env.ts. Only the api-key embedding cases need this:
                // that secret has no answer channel by design, so its presence gate reads the LIVE env.
                const restore = new Map<string, string | undefined>();
                for (const [name, value] of Object.entries(entry.env ?? {})) {
                    restore.set(name, Bun.env[name]);
                    Bun.env[name] = value;
                }
                try {
                    await runSetup(batch(flags, entry.options ?? {}));
                } finally {
                    for (const [name, prior] of restore) {
                        if (prior === undefined) delete Bun.env[name];
                        else Bun.env[name] = prior;
                    }
                }

                // An honored answer must also leave the run successful: a silently-ignored answer and a
                // failed provision are both defects, and asserting only the effect would let the second by.
                expect(process.exitCode).toBe(0);
                entry.effect(observe());
            });
        }
    });
});
