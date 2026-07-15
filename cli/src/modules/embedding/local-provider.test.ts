import { afterEach, describe, expect, test } from "bun:test";

import { __setCompiledBinaryForTest } from "../../lib/install_context.ts";
import { __resetLocalRuntimeForTest, COMPILED_LOCAL_UNAVAILABLE_REASON, createLocalEmbeddingProvider } from "./local-provider.ts";

afterEach(() => {
    // The runtime cache and compiled-context flag are both process-wide singletons; restore them so a
    // load-failure test can't poison a later test in this (or another) file.
    __resetLocalRuntimeForTest();
    __setCompiledBinaryForTest(null);
});

// The real GGUF model is a 36 MB download — the test runs against it only when
// present (the spike left a copy here). In CI without the model, these skip.
// The empty-input case needs no model and always runs.
const SPIKE_MODEL_PATH = "/tmp/opencode/spike-models/bge-small-en-v1.5-q8_0.gguf";
const modelPresent = await Bun.file(SPIKE_MODEL_PATH).exists();

// A minimal stand-in for AgentSession — the local provider ignores it (no
// billing, no identity), so any structural match satisfies the seam.
const fakeSession = { scope: { kind: "analysis", analysisId: "test" } } as never;

// Calling `.match` directly on the ResultAsync (before `await`) keeps the
// neverthrow must-use-result rule satisfied: the rule sees `.match` as a
// handled method on the ResultAsync call expression. Awaiting first would
// interpose an AwaitExpression the rule's parent traversal can't see through.
describe("createLocalEmbeddingProvider", () => {
    test("empty input resolves to ok([]) without loading the model", async () => {
        // Bogus path: the empty-input shortcut returns ok([]) before any load,
        // so the model path is never touched.
        const provider = createLocalEmbeddingProvider({ modelPath: "/nonexistent/path.gguf" });
        const outcome = await provider.embed([], fakeSession).match(
            (v) => v,
            () => null,
        );
        expect(outcome).toEqual([]);
    });

    test("compiled context: an import/load failure is remediated by switching modes, never a setup command", async () => {
        __setCompiledBinaryForTest(true);
        // A bogus path forces `loadRuntime` into its catch (the native import may resolve on a dev
        // machine, but `loadModel` on a missing file cannot) — the same catch the packaged binary hits
        // when `import("node-llama-cpp")` itself never resolves. Both routes must yield switch-modes
        // guidance, not a doomed `inflexa setup --embeddings local`.
        const provider = createLocalEmbeddingProvider({ modelPath: "/nonexistent/compiled-probe.gguf" });
        const message = await provider.embed(["probe"], fakeSession).match(
            () => null,
            (e) => e.message,
        );
        expect(message).not.toBeNull();
        expect(message!).toContain(COMPILED_LOCAL_UNAVAILABLE_REASON);
        expect(message!).toContain("api-key");
        expect(message!).toContain("off");
        expect(message!).not.toContain("inflexa setup");
    });

    describe.skipIf(!modelPresent)("with the real GGUF model", () => {
        test("vectors are 384-dimensional and L2-normalized", async () => {
            const provider = createLocalEmbeddingProvider({ modelPath: SPIKE_MODEL_PATH });
            const vectors = await provider.embed(["The sky is clear and blue today"], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(vectors).not.toBeNull();
            expect(vectors!.length).toBe(1);
            expect(vectors![0]!.length).toBe(384);
            const norm = Math.sqrt(vectors![0]!.reduce((s, v) => s + v * v, 0));
            expect(Math.abs(norm - 1.0)).toBeLessThan(0.001);
        });

        test("a batch of texts embeds preserving input order", async () => {
            const provider = createLocalEmbeddingProvider({ modelPath: SPIKE_MODEL_PATH });
            const texts = ["one", "two", "three", "four", "five"];
            const vectors = await provider.embed(texts, fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(vectors).not.toBeNull();
            expect(vectors!.length).toBe(texts.length);
            for (const v of vectors!) {
                expect(v.length).toBe(384);
                const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
                expect(Math.abs(norm - 1.0)).toBeLessThan(0.001);
            }
        });
    });
});
