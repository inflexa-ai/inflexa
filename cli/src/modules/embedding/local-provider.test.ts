import { afterEach, describe, expect, mock, test } from "bun:test";
import { err, ok } from "neverthrow";

import type { ProviderError } from "@inflexa-ai/harness";

import { env } from "../../lib/env.ts";
import {
    __resetLocalRuntimeForTest,
    __setProxyBypassEnabledForTest,
    __setSidecarLauncherForTest,
    __setSpawnForTest,
    createLocalEmbeddingProvider,
    launchWithBinary,
    pollLlamaHealth,
    stopLocalSidecar,
} from "./local-provider.ts";
import { materializedLlamaServer } from "./llama_runtime.ts";

// A minimal stand-in for AgentSession — the harness client reads only `scope`
// (for a log label) and the noop billing resolver ignores the rest, so any
// structural match satisfies the seam.
const fakeSession = { scope: { kind: "analysis", analysisId: "test" } } as never;

// The launcher handle type is intentionally not exported; a structural literal
// (`baseURL` / `key` / `stop`, plus the optional `exited` for the crash-recovery
// tests) satisfies the injected-launcher parameter.
type StubHandle = {
    readonly baseURL: string;
    readonly key: string;
    stop: () => Promise<void>;
    readonly exited?: Promise<number>;
    readonly tail?: () => string;
};

/** 384-dim unit vector (all components equal → L2 norm 1). */
function fixedVector(): number[] {
    const c = 1 / Math.sqrt(384);
    return new Array(384).fill(c);
}

/**
 * Build a fetch handler modeling the real (b9310, verified live) llama-server auth
 * shape: `/health` is PUBLIC (no auth honored; `healthStatus` simulates the 503 it
 * answers during model load), `/props` and `/v1/embeddings` are auth-gated (401 to
 * a wrong or missing key). `/v1/embeddings` returns fixed 384-dim vectors and
 * records the last inputs so the over-length guard can be asserted from the
 * server's point of view.
 */
function llamaShapedFetch(serverKey: string, opts?: { readonly healthStatus?: number; readonly onEmbedInputs?: (inputs: string[]) => void }) {
    return async function fetchHandler(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const authed = req.headers.get("authorization") === `Bearer ${serverKey}`;
        if (url.pathname === "/health") {
            const status = opts?.healthStatus ?? 200;
            return new Response(status === 200 ? "ok" : "loading", { status });
        }
        if (url.pathname === "/props") {
            return authed ? Response.json({ model_path: "/model.gguf" }) : new Response("unauthorized", { status: 401 });
        }
        if (url.pathname === "/v1/embeddings" && req.method === "POST") {
            if (!authed) return Response.json({ error: { message: "invalid api key" } }, { status: 401 });
            const body = (await req.json()) as { input: string[] };
            opts?.onEmbedInputs?.(body.input);
            const data = body.input.map((_, index) => ({ object: "embedding", index, embedding: fixedVector() }));
            return Response.json({ object: "list", data, model: "bge-small-en-v1.5", usage: { prompt_tokens: 0, total_tokens: 0 } });
        }
        return new Response("not found", { status: 404 });
    };
}

/** A {@link llamaShapedFetch} stub on an ephemeral port, for the launcher-level tests. */
function startStub(expectedKey: string, opts?: { readonly healthStatus?: number }) {
    let lastInputs: string[] = [];
    const server = Bun.serve({
        port: 0,
        fetch: llamaShapedFetch(expectedKey, { ...opts, onEmbedInputs: (inputs) => (lastInputs = inputs) }),
    });
    return { origin: `http://127.0.0.1:${server.port}`, getLastInputs: (): string[] => lastInputs, stop: (): void => void server.stop(true) };
}

afterEach(() => {
    // Clear the process-wide sidecar cache and restore every seam so one test's
    // stub/toggle can't leak into the next.
    __resetLocalRuntimeForTest();
    __setSidecarLauncherForTest(null);
    __setSpawnForTest(null);
    __setProxyBypassEnabledForTest(true);
});

