import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { readFileSync } from "node:fs";

import { env } from "../../lib/env.ts";
import { readConfig, writeConfig } from "../../lib/config.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { resolveHarnessConfig, resolveKnowledgeConfig, resolveModelConnection, writeAgentModel } from "./config.ts";

// Drives resolveModelConnection through the real readConfig() surface against the sandboxed
// env.configPath (set by the test preload), exercising the fail-closed + protocol-implication paths
// exactly as boot does. Every test writes or deletes env.configPath, so guard once, first, in the
// hooks: at the monorepo root that path is the developer's REAL config.json (data-loss guard —
// test_support/sandbox.ts).
beforeEach(() => {
    assertTestSandbox(env.configPath);
});

afterEach(() => {
    assertTestSandbox(env.configPath);
    rmSync(env.configPath, { force: true });
});

// telemetry is a required config field, so a well-formed file must carry it; the `models` block is
// what these tests vary.
function writeConfigWithModels(models: unknown): void {
    mkdirSync(dirname(env.configPath), { recursive: true });
    writeFileSync(env.configPath, JSON.stringify({ telemetry: false, ...(models === undefined ? {} : { models }) }));
}

// The DBOS admin port default is channel-aware: resolveHarnessConfig falls back to env.adminPort (from
// stackPorts) so a dev harness runtime and an installed prod harness runtime never contend for the admin
// HTTP bind. An explicit `harness.adminPort` still wins per the per-field override contract.
describe("resolveHarnessConfig — adminPort default", () => {
    function writeConfigWithHarness(harness: unknown): void {
        mkdirSync(dirname(env.configPath), { recursive: true });
        writeFileSync(env.configPath, JSON.stringify({ telemetry: false, ...(harness === undefined ? {} : { harness }) }));
    }

    test("an absent harness block defaults adminPort to the channel-aware env.adminPort", () => {
        writeConfigWithHarness(undefined);
        expect(resolveHarnessConfig().adminPort).toBe(env.adminPort);
    });

    test("an explicit harness.adminPort still wins over the channel-aware default", () => {
        writeConfigWithHarness({ adminPort: 9999 });
        expect(resolveHarnessConfig().adminPort).toBe(9999);
    });
});

describe("resolveHarnessConfig — retired ephemeral resources", () => {
    test("a stale resourceLimits.ephemeral field has no runtime effect", () => {
        expect(
            writeConfig({
                ...readConfig(),
                harness: {
                    resourceLimits: {
                        maxCpu: 2,
                        maxMemoryGb: 4,
                        budget: { cpu: 2, memoryGb: 4 },
                        ephemeral: { cpu: 99, memoryGb: 99 },
                    },
                },
            }).isOk(),
        ).toBe(true);

        expect(resolveHarnessConfig().resourcePolicy).toEqual({
            perStep: { maxCpu: 2, maxMemoryGb: 4, maxGpuCount: 0 },
            budget: { cpu: 2, memoryGb: 4 },
        });
    });
});

describe("resolveModelConnection — defaults", () => {
    test("an absent models block resolves to cliproxy mode with provider anthropic and no agent overrides (today's behavior)", () => {
        writeConfigWithModels(undefined);
        expect(resolveModelConnection()).toEqual({ mode: "cliproxy", provider: "anthropic", agents: {} });
    });

    test("a models block with no connection keeps the default connection (forward-compatible with agents-only blocks)", () => {
        writeConfigWithModels({});
        expect(resolveModelConnection()).toEqual({ mode: "cliproxy", provider: "anthropic", agents: {} });
    });

    test("a cliproxy connection with no provider defaults the provider to anthropic", () => {
        writeConfigWithModels({ connection: { mode: "cliproxy" } });
        expect(resolveModelConnection()).toEqual({ mode: "cliproxy", provider: "anthropic", agents: {} });
    });

    test("a cliproxy connection records the configured provider slug verbatim", () => {
        writeConfigWithModels({ connection: { mode: "cliproxy", provider: "openai" } });
        expect(resolveModelConnection()).toEqual({ mode: "cliproxy", provider: "openai", agents: {} });
    });
});

