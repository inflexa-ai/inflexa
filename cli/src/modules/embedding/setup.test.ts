import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { err, ok } from "neverthrow";

import type { ProviderError } from "@inflexa-ai/harness";

import * as prompts from "../../lib/cli.ts";
import { readConfig, writeConfig, type Config } from "../../lib/config.ts";
import { EMBEDDING_API_KEY_VAR, env } from "../../lib/env.ts";
import { __setCompiledBinaryForTest } from "../../lib/install_context.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import type { SetupAnswers } from "../infra/setup_answers.ts";
import { __resetLlamaRuntimeForTest, __setLlamaAcquireForTest, __setLlamaPinForTest, materializedLlamaServer, type ResolvedPin } from "./llama_runtime.ts";
import { __resetLocalRuntimeForTest, __setSidecarLauncherForTest, LOCAL_EMBEDDING_DIMENSIONS } from "./local-provider.ts";
import { DEFAULT_API_EMBEDDING_DIMENSIONS } from "./resolve.ts";
import {
    __setEmbeddedModelForTest,
    __setEmbeddingApiKeyForTest,
    __setModelPinForTest,
    acquireModel,
    ensureEmbedderReady,
    runEmbeddingSetup,
    type EmbeddingSetupAnswers,
} from "./setup.ts";

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

/**
 * Pre-materialize the pinned runtime so a local branch's materialization step is a directory check. The
 * sha is irrelevant: a materialized tag dir short-circuits before any acquisition or hashing runs.
 */
function placeMaterializedRuntime(): void {
    __setLlamaPinForTest(pinWith("0".repeat(64)));
    mkdirSync(join(env.llamaServerDir, TEST_TAG), { recursive: true });
    writeFileSync(join(env.llamaServerDir, TEST_TAG, "llama-server"), "#!/bin/sh\n");
}

/**
 * Point the local provider's sidecar at an already-running stub, so a local branch's verification probes
 * `origin` instead of spawning a real `llama-server` against a fake GGUF.
 */
function useStubSidecar(origin: string): void {
    __setSidecarLauncherForTest(() =>
        Promise.resolve(
            ok<{ baseURL: string; origin: string; key: string; stop: () => Promise<void> }, ProviderError>({
                baseURL: `${origin}/v1`,
                origin,
                key: "stub-key",
                stop: () => Promise.resolve(),
            }),
        ),
    );
}

/**
 * Run `body` with `process.stdin.isTTY` forced to `value`. It is a getter at runtime, so redefining it is
 * safe here — the code under test only ever reads it — and forcing it ON is what lets a test assert that
 * an ANSWERED question skips its prompt: with prompting available, a prompt that still ran would stall the
 * run instead of completing it.
 */
async function withTTY<T>(value: boolean, body: () => Promise<T>): Promise<T> {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
    try {
        return await body();
    } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
}

/**
 * Run `body` with `process.stdout` captured, returning its value alongside everything written. clack emits
 * every notice, warning, and success line through `process.stdout.write`, so this both quiets the suite and
 * makes the step's own narration assertable — the env-key notice, the stranding warning, the assumed-width
 * line. Mirrors infra/setup.test.ts's `runSetup` capture. clack's `log` splits on `\n` and never wraps, so
 * a single-line substring assertion against the result is stable regardless of terminal width.
 */
async function captureStdout<T>(body: () => Promise<T>): Promise<{ readonly value: T; readonly output: string }> {
    const chunks: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    try {
        return { value: await body(), output: chunks.join("") };
    } finally {
        write.mockRestore();
    }
}

/**
 * A stub embeddings server on an ephemeral port, standing in for BOTH endpoints this step probes: the
 * OpenAI-compatible `/v1/embeddings` route the api-key branch hits directly, and the extra llama-server
 * routes (`/health`, `/props`, `/tokenize`) the local sidecar's client uses once a stub launcher points it
 * here. One shape for both branches keeps their fixtures identical apart from the width they emit — which
 * is the fact each test is actually about. Every request is recorded so a test can assert both which
 * secret reached the wire and that a skipped probe made no call at all.
 *
 * `rejectWith` makes `/v1/embeddings` answer that HTTP status instead of a vector — the wrong-key /
 * wrong-endpoint case the probe exists to catch. 401 specifically, because the OpenAI SDK does not retry
 * it: a retried status would make the failing-probe test pay the client's backoff for no added coverage.
 */
