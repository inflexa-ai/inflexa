import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { readConfig, writeConfig, type Config } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { ensureEmbedderReady, runEmbeddingSetup } from "./setup.ts";

// The test preload sandboxes XDG_DATA_HOME/XDG_CONFIG_HOME, so env.configPath
// and env.embeddingModelPath point into a temp dir — safe to create/delete here.

// At the monorepo root the preload never runs: env.configPath and env.embeddingModelPath then resolve
// to the developer's REAL config.json and models dir, and this file writes/deletes BOTH. Guard both,
// first, in the hooks — a root run throws before writeConfigWith / the fake-gguf writeFileSync can
// clobber real data (data-loss guard — see test_support/sandbox.ts).
beforeEach(() => {
    assertTestSandbox(env.configPath);
    assertTestSandbox(env.embeddingModelPath);
});

function writeConfigWith(embedding: Config["embedding"]): void {
    writeConfig({ telemetry: false, theme: "tokyo-night", runtime: "docker", leaderTimeout: 2000, embedding })._unsafeUnwrap();
}

afterEach(() => {
    assertTestSandbox(env.configPath);
    assertTestSandbox(env.embeddingModelPath);
    rmSync(env.configPath, { force: true });
    rmSync(env.embeddingModelPath, { force: true });
});

describe("ensureEmbedderReady", () => {
    test("off mode → ok (no model check)", async () => {
        writeConfigWith({ mode: "off" });
        const result = await ensureEmbedderReady();
        expect(result.isOk()).toBe(true);
    });

    test("api-key mode → ok (readiness is not the embedding setup's concern)", async () => {
        writeConfigWith({ mode: "api-key", apiKey: "sk-test" });
        const result = await ensureEmbedderReady();
        expect(result.isOk()).toBe(true);
    });

    test("local mode + model missing → err not_configured", async () => {
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath });
        const result = await ensureEmbedderReady();
        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().type).toBe("not_configured");
    });

    test("local mode + model present → ok", async () => {
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath });
        mkdirSync(dirname(env.embeddingModelPath), { recursive: true });
        writeFileSync(env.embeddingModelPath, "fake-gguf");
        const result = await ensureEmbedderReady();
        expect(result.isOk()).toBe(true);
    });
});

describe("runEmbeddingSetup", () => {
    test("non-interactive (no TTY) → ok, mode unchanged", async () => {
        writeConfigWith({ mode: "off" });
        const wasTTY = process.stdin.isTTY;
        // isTTY is a getter at runtime; overriding via defineProperty for the test is safe — the function only reads it.
        Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
        try {
            const result = await runEmbeddingSetup(false);
            expect(result.isOk()).toBe(true);
            expect(readConfig().embedding.mode).toBe("off");
        } finally {
            Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
        }
    });

    test("preselected off → ok, no download", async () => {
        writeConfigWith({ mode: "off" });
        const result = await runEmbeddingSetup(true, "off");
        expect(result.isOk()).toBe(true);
        expect(readConfig().embedding.mode).toBe("off");
    });
});
