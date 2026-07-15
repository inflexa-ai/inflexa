import { afterEach, describe, expect, mock, test } from "bun:test";
import { err, ok } from "neverthrow";

import type { ProviderError } from "@inflexa-ai/harness";

import { env } from "../../lib/env.ts";
import { __resetLocalRuntimeForTest, __setSidecarLauncherForTest, createLocalEmbeddingProvider, pollLlamaHealth, stopLocalSidecar } from "./local-provider.ts";
import { materializedLlamaServer } from "./llama_runtime.ts";

// A minimal stand-in for AgentSession — the harness client reads only `scope`
// (for a log label) and the noop billing resolver ignores the rest, so any
// structural match satisfies the seam.
const fakeSession = { scope: { kind: "analysis", analysisId: "test" } } as never;

// The launcher handle type is intentionally not exported; a structural literal
// (`baseURL` / `key` / `stop`) satisfies the injected-launcher parameter.
type StubHandle = { readonly baseURL: string; readonly key: string; stop: () => void };

/** 384-dim unit vector (all components equal → L2 norm 1). */
function fixedVector(): number[] {
    const c = 1 / Math.sqrt(384);
    return new Array(384).fill(c);
}

/**
 * A stub `llama-server`: `/health` answers 200 only to the expected bearer key
 * (401 otherwise), and `/v1/embeddings` returns fixed 384-dim vectors (401 on a
 * bad key). Records the inputs of the last embed call so the over-length guard
 * can be asserted from the server's point of view.
 */
function startStub(expectedKey: string) {
    let lastInputs: string[] = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req): Promise<Response> {
            const url = new URL(req.url);
            const authed = req.headers.get("authorization") === `Bearer ${expectedKey}`;
            if (url.pathname === "/health") {
                return new Response(authed ? "ok" : "unauthorized", { status: authed ? 200 : 401 });
            }
            if (url.pathname === "/v1/embeddings" && req.method === "POST") {
                if (!authed) return Response.json({ error: { message: "invalid api key" } }, { status: 401 });
                const body = (await req.json()) as { input: string[] };
                lastInputs = body.input;
                const data = body.input.map((_, index) => ({ object: "embedding", index, embedding: fixedVector() }));
                return Response.json({ object: "list", data, model: "bge-small-en-v1.5", usage: { prompt_tokens: 0, total_tokens: 0 } });
            }
            return new Response("not found", { status: 404 });
        },
    });
    return { origin: `http://127.0.0.1:${server.port}`, getLastInputs: (): string[] => lastInputs, stop: (): void => void server.stop(true) };
}

afterEach(() => {
    // Clear the process-wide sidecar cache and restore the real launcher so one
    // test's stub can't leak into the next.
    __resetLocalRuntimeForTest();
    __setSidecarLauncherForTest(null);
});