function startEmbeddingStub(
    dimensions: number,
    rejectWith?: number,
): {
    readonly origin: string;
    readonly requests: { readonly path: string; readonly authorization: string | null }[];
    stop: () => void;
} {
    const requests: { path: string; authorization: string | null }[] = [];
    // Unit vector (all components equal → L2 norm 1), mirroring local-provider.test.ts's fixture.
    const vector = new Array(dimensions).fill(1 / Math.sqrt(dimensions)) as number[];
    const server = Bun.serve({
        port: 0,
        fetch: async (req: Request): Promise<Response> => {
            const url = new URL(req.url);
            requests.push({ path: url.pathname, authorization: req.headers.get("authorization") });
            if (url.pathname === "/health") return new Response("ok");
            if (url.pathname === "/props") return Response.json({ model_path: "/stub.gguf" });
            if (url.pathname === "/tokenize") {
                // The token-exact fit measures with the sidecar's own tokenizer; ~4 chars per token is
                // enough for a one-sentence probe that fits under any budget.
                const body = (await req.json()) as { content: string };
                return Response.json({ tokens: new Array(Math.ceil(body.content.length / 4)).fill(0) });
            }
            if (url.pathname === "/v1/embeddings") {
                if (rejectWith !== undefined) return Response.json({ error: { message: "invalid api key" } }, { status: rejectWith });
                const body = (await req.json()) as { input: string[] };
                const data = body.input.map((_, index) => ({ object: "embedding", index, embedding: vector }));
                return Response.json({ object: "list", data, model: "stub-embed", usage: { prompt_tokens: 0, total_tokens: 0 } });
            }
            return new Response("not found", { status: 404 });
        },
    });
    return { origin: `http://127.0.0.1:${server.port}`, requests, stop: (): void => void server.stop(true) };
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

    test("local mode + model missing → err not_configured, directing to `inflexa setup` and naming the path", async () => {
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath });
        const result = await ensureEmbedderReady();
        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("not_configured");
        // Remediation names the setup command and the config field (works in every install context now),
        // and the missing path so the user sees exactly what the gate looked for.
        expect(e.message).toContain("inflexa setup");
        expect(e.message).toContain(env.embeddingModelPath);
    });

    test("local mode with a custom modelPath gates on THAT path, not the built-in location", async () => {
        // A custom GGUF living somewhere other than env.embeddingModelPath — the built-in location is left
        // absent on purpose, so a gate that (wrongly) checked it instead would fail this.
        const customDir = mkdtempSync(join(tmpdir(), "inflexa-custom-model-"));
        const customPath = join(customDir, "my-model.gguf");
        writeFileSync(customPath, "fake-gguf");
        writeConfigWith({ mode: "local", modelPath: customPath, dimensions: 512 });
        expect(existsSync(env.embeddingModelPath)).toBe(false);
        // Pre-materialize the runtime so the gate returns on the model-present + runtime-present short-circuit.
        __setLlamaPinForTest(pinWith("0".repeat(64)));
        mkdirSync(join(env.llamaServerDir, TEST_TAG), { recursive: true });
        writeFileSync(join(env.llamaServerDir, TEST_TAG, "llama-server"), "#!/bin/sh\n");

        const result = await ensureEmbedderReady();

        expect(result.isOk()).toBe(true);
        rmSync(customDir, { recursive: true, force: true });
    });

    test("local mode with a custom modelPath that is absent → not_configured naming that path", async () => {
        const customPath = join(tmpdir(), "inflexa-absent-model-fixture.gguf");
        rmSync(customPath, { force: true });
        writeConfigWith({ mode: "local", modelPath: customPath });
        const result = await ensureEmbedderReady();
        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("not_configured");
        expect(e.message).toContain(customPath);
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
        const result = await withTTY(false, () => runEmbeddingSetup(false));
        expect(result.isOk()).toBe(true);
        expect(readConfig().embedding.mode).toBe("off");
    });

    test("an answered off acquires nothing", async () => {
        writeConfigWith({ mode: "off" });
        const result = await runEmbeddingSetup(true, { mode: "off" });
        expect(result.isOk()).toBe(true);
        expect(readConfig().embedding.mode).toBe("off");
        // Declined setup acquires nothing: the model path stays empty (no embedded copy, no download).
        expect(existsSync(env.embeddingModelPath)).toBe(false);
    });
});

