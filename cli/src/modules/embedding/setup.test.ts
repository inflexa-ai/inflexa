import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { err, ok } from "neverthrow";

import { readConfig, writeConfig, type Config } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { __resetLlamaRuntimeForTest, __setLlamaAcquireForTest, __setLlamaPinForTest, materializedLlamaServer, type ResolvedPin } from "./llama_runtime.ts";
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
    assertTestSandbox(env.llamaServerDir);
});

function writeConfigWith(embedding: Config["embedding"]): void {
    writeConfig({ telemetry: false, theme: "tokyo-night", runtime: "docker", leaderTimeout: 2000, embedding })._unsafeUnwrap();
}

afterEach(() => {
    assertTestSandbox(env.configPath);
    assertTestSandbox(env.embeddingModelPath);
    assertTestSandbox(env.llamaServerDir);
    rmSync(env.configPath, { force: true });
    rmSync(env.embeddingModelPath, { force: true });
    // The pin/acquire overrides are process-wide singletons; leaving them set (or the
    // materialized fixture dir behind) would leak into every later runtime-gate test.
    __resetLlamaRuntimeForTest();
    rmSync(env.llamaServerDir, { recursive: true, force: true });
});

// --- runtime-gate fixtures ----------------------------------------------------
// The readiness gate consults the llama_runtime seams, so its tests force a fixture
// pin + stubbed acquisition (never the real network or embedded asset). The archive
// is a genuine tar.gz (mirroring llama_runtime.test.ts's fixture) so the gate's
// materialization runs the real verify → extract → rename pipeline.

const TEST_TAG = "setup-test-tag";

async function buildFixtureArchive(): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
    const work = mkdtempSync(join(tmpdir(), "inflexa-embed-setup-fixture-"));
    await mkdir(join(work, "runtime"), { recursive: true });
    await Bun.write(join(work, "runtime", "llama-server"), "#!/bin/sh\necho fixture\n");
    const tarPath = join(work, "fixture.tar.gz");
    const proc = Bun.spawn(["tar", "czf", tarPath, "-C", work, "runtime"], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    const bytes = await Bun.file(tarPath).bytes();
    rmSync(work, { recursive: true, force: true });
    return { bytes, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}

const fixture = await buildFixtureArchive();

function pinWith(sha256: string): ResolvedPin {
    return { tag: TEST_TAG, target: "darwin-arm64", artifact: "fixture.tar.gz", sha256 };
}

/** Acquire stub that writes `bytes` to the staging path, counting invocations. */
function stubAcquire(bytes: Uint8Array): { calls: number } {
    const spy = { calls: 0 };
    __setLlamaAcquireForTest(async (_source, destPath) => {
        spy.calls += 1;
        await Bun.write(destPath, bytes);
        return ok(undefined);
    });
    return spy;
}

/** Put a fake GGUF at the configured model path so the gate's model check passes. */
function placeFakeModel(): void {
    mkdirSync(dirname(env.embeddingModelPath), { recursive: true });
    writeFileSync(env.embeddingModelPath, "fake-gguf");
}

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

    test("local mode + model missing → err not_configured, directing to `inflexa setup --embeddings local`", async () => {
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath });
        const result = await ensureEmbedderReady();
        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("not_configured");
        // The remediation succeeds in every install context now (local mode works from
        // the compiled binary too), so there is no compiled-context switch-modes branch.
        expect(e.message).toContain("inflexa setup --embeddings local");
    });

    test("local mode + model present + runtime materialized → ok with zero acquisition work", async () => {
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath });
        placeFakeModel();
        // Pre-materialize the pinned tag dir; the sha is irrelevant because a
        // materialized runtime must short-circuit before any hashing.
        __setLlamaPinForTest(pinWith("0".repeat(64)));
        mkdirSync(join(env.llamaServerDir, TEST_TAG), { recursive: true });
        writeFileSync(join(env.llamaServerDir, TEST_TAG, "llama-server"), "#!/bin/sh\n");
        const spy = stubAcquire(fixture.bytes);

        const result = await ensureEmbedderReady();

        expect(result.isOk()).toBe(true);
        expect(spy.calls).toBe(0);
    });

    test("local mode + model present + runtime absent → the gate materializes it and returns ok", async () => {
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath });
        placeFakeModel();
        __setLlamaPinForTest(pinWith(fixture.sha256));
        const spy = stubAcquire(fixture.bytes);
        expect(materializedLlamaServer()).toBeNull();

        const result = await ensureEmbedderReady();

        expect(result.isOk()).toBe(true);
        expect(spy.calls).toBe(1);
        // Healed at launch: the runtime is now on disk, so the first embed pays no acquisition.
        expect(materializedLlamaServer()).not.toBeNull();
    });

    test("local mode + model present + acquisition fails → err runtime_unavailable with remediation", async () => {
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath });
        placeFakeModel();
        __setLlamaPinForTest(pinWith(fixture.sha256));
        // The offline source-checkout case: the download is the only byte source
        // from source, and it is unreachable.
        __setLlamaAcquireForTest(async () => err({ type: "download_failed", message: "network unreachable" }));

        const result = await ensureEmbedderReady();

        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("runtime_unavailable");
        expect(e.message).toContain("network unreachable");
        expect(e.message).toContain("inflexa setup --embeddings local");
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