describe("resolveModelConnection — direct protocol implication", () => {
    test("provider anthropic with no explicit protocol implies the anthropic wire kind", () => {
        writeConfigWithModels({ connection: { mode: "direct", provider: "anthropic", baseURL: "https://gw.example/v1" } });
        expect(resolveModelConnection()).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://gw.example/v1",
            protocol: "anthropic",
            agents: {},
        });
    });

    test("any non-anthropic provider with no explicit protocol implies openai-compatible", () => {
        writeConfigWithModels({ connection: { mode: "direct", provider: "deepseek", baseURL: "https://api.deepseek.com/v1" } });
        expect(resolveModelConnection()).toEqual({
            mode: "direct",
            provider: "deepseek",
            baseURL: "https://api.deepseek.com/v1",
            protocol: "openai-compatible",
            agents: {},
        });
    });

    test("an explicit protocol overrides the provider implication (an anthropic-fronting gateway that speaks openai)", () => {
        writeConfigWithModels({ connection: { mode: "direct", provider: "anthropic", baseURL: "https://gw.example/v1", protocol: "openai-compatible" } });
        expect(resolveModelConnection()).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://gw.example/v1",
            protocol: "openai-compatible",
            agents: {},
        });
    });
});

describe("resolveModelConnection — agent overrides ride through", () => {
    test("a full agents map is carried verbatim onto the resolved connection", () => {
        writeConfigWithModels({
            connection: { mode: "cliproxy", provider: "anthropic" },
            agents: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-haiku-4-5" },
        });
        expect(resolveModelConnection()).toEqual({
            mode: "cliproxy",
            provider: "anthropic",
            agents: { conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-haiku-4-5" },
        });
    });

    test("a partial agents map carries only the stated agent (the other falls through at boot)", () => {
        writeConfigWithModels({ connection: { mode: "cliproxy", provider: "anthropic" }, agents: { sandbox: "claude-sonnet-4-5" } });
        expect(resolveModelConnection()).toEqual({ mode: "cliproxy", provider: "anthropic", agents: { sandbox: "claude-sonnet-4-5" } });
    });

    test("an agents-only block (no connection) resolves to the default connection carrying the overrides", () => {
        writeConfigWithModels({ agents: { conversation: "claude-opus-4-8" } });
        expect(resolveModelConnection()).toEqual({ mode: "cliproxy", provider: "anthropic", agents: { conversation: "claude-opus-4-8" } });
    });

    test("a direct connection carries its agent overrides beside the endpoint facts", () => {
        writeConfigWithModels({
            connection: { mode: "direct", provider: "deepseek", baseURL: "https://api.deepseek.com/v1" },
            agents: { conversation: "deepseek-chat", sandbox: "deepseek-reasoner", utility: "deepseek-chat" },
        });
        expect(resolveModelConnection()).toEqual({
            mode: "direct",
            provider: "deepseek",
            baseURL: "https://api.deepseek.com/v1",
            protocol: "openai-compatible",
            agents: { conversation: "deepseek-chat", sandbox: "deepseek-reasoner", utility: "deepseek-chat" },
        });
    });

    test("a malformed agent value fails closed to the default connection, dropping the overrides, carrying a configError", () => {
        // A non-string agent id fails the whole `models` parse — the overrides cannot be trusted past a
        // parse failure, so they drop with the rest of the block and boot reports the precise field.
        writeConfigWithModels({ connection: { mode: "cliproxy", provider: "anthropic" }, agents: { conversation: 123 } });
        const resolved = resolveModelConnection();
        expect(resolved).toMatchObject({ mode: "cliproxy", provider: "anthropic", agents: {} });
        expect(resolved.configError?.issues).toContain("models.agents.conversation");
    });
});

describe("resolveModelConnection — direct-mode auth (credential source) round-trip", () => {
    test("a valid env auth block rides through verbatim onto the resolved direct connection", () => {
        writeConfigWithModels({
            connection: {
                mode: "direct",
                provider: "anthropic",
                baseURL: "https://api.anthropic.com/v1",
                auth: { kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" },
            },
        });
        expect(resolveModelConnection()).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://api.anthropic.com/v1",
            protocol: "anthropic",
            auth: { kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" },
            agents: {},
        });
    });

    test("a valid command auth block carries format + ttlMs verbatim", () => {
        writeConfigWithModels({
            connection: {
                mode: "direct",
                provider: "deepseek",
                baseURL: "https://api.deepseek.com/v1",
                auth: { kind: "command", command: "mint-token --json", scheme: "x-api-key", format: "exec-credential", ttlMs: 300000 },
            },
        });
        expect(resolveModelConnection()).toEqual({
            mode: "direct",
            provider: "deepseek",
            baseURL: "https://api.deepseek.com/v1",
            protocol: "openai-compatible",
            auth: { kind: "command", command: "mint-token --json", scheme: "x-api-key", format: "exec-credential", ttlMs: 300000 },
            agents: {},
        });
    });

    test("a direct connection with no auth block resolves without an auth field (env-key path)", () => {
        writeConfigWithModels({ connection: { mode: "direct", provider: "anthropic", baseURL: "https://api.anthropic.com/v1" } });
        const resolved = resolveModelConnection();
        expect(resolved).not.toHaveProperty("auth");
    });

    test("an invalid auth scheme fails the whole models parse closed, naming the offending field", () => {
        writeConfigWithModels({
            connection: { mode: "direct", provider: "anthropic", baseURL: "https://api.anthropic.com/v1", auth: { kind: "env", var: "X", scheme: "basic" } },
        });
        const resolved = resolveModelConnection();
        expect(resolved).toMatchObject({ mode: "cliproxy", provider: "anthropic", agents: {} });
        expect(resolved.configError?.issues).toContain("models.connection");
    });

    test("an unknown auth kind fails closed with a config error", () => {
        writeConfigWithModels({
            connection: { mode: "direct", provider: "anthropic", baseURL: "https://api.anthropic.com/v1", auth: { kind: "aws-sso", scheme: "bearer" } },
        });
        expect(resolveModelConnection().configError).toBeDefined();
    });

    test("a command auth block missing its command fails closed", () => {
        writeConfigWithModels({
            connection: { mode: "direct", provider: "openai", baseURL: "https://api.openai.com/v1", auth: { kind: "command", scheme: "bearer" } },
        });
        expect(resolveModelConnection().configError).toBeDefined();
    });
});

describe("resolveModelConnection — fail closed", () => {
    test("a direct block missing baseURL fails closed to the default connection, carrying a configError", () => {
        writeConfigWithModels({ connection: { mode: "direct", provider: "openai" } });
        const resolved = resolveModelConnection();
        expect(resolved.mode).toBe("cliproxy");
        expect(resolved.provider).toBe("anthropic");
        expect(resolved.configError?.issues).toContain("models.connection");
    });

    test("an unknown mode fails closed to the default connection, carrying a configError", () => {
        writeConfigWithModels({ connection: { mode: "carrier-pigeon", provider: "openai" } });
        const resolved = resolveModelConnection();
        expect(resolved).toMatchObject({ mode: "cliproxy", provider: "anthropic" });
        expect(resolved.configError).toBeDefined();
    });
});

// The request timeout and the retry count: both are optional integer fields on both connection arms, and
// boot carries the resolved values into the harness provider config. requestTimeoutMs is a positive
// integer. maxRetries is a non-negative integer, so zero is a valid no-retries setting. A valid value
// rides through, an absent value is omitted, and an out-of-range or non-integer value fails the models
// parse closed (the same fail-closed pattern as a malformed connection above).
describe("resolveModelConnection — request timeout and retry count", () => {
    test("a valid requestTimeoutMs and maxRetries ride onto a direct connection", () => {
        writeConfigWithModels({
            connection: { mode: "direct", provider: "deepseek", baseURL: "https://api.deepseek.com/v1", requestTimeoutMs: 1_800_000, maxRetries: 3 },
        });
        const resolved = resolveModelConnection();
        expect(resolved).toMatchObject({ mode: "direct", requestTimeoutMs: 1_800_000, maxRetries: 3 });
        expect(resolved.configError).toBeUndefined();
    });

    test("a valid requestTimeoutMs rides onto a cliproxy connection", () => {
        writeConfigWithModels({ connection: { mode: "cliproxy", provider: "anthropic", requestTimeoutMs: 1_800_000 } });
        const resolved = resolveModelConnection();
        expect(resolved).toMatchObject({ mode: "cliproxy", requestTimeoutMs: 1_800_000 });
        expect(resolved.maxRetries).toBeUndefined();
        expect(resolved.configError).toBeUndefined();
    });

    test("an absent requestTimeoutMs and maxRetries resolve to a connection without them", () => {
        writeConfigWithModels({ connection: { mode: "direct", provider: "deepseek", baseURL: "https://api.deepseek.com/v1" } });
        const resolved = resolveModelConnection();
        expect(resolved.requestTimeoutMs).toBeUndefined();
        expect(resolved.maxRetries).toBeUndefined();
        expect(resolved.configError).toBeUndefined();
    });

    test("a zero requestTimeoutMs fails closed to the default connection, carrying a configError", () => {
        writeConfigWithModels({ connection: { mode: "cliproxy", provider: "anthropic", requestTimeoutMs: 0 } });
        const resolved = resolveModelConnection();
        expect(resolved).toMatchObject({ mode: "cliproxy", provider: "anthropic" });
        expect(resolved.configError?.issues).toContain("models.connection");
    });

    test("a zero maxRetries parses and rides onto the connection as a no-retries setting", () => {
        writeConfigWithModels({ connection: { mode: "cliproxy", provider: "anthropic", maxRetries: 0 } });
        const resolved = resolveModelConnection();
        expect(resolved).toMatchObject({ mode: "cliproxy", provider: "anthropic", maxRetries: 0 });
        expect(resolved.configError).toBeUndefined();
    });

    test("a negative maxRetries fails closed, carrying a configError", () => {
        writeConfigWithModels({ connection: { mode: "cliproxy", provider: "anthropic", maxRetries: -1 } });
        expect(resolveModelConnection().configError).toBeDefined();
    });

    test("a non-integer requestTimeoutMs fails closed, carrying a configError", () => {
        writeConfigWithModels({ connection: { mode: "direct", provider: "deepseek", baseURL: "https://api.deepseek.com/v1", requestTimeoutMs: 1.5 } });
        expect(resolveModelConnection().configError).toBeDefined();
    });
});

// The write side of the agent-model config surface: the palette pick persists
// immediately, spread-preserving. Read back through the real config file so the test asserts the exact
// on-disk shape resolveModelConnection then consumes.
describe("writeAgentModel — persists models.agents spread-preserving", () => {
    function readModelsBlock(): Record<string, unknown> {
        const parsed = JSON.parse(readFileSync(env.configPath, "utf8")) as { models?: Record<string, unknown> };
        return parsed.models ?? {};
    }

    test("writes the agent's model into models.agents and round-trips through resolveModelConnection", () => {
        writeConfigWithModels(undefined); // a config with no models block at all
        expect(writeAgentModel("sandbox", "claude-sonnet-4-5").isOk()).toBe(true);
        expect(readModelsBlock()).toEqual({ agents: { sandbox: "claude-sonnet-4-5" } });
        expect(resolveModelConnection().agents).toEqual({ sandbox: "claude-sonnet-4-5" });
    });

    test("writes utility alone without manufacturing conversation or sandbox overrides", () => {
        writeConfigWithModels(undefined);
        expect(writeAgentModel("utility", "claude-haiku-4-5").isOk()).toBe(true);
        expect(readModelsBlock()).toEqual({ agents: { utility: "claude-haiku-4-5" } });
        expect(resolveModelConnection().agents).toEqual({ utility: "claude-haiku-4-5" });
    });

    test("keeps the connection block and the OTHER agent when rewriting one agent", () => {
        writeConfigWithModels({
            connection: { mode: "direct", provider: "anthropic", baseURL: "https://gw.example" },
            agents: { conversation: "claude-opus-4-8" },
        });
        expect(writeAgentModel("sandbox", "claude-haiku-4-5").isOk()).toBe(true);
        expect(readModelsBlock()).toEqual({
            connection: { mode: "direct", provider: "anthropic", baseURL: "https://gw.example" },
            agents: { conversation: "claude-opus-4-8", sandbox: "claude-haiku-4-5" },
        });
    });

    test("overwrites an existing entry for the same agent", () => {
        writeConfigWithModels({ agents: { conversation: "claude-opus-4-8" } });
        expect(writeAgentModel("conversation", "claude-sonnet-4-5").isOk()).toBe(true);
        expect(readModelsBlock()).toEqual({ agents: { conversation: "claude-sonnet-4-5" } });
    });

    test("preserves unrelated top-level config keys (telemetry)", () => {
        writeConfigWithModels(undefined);
        expect(writeAgentModel("conversation", "claude-opus-4-8").isOk()).toBe(true);
        const parsed = JSON.parse(readFileSync(env.configPath, "utf8")) as { telemetry: boolean };
        expect(parsed.telemetry).toBe(false);
    });
});

// The knowledge plane: the endpoint comes from the `knowledge` config block and the key from the
// environment only. An absent block is the default state of the open-source CLI and resolves to
// null, thus the boot binds no client. An endpoint without a key names the variable instead of a
// silent unauthenticated client.
describe("resolveKnowledgeConfig", () => {
    const KEY_VAR = "INFLEXA_KNOWLEDGE_API_KEY";
    let savedKey: string | undefined;

    function writeConfigWithKnowledge(knowledge: unknown): void {
        mkdirSync(dirname(env.configPath), { recursive: true });
        writeFileSync(env.configPath, JSON.stringify({ telemetry: false, ...(knowledge === undefined ? {} : { knowledge }) }));
    }

    // `Bun.env` is the sanctioned test seam for an ambient variable (see setup.test.ts); the
    // production reader stays `lib/env.ts`.
    beforeEach(() => {
        savedKey = Bun.env[KEY_VAR];
        delete Bun.env[KEY_VAR];
    });
    afterEach(() => {
        if (savedKey === undefined) delete Bun.env[KEY_VAR];
        else Bun.env[KEY_VAR] = savedKey;
    });

    test("an absent block resolves to null, with or without a key in the environment", () => {
        writeConfigWithKnowledge(undefined);
        expect(resolveKnowledgeConfig()).toBeNull();
        Bun.env[KEY_VAR] = "k";
        expect(resolveKnowledgeConfig()).toBeNull();
    });

    test("an endpoint with the key in the environment resolves to a configured client", () => {
        writeConfigWithKnowledge({ baseUrl: "https://knowledge.example.test/" });
        Bun.env[KEY_VAR] = "secret";
        expect(resolveKnowledgeConfig()).toEqual({ kind: "configured", baseUrl: "https://knowledge.example.test/", apiKey: "secret" });
    });

    test("an endpoint without the key resolves to missing_key, never to a keyless client", () => {
        writeConfigWithKnowledge({ baseUrl: "https://knowledge.example.test" });
        expect(resolveKnowledgeConfig()).toEqual({ kind: "missing_key", baseUrl: "https://knowledge.example.test" });
    });

    test("a malformed block degrades to null instead of failing the whole config", () => {
        writeConfigWithKnowledge({ baseUrl: 42 });
        Bun.env[KEY_VAR] = "secret";
        expect(resolveKnowledgeConfig()).toBeNull();
        expect(readConfig().telemetry).toBe(false);
    });
});