// --- answered (non-interactive) setup ----------------------------------------
// The answers layer supplies what the prompts would otherwise ask for. These tests drive each answered
// branch end to end against a stub endpoint — a real probe over loopback for api-key, a stub sidecar
// launcher for a custom GGUF — so what is asserted is the CONFIG the step lands on and the requests it
// actually made, not that some internal function was called.
describe("runEmbeddingSetup (answers)", () => {
    afterEach(() => {
        __setEmbeddingApiKeyForTest(null);
        // The sidecar launcher + its lazy-launch cache are process-wide singletons; leaving either set
        // would point a later test's embed at a stopped stub server.
        __setSidecarLauncherForTest(null);
        __resetLocalRuntimeForTest();
    });

    test("the answers layer's `embedding` block is assignable to this module's answer shape", () => {
        // A compile-time pin: the two shapes are declared separately (the setup orchestrator consumes this
        // module, so importing its answers schema back would make the domains mutually dependent), and this
        // assignment is what keeps them from drifting apart.
        const fromAnswersFile: NonNullable<SetupAnswers["embedding"]> = { mode: "api-key", baseURL: "https://gw.corp/v1", model: "my-embed" };
        const answers: EmbeddingSetupAnswers = fromAnswersFile;
        expect(answers.mode).toBe("api-key");
    });

    test("an answered api-key backend probes with the env secret and records the non-default fields, prompting for nothing", async () => {
        writeConfigWith({ mode: "off" });
        const stub = startEmbeddingStub(768);
        __setEmbeddingApiKeyForTest(() => "sk-from-env");
        try {
            // Prompting is AVAILABLE here (interactive + a TTY) and every question is answered, so a prompt
            // that still ran would hang this test rather than pass it — the assertion that answers skip
            // their prompts, including the masked key prompt when the variable is set.
            const result = await withTTY(true, () => runEmbeddingSetup(true, { mode: "api-key", baseURL: `${stub.origin}/v1`, model: "my-embed" }));

            expect(result.isOk()).toBe(true);
            const embedding = readConfig().embedding;
            expect(embedding.mode).toBe("api-key");
            expect(embedding.apiKey).toBe("sk-from-env");
            expect(embedding.baseURL).toBe(`${stub.origin}/v1`);
            expect(embedding.model).toBe("my-embed");
            // The width is MEASURED from the probe's own vectors, not guessed from the model id.
            expect(embedding.dimensions).toBe(768);
            // Exactly one real embed, carrying the environment secret — the only channel that secret travels on.
            expect(stub.requests).toEqual([{ path: "/v1/embeddings", authorization: "Bearer sk-from-env" }]);
        } finally {
            stub.stop();
        }
    });

    test("an exported key is adopted with a notice naming the variable, and the masked prompt never runs", async () => {
        writeConfigWith({ mode: "off" });
        const stub = startEmbeddingStub(768);
        __setEmbeddingApiKeyForTest(() => "sk-from-env");
        // Mocked rather than left real: on a TTY the genuine masked prompt would HANG this test instead of
        // failing it, and the sentinel return makes "the prompt won anyway" visible in the persisted key.
        const secretPrompt = spyOn(prompts, "promptSecret").mockImplementation(async () => "sk-typed-at-the-prompt");
        try {
            const { value: result, output } = await captureStdout(() =>
                withTTY(true, () => runEmbeddingSetup(true, { mode: "api-key", baseURL: `${stub.origin}/v1`, model: "my-embed" })),
            );

            expect(result.isOk()).toBe(true);
            expect(secretPrompt).toHaveBeenCalledTimes(0);
            // The whole point of the notice: an exported key is invisible at the moment it wins, and this
            // one is persisted, so a stale export would otherwise reach config.json unannounced.
            expect(output).toContain(`Using ${EMBEDDING_API_KEY_VAR} from your environment`);
            expect(readConfig().embedding.apiKey).toBe("sk-from-env");
        } finally {
            secretPrompt.mockRestore();
            stub.stop();
        }
    });

    test("validate: false skips the endpoint probe and falls back to the configured width", async () => {
        // The configured width is what the skipped probe would have re-measured, so it — not the provider
        // default — is what an unvalidated run must assume.
        writeConfigWith({ mode: "api-key", apiKey: "sk-previous", dimensions: 3072 });
        const stub = startEmbeddingStub(768);
        __setEmbeddingApiKeyForTest(() => "sk-from-env");
        try {
            const result = await runEmbeddingSetup(false, {
                mode: "api-key",
                baseURL: `${stub.origin}/v1`,
                model: "my-embed",
                validate: false,
            });

            expect(result.isOk()).toBe(true);
            // The whole point of `--no-validate`: nothing on the network was touched.
            expect(stub.requests).toEqual([]);
            const embedding = readConfig().embedding;
            expect(embedding.mode).toBe("api-key");
            expect(embedding.apiKey).toBe("sk-from-env");
            expect(embedding.dimensions).toBe(3072);
        } finally {
            stub.stop();
        }
    });

    test("validate: false never assumes the width a DIFFERENT backend measured", async () => {
        // 768 describes the local GGUF the sidecar measured — it says nothing about what a remote endpoint
        // emits, so an unvalidated api-key run must fall back to the provider default rather than inherit it.
        placeFakeModel();
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath, dimensions: 768 });
        __setEmbeddingApiKeyForTest(() => "sk-from-env");

        const { value: result, output } = await captureStdout(() =>
            runEmbeddingSetup(false, { mode: "api-key", baseURL: "https://gw.corp/v1", model: "my-embed", validate: false }),
        );

        expect(result.isOk()).toBe(true);
        const embedding = readConfig().embedding;
        expect(embedding.mode).toBe("api-key");
        // Minimal config drops a field equal to the provider default, so `undefined` IS the api-key default
        // width — and 768 reached neither the config nor the narration.
        expect(embedding.dimensions).toBeUndefined();
        expect(output).not.toContain("768");
        // The number is presented as an assumption, not a measurement.
        expect(output).toContain(`ASSUMED to be ${DEFAULT_API_EMBEDDING_DIMENSIONS}`);
        // Changing backend at all is what strands the existing indexes, so the switch is announced too.
        expect(output).toContain("SWITCHING EMBEDDING BACKEND (local → api-key)");
    });

    test("a rejected endpoint probe fails the run and leaves the configured backend untouched", async () => {
        placeFakeModel();
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath, dimensions: 512 });
        const stub = startEmbeddingStub(768, 401);
        __setEmbeddingApiKeyForTest(() => "sk-wrong");
        try {
            const result = await runEmbeddingSetup(false, { mode: "api-key", baseURL: `${stub.origin}/v1`, model: "my-embed" });

            expect(result.isErr()).toBe(true);
            expect(result._unsafeUnwrapErr().type).toBe("verify_failed");
            // The probe genuinely reached the endpoint and was rejected there — not a missing secret, not
            // an unresolvable URL, both of which fail earlier and would pass the config assertions below.
            expect(stub.requests.map((r) => r.path)).toEqual(["/v1/embeddings"]);
            // Verification gates the write: a failed probe records nothing, so the previous backend stands
            // and the rejected key is nowhere in config.
            const embedding = readConfig().embedding;
            expect(embedding.mode).toBe("local");
            expect(embedding.modelPath).toBe(env.embeddingModelPath);
            expect(embedding.dimensions).toBe(512);
            expect(embedding.apiKey).toBeUndefined();
        } finally {
            stub.stop();
        }
    });

    test("api-key with no env secret in a run that cannot prompt fails naming the variable, writing nothing", async () => {
        writeConfigWith({ mode: "off" });
        __setEmbeddingApiKeyForTest(() => undefined);

        // The endpoint is deliberately unreachable: the step must fail on the missing secret BEFORE any probe.
        const result = await runEmbeddingSetup(false, { mode: "api-key", baseURL: "https://gw.invalid/v1", model: "my-embed" });

        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("not_configured");
        expect(e.message).toContain("INFLEXA_EMBEDDING_API_KEY");
        expect(readConfig().embedding.mode).toBe("off");
    });

    test("an answered gguf runs the custom branch with no path prompt and records the measured width", async () => {
        writeConfigWith({ mode: "off" });
        const customDir = mkdtempSync(join(tmpdir(), "inflexa-answered-gguf-"));
        const customPath = join(customDir, "my-model.gguf");
        writeFileSync(customPath, "fake-gguf");
        placeMaterializedRuntime();
        const stub = startEmbeddingStub(512);
        useStubSidecar(stub.origin);
        try {
            // Prompting available and unused: the answered path replaces the path prompt.
            const result = await withTTY(true, () => runEmbeddingSetup(true, { mode: "local", gguf: customPath }));

            expect(result.isOk()).toBe(true);
            const embedding = readConfig().embedding;
            expect(embedding.mode).toBe("local");
            expect(embedding.modelPath).toBe(customPath);
            // Measured through the sidecar, not asserted at the built-in 384 — the whole point of the custom branch.
            expect(embedding.dimensions).toBe(512);
            // Nothing was acquired: the user's file IS the model, so the built-in location stays empty.
            expect(existsSync(env.embeddingModelPath)).toBe(false);
        } finally {
            stub.stop();
            rmSync(customDir, { recursive: true, force: true });
        }
    });

    test("an answered gguf with no file at it fails naming the path, leaving the mode unchanged", async () => {
        writeConfigWith({ mode: "off" });
        const absentPath = join(tmpdir(), "inflexa-answered-absent-model.gguf");
        rmSync(absentPath, { force: true });

        const result = await runEmbeddingSetup(false, { mode: "local", gguf: absentPath });

        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        // `acquire_failed`: there is nothing to acquire the model FROM. Naming the path is what makes it
        // actionable — a batch operator sees the typo without re-deriving which answer produced it.
        expect(e.type).toBe("acquire_failed");
        expect(e.message).toContain(absentPath);
        expect(readConfig().embedding.mode).toBe("off");
        // The custom branch acquires nothing even on the happy path, so a failure must not have either.
        expect(existsSync(env.embeddingModelPath)).toBe(false);
    });

    test("an answered off persists mode off over a configured local backend, leaving the model on disk", async () => {
        placeFakeModel();
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath, dimensions: 512 });

        const result = await runEmbeddingSetup(false, { mode: "off" });

        expect(result.isOk()).toBe(true);
        const embedding = readConfig().embedding;
        expect(embedding.mode).toBe("off");
        // Disabling is not forgetting: the recorded backend survives so re-enabling is one word, and the
        // GGUF on disk is never touched.
        expect(embedding.modelPath).toBe(env.embeddingModelPath);
        expect(existsSync(env.embeddingModelPath)).toBe(true);
    });

    test("a config-write failure on the switch-off path reports config_write_failed, never verify_failed", async () => {
        // Nothing is verified when embeddings are switched off, so `verify_failed` there would name a step
        // that never ran. A directory where config.json belongs is the cheapest real write fault: readConfig
        // fails closed to the defaults, and writeConfig's writeFileSync raises EISDIR.
        rmSync(env.configPath, { force: true });
        mkdirSync(env.configPath, { recursive: true });
        try {
            const result = await runEmbeddingSetup(false, { mode: "off" });

            expect(result.isErr()).toBe(true);
            const e = result._unsafeUnwrapErr();
            expect(e.type).toBe("config_write_failed");
            // The underlying fault is what makes it actionable, so it rides the message, not just `cause`.
            expect(e.message).toContain("config.json could not be written");
        } finally {
            // The suite's afterEach reaps configPath as a FILE; a leftover directory would make it throw.
            rmSync(env.configPath, { recursive: true, force: true });
        }
    });

    test("an answered local backend verifies through the sidecar even under --no-validate", async () => {
        // `--no-validate` is scoped to the api-key endpoint's NETWORK probe. Local verification is offline
        // and catches a truncated or wrong GGUF, so it ALWAYS runs — the spec says so explicitly.
        writeConfigWith({ mode: "off" });
        placeFakeModel(); // already present → acquisition is skipped, verification is not
        placeMaterializedRuntime();
        const stub = startEmbeddingStub(LOCAL_EMBEDDING_DIMENSIONS);
        useStubSidecar(stub.origin);
        try {
            const result = await runEmbeddingSetup(false, { mode: "local", validate: false });

            expect(result.isOk()).toBe(true);
            const embedding = readConfig().embedding;
            expect(embedding.mode).toBe("local");
            expect(embedding.modelPath).toBe(env.embeddingModelPath);
            // The probe reached the sidecar: an implementation that let --no-validate skip it would land
            // `mode: "local"` on an unverified model and pass every other assertion here.
            expect(stub.requests.map((r) => r.path)).toContain("/v1/embeddings");
        } finally {
            stub.stop();
        }
    });

    test("batch api-key with no endpoint or model answers probes the CONFIGURED pre-fills", async () => {
        // A prompt-less run resolves each unanswered field to exactly what an empty submit would have
        // produced — the configured value — rather than dying inside a prompt no terminal can render.
        const stub = startEmbeddingStub(1024);
        writeConfigWith({ mode: "api-key", apiKey: "sk-previous", baseURL: `${stub.origin}/v1`, model: "configured-embed" });
        __setEmbeddingApiKeyForTest(() => "sk-from-env");
        try {
            const result = await runEmbeddingSetup(false, { mode: "api-key" });

            expect(result.isOk()).toBe(true);
            const embedding = readConfig().embedding;
            expect(embedding.baseURL).toBe(`${stub.origin}/v1`);
            expect(embedding.model).toBe("configured-embed");
            expect(embedding.dimensions).toBe(1024);
            // The env secret still overrides the recorded one — it is the only channel a key travels on.
            expect(stub.requests).toEqual([{ path: "/v1/embeddings", authorization: "Bearer sk-from-env" }]);
        } finally {
            stub.stop();
        }
    });

    test("batch api-key on an unconfigured machine falls back to the provider DEFAULTS, recording none of them", async () => {
        writeConfigWith({ mode: "off" });
        __setEmbeddingApiKeyForTest(() => "sk-from-env");

        // `validate: false` keeps the default endpoint off the network; what is under test is the pre-fill.
        const result = await runEmbeddingSetup(false, { mode: "api-key", validate: false });

        expect(result.isOk()).toBe(true);
        const embedding = readConfig().embedding;
        expect(embedding.mode).toBe("api-key");
        expect(embedding.apiKey).toBe("sk-from-env");
        // Minimal config: a field that equals the provider default is not persisted, so the defaults can
        // move under the user without a stale copy in their config pinning the old one.
        expect(embedding.baseURL).toBeUndefined();
        expect(embedding.model).toBeUndefined();
        expect(embedding.dimensions).toBeUndefined();
    });
});

