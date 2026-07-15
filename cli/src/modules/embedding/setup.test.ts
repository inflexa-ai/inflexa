import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { readConfig, writeConfig, type Config } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { __setCompiledBinaryForTest } from "../../lib/install_context.ts";
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
    // The compiled-context override is a process-wide singleton; leaving it set would leak into every
    // later test (and file) in the same process. Restore real detection (not-compiled under `bun test`).
    __setCompiledBinaryForTest(null);
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

describe("compiled-context embeddings (native runtime unavailable)", () => {
    test("`--embeddings local` fails before any download or bun spawn, naming the api-key alternative", async () => {
        __setCompiledBinaryForTest(true);
        writeConfigWith({ mode: "off" });
        // If the guard ever regressed to running the local flow, the first thing it does is spawn
        // `bun pm trust`; asserting spawn is untouched proves the trust step never runs here.
        const spawnSpy = spyOn(Bun, "spawn");

        const result = await runEmbeddingSetup(true, "local");

        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("local_unavailable");
        expect(e.message).toContain("--embeddings api-key");
        // No download landed at the model path, and no `bun` process was spawned.
        expect(await Bun.file(env.embeddingModelPath).exists()).toBe(false);
        expect(spawnSpy).not.toHaveBeenCalled();
        expect(readConfig().embedding.mode).toBe("off");

        spawnSpy.mockRestore();
    });

    test("ensureEmbedderReady with local mode → local_unavailable, switch-modes remediation (even if the model file exists)", async () => {
        __setCompiledBinaryForTest(true);
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath });
        // A present model file must NOT be mistaken for readiness here: the native runtime still can't
        // load it in the packaged binary, so the compiled check short-circuits ahead of the file probe.
        mkdirSync(dirname(env.embeddingModelPath), { recursive: true });
        writeFileSync(env.embeddingModelPath, "fake-gguf");

        const result = await ensureEmbedderReady();

        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("local_unavailable");
        expect(e.message).toContain("api-key");
        expect(e.message).toContain("off");
        // Never points at a command that cannot succeed in the packaged binary.
        expect(e.message).not.toContain("inflexa setup");
    });
});

describe("from-source embeddings remediation (unchanged)", () => {
    test("ensureEmbedderReady local + model missing → not_configured pointing at `inflexa setup --embeddings local`", async () => {
        // Default detection under `bun test` is not-compiled; make the from-source context explicit so
        // this asserts the from-source remediation string independently of the harness's default.
        __setCompiledBinaryForTest(false);
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath });

        const result = await ensureEmbedderReady();

        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("not_configured");
        expect(e.message).toContain("inflexa setup --embeddings local");
    });
});
