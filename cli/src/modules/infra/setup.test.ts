import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { adoptedConnection, detectedAdoptable, normalizeAdoptedBaseURL, parseConnectionMode, recordCliproxyProvider, writeDirectConnection } from "./setup.ts";
import { readConfig } from "../../lib/config.ts";
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
});