// --- the stranding warning ----------------------------------------------------
// Every analysis's search index keeps the width it was built at, so setup warns whenever the backend it is
// about to write may emit a different one. The trigger is the EFFECTIVE width, not the mode: swapping to a
// different GGUF strands indexes exactly as a mode change does — and the new model's width is unknowable
// until the sidecar measures it, so the path difference alone must warn. Re-selecting the same model at the
// same path cannot change anything, and must stay silent or the warning stops meaning something.
describe("runEmbeddingSetup (stranding warning)", () => {
    afterEach(() => {
        __setSidecarLauncherForTest(null);
        __resetLocalRuntimeForTest();
    });

    /** Two GGUF stand-ins in one temp dir, so a swap between them is a genuine model-path change. */
    function twoModels(): { readonly dir: string; readonly first: string; readonly second: string } {
        const dir = mkdtempSync(join(tmpdir(), "inflexa-stranding-"));
        const first = join(dir, "first.gguf");
        const second = join(dir, "second.gguf");
        writeFileSync(first, "fake-gguf");
        writeFileSync(second, "fake-gguf");
        return { dir, first, second };
    }

    test("a local → local swap to a different model path warns", async () => {
        const models = twoModels();
        writeConfigWith({ mode: "local", modelPath: models.first, dimensions: 768 });
        placeMaterializedRuntime();
        const stub = startEmbeddingStub(512);
        useStubSidecar(stub.origin);
        try {
            const { value: result, output } = await captureStdout(() => runEmbeddingSetup(false, { mode: "local", gguf: models.second }));

            expect(result.isOk()).toBe(true);
            expect(output).toContain("SWITCHING EMBEDDING MODEL");
            expect(output).toContain("until each analysis is re-profiled under the new backend.");
            // The mode never changed, and the measured width did — exactly the case a mode-only trigger misses.
            expect(readConfig().embedding.mode).toBe("local");
            expect(readConfig().embedding.dimensions).toBe(512);
        } finally {
            stub.stop();
            rmSync(models.dir, { recursive: true, force: true });
        }
    });

    test("re-selecting the configured model unchanged stays silent", async () => {
        const models = twoModels();
        writeConfigWith({ mode: "local", modelPath: models.first, dimensions: 512 });
        placeMaterializedRuntime();
        const stub = startEmbeddingStub(512);
        useStubSidecar(stub.origin);
        try {
            const { value: result, output } = await captureStdout(() => runEmbeddingSetup(false, { mode: "local", gguf: models.first }));

            expect(result.isOk()).toBe(true);
            // Same mode, same path: nothing about the index width can change, so a warning here would be
            // noise on every idempotent re-run.
            expect(output).not.toContain("SWITCHING EMBEDDING");
            expect(readConfig().embedding.dimensions).toBe(512);
        } finally {
            stub.stop();
            rmSync(models.dir, { recursive: true, force: true });
        }
    });
});