describe("createLocalEmbeddingProvider (sidecar lifecycle)", () => {
    test("empty input resolves to ok([]) without launching the sidecar", async () => {
        let launches = 0;
        __setSidecarLauncherForTest(() => {
            launches++;
            return Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: "http://127.0.0.1:1/v1", key: "k", stop: () => {} }));
        });
        const provider = createLocalEmbeddingProvider({ modelPath: "/nonexistent/path.gguf" });
        const outcome = await provider.embed([], fakeSession).match(
            (v) => v,
            () => null,
        );
        expect(outcome).toEqual([]);
        expect(launches).toBe(0);
    });

    test("lazy spawn on first embed, reused across subsequent embeds", async () => {
        const key = "test-key-reuse";
        const stub = startStub(key);
        let launches = 0;
        __setSidecarLauncherForTest(() => {
            launches++;
            return Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => {} }));
        });
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            expect(launches).toBe(0);

            const first = await provider.embed(["one"], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(first).not.toBeNull();
            expect(launches).toBe(1);

            await provider.embed(["two"], fakeSession).match(
                (v) => v,
                () => null,
            );
            await provider.embed(["three"], fakeSession).match(
                (v) => v,
                () => null,
            );
            // Still one launch — the running sidecar is reused for the process lifetime.
            expect(launches).toBe(1);
        } finally {
            stub.stop();
        }
    });

    test("embed returns 384-dim vectors from the sidecar endpoint", async () => {
        const key = "test-key-vectors";
        const stub = startStub(key);
        __setSidecarLauncherForTest(() => Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => {} })));
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            const vectors = await provider.embed(["a", "b"], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(vectors).not.toBeNull();
            expect(vectors!.length).toBe(2);
            expect(vectors![0]!.length).toBe(384);
            expect(vectors![1]!.length).toBe(384);
        } finally {
            stub.stop();
        }
    });

    test("over-length input is truncated client-side so the server never sees >512 tokens", async () => {
        const key = "test-key-guard";
        const stub = startStub(key);
        __setSidecarLauncherForTest(() => Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => {} })));
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            // Way past the 1600-char budget; the guard must shrink it before the wire.
            const huge = "word ".repeat(20_000);
            const outcome = await provider.embed([huge], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(outcome).not.toBeNull();
            const seen = stub.getLastInputs();
            expect(seen.length).toBe(1);
            expect(seen[0]!.length).toBeLessThanOrEqual(1600);
        } finally {
            stub.stop();
        }
    });

    test("a launch failure surfaces as err(ProviderError) with remediation, never a throw", async () => {
        __setSidecarLauncherForTest(() =>
            Promise.resolve(
                err<StubHandle, ProviderError>({
                    type: "provider",
                    retryable: false,
                    message: "The local embedding runtime could not be prepared: boom\n  Run `inflexa setup --embeddings local` to (re)install it.",
                }),
            ),
        );
        const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
        const message = await provider.embed(["probe"], fakeSession).match(
            () => null,
            (e) => e.message,
        );
        expect(message).not.toBeNull();
        expect(message!).toContain("inflexa setup --embeddings local");
    });

    test("loopback embeds succeed despite a poisoned HTTP_PROXY (launch applies a NO_PROXY bypass)", async () => {
        const key = "test-key-proxy";
        const stub = startStub(key);
        /* eslint-disable no-restricted-properties -- the ambient proxy env IS the scenario under test;
           the frozen `env` object deliberately does not expose proxy variables. */
        const saved = {
            HTTP_PROXY: process.env.HTTP_PROXY,
            http_proxy: process.env.http_proxy,
            NO_PROXY: process.env.NO_PROXY,
            no_proxy: process.env.no_proxy,
        };
        // A dead proxy: nothing listens on port 9 (discard), so any fetch routed
        // through it fails fast — deterministic, no real proxy needed. NO_PROXY
        // deliberately names only a corp host (assignment, NOT delete: Bun stops
        // propagating NO_PROXY to fetch after a delete-then-set), so only the
        // launch-time bypass can make the loopback stub reachable.
        process.env.HTTP_PROXY = "http://127.0.0.1:9";
        process.env.http_proxy = "http://127.0.0.1:9";
        process.env.NO_PROXY = "corp.example.com";
        process.env.no_proxy = "corp.example.com";
        __setSidecarLauncherForTest(() => Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => {} })));
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            const vectors = await provider.embed(["through the bypass"], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(vectors).not.toBeNull();
            expect(vectors![0]!.length).toBe(384);
            // The bypass appended loopback to BOTH spellings and preserved the existing entry.
            expect(process.env.NO_PROXY).toContain("corp.example.com");
            expect(process.env.NO_PROXY).toContain("127.0.0.1");
            expect(process.env.no_proxy).toContain("localhost");
        } finally {
            stub.stop();
            // Restore by ASSIGNMENT (empty string when previously unset): deleting
            // HTTP_PROXY does not propagate to Bun's fetch proxy resolution, so a
            // delete here would leave every later fetch in this test process
            // routed through the dead proxy.
            process.env.HTTP_PROXY = saved.HTTP_PROXY ?? "";
            process.env.http_proxy = saved.http_proxy ?? "";
            process.env.NO_PROXY = saved.NO_PROXY ?? "";
            process.env.no_proxy = saved.no_proxy ?? "";
        }
        /* eslint-enable no-restricted-properties */
    });

    test("stopLocalSidecar SIGTERMs the running sidecar (shutdown reap)", async () => {
        const key = "test-key-reap";
        const stub = startStub(key);
        const stop = mock(() => {});
        __setSidecarLauncherForTest(() => Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop })));
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            await provider.embed(["one"], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(stop).toHaveBeenCalledTimes(0);
            stopLocalSidecar();
            expect(stop).toHaveBeenCalledTimes(1);
        } finally {
            stub.stop();
        }
    });
});

describe("pollLlamaHealth (authenticated readiness)", () => {
    test("resolves ok once /health answers 200 to the minted key", async () => {
        const key = "correct-key";
        const stub = startStub(key);
        try {
            const result = await pollLlamaHealth(stub.origin, key, 2_000, 25);
            expect(result.isOk()).toBe(true);
        } finally {
            stub.stop();
        }
    });

    test("times out to err when the key never authenticates (401 rejected, never mistaken for ready)", async () => {
        const key = "correct-key";
        const stub = startStub(key);
        try {
            // A wrong key gets 401 forever — readiness must not accept it and must
            // fail on the timeout rather than hang.
            const result = await pollLlamaHealth(stub.origin, "wrong-key", 300, 25);
            expect(result.isErr()).toBe(true);
        } finally {
            stub.stop();
        }
    });
});

// Real-sidecar integration: only runs when the pinned runtime is materialized AND
// the GGUF is present (both point into the sandboxed test data dir under the
// bunfig preload, so this skips in CI and normal `bun test`). When artifacts are
// present, it spawns the real llama-server and asserts the true vector shape.
const runtimeBin = materializedLlamaServer();
const modelPresent = await Bun.file(env.embeddingModelPath).exists();
describe.skipIf(runtimeBin === null || !modelPresent)("real llama-server sidecar", () => {
    test("vectors are 384-dimensional and L2-normalized", async () => {
        const provider = createLocalEmbeddingProvider({ modelPath: env.embeddingModelPath });
        try {
            const vectors = await provider.embed(["The sky is clear and blue today"], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(vectors).not.toBeNull();
            expect(vectors!.length).toBe(1);
            expect(vectors![0]!.length).toBe(384);
            const norm = Math.sqrt(vectors![0]!.reduce((s, x) => s + x * x, 0));
            expect(Math.abs(norm - 1.0)).toBeLessThan(0.01);
        } finally {
            stopLocalSidecar();
        }
    });
});