describe("createLocalEmbeddingProvider (sidecar lifecycle)", () => {
    test("empty input resolves to ok([]) without launching the sidecar", async () => {
        let launches = 0;
        __setSidecarLauncherForTest(() => {
            launches++;
            return Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: "http://127.0.0.1:1/v1", key: "k", stop: () => Promise.resolve() }));
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
            return Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => Promise.resolve() }));
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

    test("concurrent first embeds coalesce onto a single launch", async () => {
        const key = "test-key-coalesce";
        const stub = startStub(key);
        let launches = 0;
        __setSidecarLauncherForTest(() => {
            launches++;
            return Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => Promise.resolve() }));
        });
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            const results = await Promise.all([
                provider.embed(["a"], fakeSession).match(
                    (v) => v,
                    () => null,
                ),
                provider.embed(["b"], fakeSession).match(
                    (v) => v,
                    () => null,
                ),
                provider.embed(["c"], fakeSession).match(
                    (v) => v,
                    () => null,
                ),
            ]);
            for (const r of results) expect(r).not.toBeNull();
            // Three concurrent first embeds share one spawn — the cached promise coalesces them.
            expect(launches).toBe(1);
        } finally {
            stub.stop();
        }
    });

    test("embed returns 384-dim vectors from the sidecar endpoint", async () => {
        const key = "test-key-vectors";
        const stub = startStub(key);
        __setSidecarLauncherForTest(() => Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => Promise.resolve() })));
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
        __setSidecarLauncherForTest(() => Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => Promise.resolve() })));
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

    test("a sidecar that exits after readiness invalidates the cache so the next embed respawns", async () => {
        const key = "test-key-crash";
        const stub = startStub(key);
        // A controllable exit for the FIRST sidecar; resolving it simulates a crash
        // after the sidecar had already served embeddings.
        let crashFirst!: () => void;
        const firstExited = new Promise<number>((resolve) => {
            crashFirst = (): void => resolve(137);
        });
        let launches = 0;
        __setSidecarLauncherForTest(() => {
            launches++;
            // Only the first handle carries the resolvable exit; the replacement's exit
            // never settles, so its watcher stays dormant.
            const exited = launches === 1 ? firstExited : new Promise<number>(() => {});
            return Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => Promise.resolve(), exited }));
        });
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            const first = await provider.embed(["one"], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(first).not.toBeNull();
            expect(launches).toBe(1);

            // Crash the running sidecar and let the exit watcher run.
            crashFirst();
            await Bun.sleep(10);

            const second = await provider.embed(["two"], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(second).not.toBeNull();
            // The invalidated cache forced a fresh spawn for the second request.
            expect(launches).toBe(2);
        } finally {
            stub.stop();
        }
    });

    test("a stop racing an in-flight launch reaps the launched process and caches nothing", async () => {
        const key = "test-key-race";
        const stub = startStub(key);
        const stopSpy = mock(() => Promise.resolve());
        // Resolve a plain handle and wrap it in ok() inside the launcher's `.then`, so
        // the Result flows through a returned/awaited promise (which the neverthrow
        // lint recognizes as handled) rather than into a void resolver sink.
        let resolveLaunch!: (handle: StubHandle) => void;
        const launchP = new Promise<StubHandle>((resolve) => {
            resolveLaunch = resolve;
        });
        __setSidecarLauncherForTest(() => launchP.then((handle) => ok<StubHandle, ProviderError>(handle)));
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            // Kick off the launch — ensureReady runs synchronously and captures the epoch...
            const embedOutcome = provider.embed(["x"], fakeSession).match(
                () => ({ ok: true }),
                () => ({ ok: false }),
            );
            // ...then stop while it is still in flight: bumps the epoch, clears the cache.
            stopLocalSidecar();
            // Now the launch resolves: the map sees a superseded epoch, reaps its own
            // process, and caches nothing.
            resolveLaunch({ baseURL: `${stub.origin}/v1`, key, stop: stopSpy });
            const outcome = await embedOutcome;
            expect(outcome.ok).toBe(false);
            expect(stopSpy).toHaveBeenCalledTimes(1);
        } finally {
            stub.stop();
        }
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
        __setSidecarLauncherForTest(() => Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => Promise.resolve() })));
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

    test("a single-spelling NO_PROXY bypass is unioned into both spellings at launch", async () => {
        const key = "test-key-union";
        const stub = startStub(key);
        /* eslint-disable no-restricted-properties -- asserting the launch-time proxy-env mutation directly. */
        const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
        // The user set the bypass in ONLY the lowercase spelling; uppercase is empty.
        process.env.NO_PROXY = "";
        process.env.no_proxy = "corp.example.com";
        __setSidecarLauncherForTest(() => Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => Promise.resolve() })));
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            await provider.embed(["x"], fakeSession).match(
                (v) => v,
                () => null,
            );
            // Both spellings now carry the union: the user's corp host plus loopback.
            for (const spelling of [process.env.NO_PROXY, process.env.no_proxy]) {
                expect(spelling).toContain("corp.example.com");
                expect(spelling).toContain("127.0.0.1");
                expect(spelling).toContain("localhost");
            }
        } finally {
            stub.stop();
            process.env.NO_PROXY = saved.NO_PROXY ?? "";
            process.env.no_proxy = saved.no_proxy ?? "";
        }
        /* eslint-enable no-restricted-properties */
    });

    test("with the loopback bypass suppressed, a loopback embed behind a poisoned proxy fails (bypass is load-bearing)", async () => {
        const key = "test-key-neg-proxy";
        const stub = startStub(key);
        /* eslint-disable no-restricted-properties -- the ambient proxy env IS the scenario under test. */
        const saved = {
            HTTP_PROXY: process.env.HTTP_PROXY,
            http_proxy: process.env.http_proxy,
            NO_PROXY: process.env.NO_PROXY,
            no_proxy: process.env.no_proxy,
        };
        // Same dead-proxy setup as the positive test, but NO_PROXY names only a corp
        // host (no loopback) AND the launch-time bypass is suppressed — so every
        // loopback fetch routes through the dead proxy and the embed must fail.
        process.env.HTTP_PROXY = "http://127.0.0.1:9";
        process.env.http_proxy = "http://127.0.0.1:9";
        process.env.NO_PROXY = "corp.example.com";
        process.env.no_proxy = "corp.example.com";
        __setProxyBypassEnabledForTest(false);
        __setSidecarLauncherForTest(() => Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, key, stop: () => Promise.resolve() })));
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            const outcome = await provider.embed(["through the dead proxy"], fakeSession).match(
                () => "ok",
                () => "err",
            );
            // The embedding POST could not reach the loopback stub — proof the bypass matters.
            expect(outcome).toBe("err");
        } finally {
            stub.stop();
            process.env.HTTP_PROXY = saved.HTTP_PROXY ?? "";
            process.env.http_proxy = saved.http_proxy ?? "";
            process.env.NO_PROXY = saved.NO_PROXY ?? "";
            process.env.no_proxy = saved.no_proxy ?? "";
        }
        /* eslint-enable no-restricted-properties */
    });

    test("stopLocalSidecar terminates the running sidecar (shutdown reap)", async () => {
        const key = "test-key-reap";
        const stub = startStub(key);
        const stop = mock(() => Promise.resolve());
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

describe("launchWithBinary (readiness: exit race + authenticated /props gate)", () => {
    // The spawn seam receives the port and minted key launchWithBinary chose, so a
    // "spawned process" can be modeled by binding a real llama-shaped server to that
    // exact port — the readiness sequence then runs against live HTTP, end to end.
    // `serverKey` is what the modeled server holds; passing the minted key models
    // correct LLAMA_API_KEY delivery, a different key models broken delivery / a
    // foreign auth-enforcing server.
    function spawnLlamaShapedServer(port: number, serverKey: string) {
        const server = Bun.serve({ port, fetch: llamaShapedFetch(serverKey) });
        return {
            exited: new Promise<number>(() => {}),
            tail: (): string => "",
            // server.stop's own settle promise is irrelevant to the test — the modeled
            // process is "gone" as soon as the listener closes to new connections.
            terminate: (): Promise<void> => {
                void server.stop(true);
                return Promise.resolve();
            },
        };
    }

    test("launch succeeds when /health answers 200 and the authenticated /props gate accepts the minted key", async () => {
        let spawns = 0;
        __setSpawnForTest((_bin, _model, port, key) => {
            spawns++;
            return ok(spawnLlamaShapedServer(port, key));
        });
        const result = await launchWithBinary("/fake/llama-server", "/model.gguf", 3_000, 25);
        expect(result.isOk()).toBe(true);
        const handle = result._unsafeUnwrap();
        expect(spawns).toBe(1);
        await handle.stop();
    });

    test("a server that passes /health but 401s /props with our key fails the launch naming the key mismatch, without a port retry", async () => {
        let spawns = 0;
        __setSpawnForTest((_bin, _model, port, _key) => {
            spawns++;
            // The server holds a key that is NOT the minted one: /health still 200s
            // (public), but the /props identity gate must 401 our probe.
            return ok(spawnLlamaShapedServer(port, "some-other-servers-key"));
        });
        const result = await launchWithBinary("/fake/llama-server", "/model.gguf", 3_000, 25);
        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().message).toContain("rejected the minted API key");
        // A key rejection is not a port race — no fresh-port second attempt.
        expect(spawns).toBe(1);
    });

    test("a child that exits during startup fails the attempt at once, with the stderr tail, not after the readiness timeout", async () => {
        const stderrTail = "error: failed to load model 'bad.gguf'";
        let terminations = 0;
        __setSpawnForTest(() =>
            ok({
                // Resolve immediately: the child died on startup (unloadable model, bound port).
                exited: Promise.resolve(1),
                tail: () => stderrTail,
                terminate: () => {
                    terminations++;
                    return Promise.resolve();
                },
            }),
        );
        const started = Date.now();
        // A short health window bounds the (aborted) background poll; the exit race
        // decides the attempt in milliseconds regardless of it.
        const result = await launchWithBinary("/fake/llama-server", "/model.gguf", 400, 40);
        const elapsedMs = Date.now() - started;
        expect(result.isErr()).toBe(true);
        // Fast-fail: nowhere near the 30s production readiness timeout.
        expect(elapsedMs).toBeLessThan(5_000);
        const message = result._unsafeUnwrapErr().message;
        expect(message).toContain("before becoming ready");
        expect(message).toContain(stderrTail);
        // Each of the two attempts reaped its (already-exited) process.
        expect(terminations).toBeGreaterThanOrEqual(1);
    });
});

describe("pollLlamaHealth (public load-completion signal)", () => {
    test("resolves ok once /health answers 200 — no auth involved (the endpoint is public upstream)", async () => {
        const stub = startStub("key-never-sent");
        try {
            const result = await pollLlamaHealth(stub.origin, 2_000, 25);
            expect(result.isOk()).toBe(true);
        } finally {
            stub.stop();
        }
    });

    test("times out to err while the server is still loading (/health 503 never accepted as ready)", async () => {
        const stub = startStub("key-never-sent", { healthStatus: 503 });
        try {
            const result = await pollLlamaHealth(stub.origin, 300, 25);
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