// --- a value answer with no mode ---------------------------------------------
// `gguf`/`baseURL`/`model` name a setting INSIDE a backend; without a mode there is no backend to apply
// them to. The answers resolver rejects the combination upfront, so these tests pin the second line of
// defense: if one arrives anyway, this step must say so rather than return ok having changed nothing.
describe("runEmbeddingSetup (a value answer with no mode)", () => {
    test("on an already-configured machine it is an actionable error, not a silent ok", async () => {
        placeFakeModel();
        writeConfigWith({ mode: "local", modelPath: env.embeddingModelPath });

        // Prompting is available, but a configured machine is deliberately never re-prompted, so the picker
        // — the only thing that could have consumed this answer — never runs.
        const result = await withTTY(true, () => runEmbeddingSetup(true, { gguf: "/brand/new.gguf" }));

        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("invalid_answers");
        expect(e.message).toContain("gguf");
        // Actionable: it names the answer that would make the run coherent.
        expect(e.message).toContain("--embeddings local");
        // And the configured backend is untouched — the error replaces a no-op, it does not add a write.
        expect(readConfig().embedding.modelPath).toBe(env.embeddingModelPath);
    });

    test("in a run that cannot prompt it is the same error, naming every orphaned answer", async () => {
        writeConfigWith({ mode: "off" });

        const result = await runEmbeddingSetup(false, { baseURL: "https://gw.corp/v1", model: "my-embed" });

        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("invalid_answers");
        expect(e.message).toContain("baseURL");
        expect(e.message).toContain("model");
        expect(readConfig().embedding.mode).toBe("off");
    });

    test("`validate` alone is not a value answer — an unanswered block still skips silently", async () => {
        // The orchestrator passes `{ ...answers.embedding, validate }` on EVERY run, so an entirely
        // unanswered embedding block arrives here as `{ validate: true }`. That must stay the genuinely
        // correct early return: an already-configured machine is not re-prompted and not failed.
        writeConfigWith({ mode: "api-key", apiKey: "sk-existing" });

        // A TTY with no picker stub: a run that (wrongly) fell through to the prompt would hang, not pass.
        const result = await withTTY(true, () => runEmbeddingSetup(true, { validate: true }));

        expect(result.isOk()).toBe(true);
        expect(readConfig().embedding.mode).toBe("api-key");
    });
});

