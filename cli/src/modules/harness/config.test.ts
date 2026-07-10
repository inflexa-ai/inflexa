import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { resolveModelConnection } from "./config.ts";

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

describe("resolveModelConnection — defaults", () => {
    test("an absent models block resolves to cliproxy mode with provider anthropic (today's behavior)", () => {
        writeConfigWithModels(undefined);
        expect(resolveModelConnection()).toEqual({ mode: "cliproxy", provider: "anthropic" });
    });

    test("a models block with no connection keeps the default connection (forward-compatible with seats-only blocks)", () => {
        writeConfigWithModels({});
        expect(resolveModelConnection()).toEqual({ mode: "cliproxy", provider: "anthropic" });
    });

    test("a cliproxy connection with no provider defaults the provider to anthropic", () => {
        writeConfigWithModels({ connection: { mode: "cliproxy" } });
        expect(resolveModelConnection()).toEqual({ mode: "cliproxy", provider: "anthropic" });
    });

    test("a cliproxy connection records the configured provider slug verbatim", () => {
        writeConfigWithModels({ connection: { mode: "cliproxy", provider: "openai" } });
        expect(resolveModelConnection()).toEqual({ mode: "cliproxy", provider: "openai" });
    });
});

describe("resolveModelConnection — direct protocol implication", () => {
    test("provider anthropic with no explicit protocol implies the anthropic wire kind", () => {
        writeConfigWithModels({ connection: { mode: "direct", provider: "anthropic", baseURL: "https://gw.example/v1" } });
        expect(resolveModelConnection()).toEqual({ mode: "direct", provider: "anthropic", baseURL: "https://gw.example/v1", protocol: "anthropic" });
    });

    test("any non-anthropic provider with no explicit protocol implies openai-compatible", () => {
        writeConfigWithModels({ connection: { mode: "direct", provider: "deepseek", baseURL: "https://api.deepseek.com/v1" } });
        expect(resolveModelConnection()).toEqual({
            mode: "direct",
            provider: "deepseek",
            baseURL: "https://api.deepseek.com/v1",
            protocol: "openai-compatible",
        });
    });

    test("an explicit protocol overrides the provider implication (an anthropic-fronting gateway that speaks openai)", () => {
        writeConfigWithModels({ connection: { mode: "direct", provider: "anthropic", baseURL: "https://gw.example/v1", protocol: "openai-compatible" } });
        expect(resolveModelConnection()).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://gw.example/v1",
            protocol: "openai-compatible",
        });
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