// --- the interactive picker ---------------------------------------------------
// The mode comes from the clack `select`, so these stub it and assert that the value answers still thread
// into the branch the user picked — a partially-filled `--config` file composing with the questions it
// left open — and that the picker's "Off / skip" keeps meaning "no opinion".
describe("runEmbeddingSetup (picker)", () => {
    afterEach(() => {
        __setEmbeddingApiKeyForTest(null);
        __setSidecarLauncherForTest(null);
        __resetLocalRuntimeForTest();
    });

    test("the api-key choice consumes the answered endpoint and model, prompting for neither", async () => {
        writeConfigWith({ mode: "off" });
        const stub = startEmbeddingStub(768);
        __setEmbeddingApiKeyForTest(() => "sk-from-env");
        const picker = spyOn(prompts, "select").mockImplementation(async () => "api-key");
        try {
            const result = await withTTY(true, () => runEmbeddingSetup(true, { baseURL: `${stub.origin}/v1`, model: "my-embed" }));

            expect(result.isOk()).toBe(true);
            expect(picker).toHaveBeenCalledTimes(1);
            const embedding = readConfig().embedding;
            expect(embedding.mode).toBe("api-key");
            expect(embedding.baseURL).toBe(`${stub.origin}/v1`);
            expect(embedding.model).toBe("my-embed");
            expect(embedding.dimensions).toBe(768);
            // One probe, carrying the env secret: neither answered field went to a prompt.
            expect(stub.requests).toEqual([{ path: "/v1/embeddings", authorization: "Bearer sk-from-env" }]);
        } finally {
            picker.mockRestore();
            stub.stop();
        }
    });

    test("the custom choice consumes the answered gguf path, skipping the path prompt", async () => {
        writeConfigWith({ mode: "off" });
        const customDir = mkdtempSync(join(tmpdir(), "inflexa-picker-gguf-"));
        const customPath = join(customDir, "my-model.gguf");
        writeFileSync(customPath, "fake-gguf");
        placeMaterializedRuntime();
        const stub = startEmbeddingStub(512);
        useStubSidecar(stub.origin);
        const picker = spyOn(prompts, "select").mockImplementation(async () => "custom");
        try {
            const result = await withTTY(true, () => runEmbeddingSetup(true, { gguf: customPath }));

            expect(result.isOk()).toBe(true);
            const embedding = readConfig().embedding;
            expect(embedding.mode).toBe("local");
            expect(embedding.modelPath).toBe(customPath);
            expect(embedding.dimensions).toBe(512);
        } finally {
            picker.mockRestore();
            stub.stop();
            rmSync(customDir, { recursive: true, force: true });
        }
    });

    test("`Off / skip` writes nothing — the picker means no opinion, unlike an answered off", async () => {
        // Only an unconfigured machine reaches the picker, so this is the state it governs. An answered
        // `off` REWRITES the embedding block; declining at the picker must leave the file byte-identical.
        writeConfigWith({ mode: "off", apiKey: "sk-recorded" });
        const before = readFileSync(env.configPath, "utf8");
        const picker = spyOn(prompts, "select").mockImplementation(async () => "off");
        try {
            const result = await withTTY(true, () => runEmbeddingSetup(true));

            expect(result.isOk()).toBe(true);
            expect(readFileSync(env.configPath, "utf8")).toBe(before);
            // Declining acquires nothing either.
            expect(existsSync(env.embeddingModelPath)).toBe(false);
        } finally {
            picker.mockRestore();
        }
    });
});

// --- acquireModel source routing ---------------------------------------------
// acquireModel is source-aware: a compiled binary copies its build-time embedded asset (no network), a
// source checkout streams the pinned file from HuggingFace, and BOTH byte sources are SHA-256-verified
// before anything lands at the final path. These tests force the install context
// (__setCompiledBinaryForTest), the embedded-asset path (__setEmbeddedModelForTest), and the pin
// (__setModelPinForTest), and stub globalThis.fetch so no test ever touches the real network — a
// recorded fetch call proves a wrongly-taken download branch instead of it being silently exercised.
describe("acquireModel", () => {
    // A small non-gguf payload standing in for the model; its true SHA-256 lets a forced pin pass (or,
    // with a deliberately different hash, fail) verification against either byte source.
    const modelBytes = new TextEncoder().encode("bge-small fixture model bytes — not a real gguf");
    const modelSha256 = new Bun.CryptoHasher("sha256").update(modelBytes).digest("hex");
    const partPath = `${env.embeddingModelPath}.part`;
    const PIN_URL = "https://fixture.invalid/bge-small-en-v1.5-q8_0.gguf";

    // The real fetch, captured ONCE so the per-test stub is always restored regardless of which test set it.
    const realFetch = globalThis.fetch;
    // Temp dirs holding embedded-asset fixtures, reaped in afterEach so no fixture leaks between tests.
    const fixtureDirs: string[] = [];

    /** Write `bytes` to a fresh temp file and return its path, standing in for the compiled binary's embedded asset. */
    function writeEmbeddedFixture(bytes: Uint8Array): string {
        const dir = mkdtempSync(join(tmpdir(), "inflexa-embed-asset-"));
        fixtureDirs.push(dir);
        const path = join(dir, "bge-small-en-v1.5-q8_0.gguf");
        writeFileSync(path, bytes);
        return path;
    }

    /** Stub globalThis.fetch to record each call's URL and serve `bytes`, standing in for the HuggingFace download. */
    function stubFetch(bytes: Uint8Array): { calls: string[] } {
        const spy = { calls: [] as string[] };
        // Test-only replacement of the global fetch: it records call URLs (so a wrongly-taken download
        // branch is caught, not silently exercised) and serves fixture bytes for the source path. The
        // cast is required because a bare recorder is narrower than fetch's overloaded signature; it is
        // sound because this is a test-only substitution restored to realFetch in this describe's afterEach.
        globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
            spy.calls.push(String(input));
            return Promise.resolve(new Response(bytes));
        }) as unknown as typeof globalThis.fetch;
        return spy;
    }

    afterEach(() => {
        globalThis.fetch = realFetch;
        __setCompiledBinaryForTest(null);
        __setEmbeddedModelForTest(null);
        __setModelPinForTest(null);
        // The .part sidecar and any embedded-asset fixture are the two artifacts these tests create
        // outside the paths the top-level afterEach already reaps.
        assertTestSandbox(partPath);
        rmSync(partPath, { force: true });
        for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
        fixtureDirs.length = 0;
    });

    test("compiled context copies the embedded asset with no fetch", async () => {
        __setCompiledBinaryForTest(true);
        __setEmbeddedModelForTest(writeEmbeddedFixture(modelBytes));
        __setModelPinForTest({ url: PIN_URL, sha256: modelSha256 });
        const spy = stubFetch(modelBytes);

        const result = await acquireModel();

        expect(result.isOk()).toBe(true);
        expect(await Bun.file(env.embeddingModelPath).text()).toBe(new TextDecoder().decode(modelBytes));
        expect(spy.calls).toEqual([]);
    });

    test("source context downloads from the pinned URL", async () => {
        __setCompiledBinaryForTest(false);
        __setModelPinForTest({ url: PIN_URL, sha256: modelSha256 });
        const spy = stubFetch(modelBytes);

        const result = await acquireModel();

        expect(result.isOk()).toBe(true);
        expect(existsSync(env.embeddingModelPath)).toBe(true);
        expect(spy.calls).toEqual([PIN_URL]);
    });

    test("checksum mismatch leaves nothing at the final path or a .part sidecar", async () => {
        __setCompiledBinaryForTest(false);
        // A pin hash the fixture bytes cannot produce, so verification must reject the download.
        __setModelPinForTest({ url: PIN_URL, sha256: "0".repeat(64) });
        stubFetch(modelBytes);

        const result = await acquireModel();

        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().type).toBe("acquire_failed");
        expect(existsSync(env.embeddingModelPath)).toBe(false);
        expect(existsSync(partPath)).toBe(false);
    });

    test("compiled context with no embedded asset is an actionable error, never a fetch", async () => {
        __setCompiledBinaryForTest(true);
        // Embedded override left null: in a test process the __INFLEXA_COMPILED__ define is absent, so
        // embeddedModelPath() resolves to null — the "this binary did not embed the model" case.
        const spy = stubFetch(modelBytes);

        const result = await acquireModel();

        expect(result.isErr()).toBe(true);
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("acquire_failed");
        expect(e.message).toContain("Reinstall the official binary");
        expect(spy.calls).toEqual([]);
    });

    test("already-present model skips acquisition in both install contexts", async () => {
        placeFakeModel();
        const spy = stubFetch(modelBytes);

        for (const compiled of [true, false]) {
            __setCompiledBinaryForTest(compiled);
            __setModelPinForTest({ url: PIN_URL, sha256: modelSha256 });

            const result = await acquireModel();

            expect(result.isOk()).toBe(true);
            // The pre-existing fake marker is untouched — neither an embedded copy nor a download ran.
            expect(await Bun.file(env.embeddingModelPath).text()).toBe("fake-gguf");
        }
        expect(spy.calls).toEqual([]);
    });
});
