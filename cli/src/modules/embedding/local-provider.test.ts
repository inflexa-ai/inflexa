import { randomUUIDv7 } from "bun";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "neverthrow";

import type { ProviderError } from "@inflexa-ai/harness";

import { env } from "../../lib/env.ts";
import {
    __resetLocalRuntimeForTest,
    __setProcessScanForTest,
    __setProxyBypassEnabledForTest,
    __setSidecarLauncherForTest,
    __setSpawnForTest,
    __setTokenizeTimeoutForTest,
    createLocalEmbeddingProvider,
    launchWithBinary,
    pollLlamaHealth,
    stopLocalSidecar,
    stopLocalSidecarAndWait,
    sweepOrphanedSidecars,
} from "./local-provider.ts";
import { materializedLlamaServer } from "./llama_runtime.ts";

// A minimal stand-in for AgentSession — the harness client reads only `scope`
// (for a log label) and the noop billing resolver ignores the rest, so any
// structural match satisfies the seam.
const fakeSession = { scope: { kind: "analysis", analysisId: "test" } } as never;

// The launcher handle type is intentionally not exported; a structural literal
// (`baseURL` / `origin` / `key` / `stop`, plus the optional `exited` for the
// crash-recovery tests) satisfies the injected-launcher parameter. `origin` is the
// server root the token-exact fit hits `/tokenize` on.
type StubHandle = {
    readonly baseURL: string;
    readonly origin: string;
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

/** Uniform stub tokenizer: ~4 code units per token. */
function uniformTokens(content: string): number {
    return Math.ceil(content.length / 4);
}

/**
 * Non-uniform stub tokenizer: the first {@link DENSE_PREFIX_CHARS} code units cost
 * ~2 chars/token (dense), the rest ~4 chars/token. Because the fit only ever keeps head
 * prefixes, every candidate shares char 0, so this density is consistent across
 * re-measured prefixes — and a cut scaled to the whole-input average density overshoots,
 * exercising the re-measure loop rather than landing in one round.
 */
const DENSE_PREFIX_CHARS = 400;
function nonUniformTokens(content: string): number {
    const dense = Math.min(content.length, DENSE_PREFIX_CHARS);
    const sparse = Math.max(0, content.length - DENSE_PREFIX_CHARS);
    return Math.ceil(dense / 2) + Math.ceil(sparse / 4);
}

/**
 * Build a fetch handler modeling the real (b9310, verified live) llama-server auth
 * shape: `/health` is PUBLIC (no auth honored; `healthStatus` simulates the 503 it
 * answers during model load), `/props`, `/tokenize`, and `/v1/embeddings` are auth-gated
 * (401 to a wrong or missing key). `/v1/embeddings` returns fixed 384-dim vectors and
 * records the last inputs so the token-exact fit can be asserted from the server's point
 * of view. `/tokenize` returns `{ tokens: number[] }` whose length is the count from the
 * injected `tokenize` model (default {@link uniformTokens}); `tokenizeStatus` forces an
 * error status and `tokenizeHang` holds the request open forever, so the fallback paths
 * are drivable.
 */
function llamaShapedFetch(
    serverKey: string,
    opts?: {
        readonly healthStatus?: number;
        readonly onEmbedInputs?: (inputs: string[]) => void;
        readonly tokenize?: (content: string) => number;
        readonly tokenizeStatus?: number;
        readonly tokenizeHang?: boolean;
        readonly onTokenize?: (content: string) => void;
    },
) {
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
        if (url.pathname === "/tokenize" && req.method === "POST") {
            if (!authed) return new Response("unauthorized", { status: 401 });
            const body = (await req.json()) as { content: string };
            opts?.onTokenize?.(body.content);
            // Never resolve — models a wedged server so the fit's per-request timeout fires.
            if (opts?.tokenizeHang) return new Promise<Response>(() => {});
            if (opts?.tokenizeStatus !== undefined && opts.tokenizeStatus !== 200) return new Response("tokenize error", { status: opts.tokenizeStatus });
            const count = (opts?.tokenize ?? uniformTokens)(body.content);
            return Response.json({ tokens: new Array(count).fill(0) });
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
function startStub(
    expectedKey: string,
    opts?: {
        readonly healthStatus?: number;
        readonly tokenize?: (content: string) => number;
        readonly tokenizeStatus?: number;
        readonly tokenizeHang?: boolean;
    },
) {
    let lastInputs: string[] = [];
    const tokenizeInputs: string[] = [];
    const server = Bun.serve({
        port: 0,
        fetch: llamaShapedFetch(expectedKey, {
            ...opts,
            onEmbedInputs: (inputs) => (lastInputs = inputs),
            onTokenize: (content) => void tokenizeInputs.push(content),
        }),
    });
    return {
        origin: `http://127.0.0.1:${server.port}`,
        getLastInputs: (): string[] => lastInputs,
        getTokenizeInputs: (): string[] => tokenizeInputs,
        getTokenizeCount: (): number => tokenizeInputs.length,
        stop: (): void => void server.stop(true),
    };
}

afterEach(() => {
    // Clear the process-wide sidecar cache and restore every seam so one test's
    // stub/toggle can't leak into the next.
    __resetLocalRuntimeForTest();
    __setSidecarLauncherForTest(null);
    __setSpawnForTest(null);
    __setProcessScanForTest(null);
    __setProxyBypassEnabledForTest(true);
    __setTokenizeTimeoutForTest(null);
});

describe("createLocalEmbeddingProvider (sidecar lifecycle)", () => {
    test("advertises the built-in 384 width by default, and a custom width when given one", () => {
        // The advertised `dimensions` is what the harness sizes each per-analysis index to, so a custom
        // GGUF of another width must be reflected here (not silently pinned to bge-small's 384).
        expect(createLocalEmbeddingProvider({ modelPath: "/model.gguf" }).dimensions).toBe(384);
        expect(createLocalEmbeddingProvider({ modelPath: "/model.gguf", dimensions: 768 }).dimensions).toBe(768);
    });

    test("empty input resolves to ok([]) without launching the sidecar", async () => {
        let launches = 0;
        __setSidecarLauncherForTest(() => {
            launches++;
            return Promise.resolve(
                ok<StubHandle, ProviderError>({ baseURL: "http://127.0.0.1:1/v1", origin: "http://127.0.0.1:1", key: "k", stop: () => Promise.resolve() }),
            );
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
            return Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() }));
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
            return Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() }));
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
        __setSidecarLauncherForTest(() =>
            Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() })),
        );
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

    test("fast path: a <=510-code-unit input embeds with zero /tokenize requests", async () => {
        const key = "test-key-fast";
        const stub = startStub(key);
        __setSidecarLauncherForTest(() =>
            Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() })),
        );
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            const short = "a short one-sentence file description, well under the token budget";
            expect(short.length).toBeLessThanOrEqual(510);
            const vectors = await provider.embed([short], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(vectors).not.toBeNull();
            // Embedded unchanged, and no round-trip: ≤510 code units cannot exceed 510 tokens.
            expect(stub.getLastInputs()).toEqual([short]);
            expect(stub.getTokenizeCount()).toBe(0);
        } finally {
            stub.stop();
        }
    });

    test("recovery: a >510-char input the tokenizer measures <=510 tokens embeds unchanged", async () => {
        const key = "test-key-recovery";
        // ~4 chars/token uniform: 2000 code units → 500 tokens, under the 510 budget.
        const stub = startStub(key, { tokenize: uniformTokens });
        __setSidecarLauncherForTest(() =>
            Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() })),
        );
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            const fits = "abcd ".repeat(400); // 2000 code units — measured (not fast path), yet fits
            expect(fits.length).toBeGreaterThan(510);
            expect(uniformTokens(fits)).toBeLessThanOrEqual(510);
            const vectors = await provider.embed([fits], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(vectors).not.toBeNull();
            // A long document that fits the token budget is embedded WHOLE — no char cap cuts it.
            expect(stub.getLastInputs()).toEqual([fits]);
            // It passed through measurement (the whole-input measure), not the fast path.
            expect(stub.getTokenizeCount()).toBe(1);
        } finally {
            stub.stop();
        }
    });

    test("convergence: an over-budget input with non-uniform density embeds as a verified word-boundary prefix", async () => {
        const key = "test-key-convergence";
        const stub = startStub(key, { tokenize: nonUniformTokens });
        __setSidecarLauncherForTest(() =>
            Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() })),
        );
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            // 3000 code units of space-delimited words; nonUniformTokens measures it well over
            // budget (200 dense + 650 sparse = 850 tokens), so it must be cut and re-measured.
            const over = "abcd ".repeat(600);
            expect(nonUniformTokens(over)).toBeGreaterThan(510);
            const vectors = await provider.embed([over], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(vectors).not.toBeNull();
            const seen = stub.getLastInputs();
            expect(seen.length).toBe(1);
            const embedded = seen[0]!;
            // A head-keeping prefix of the original, cut strictly shorter.
            expect(over.startsWith(embedded)).toBe(true);
            expect(embedded.length).toBeLessThan(over.length);
            // Cut at a word boundary: the original character right after the prefix is a space.
            expect(over[embedded.length]).toBe(" ");
            // The endpoint never saw an over-length input — the embedded text re-measures within
            // budget by the SAME tokenizer.
            expect(nonUniformTokens(embedded)).toBeLessThanOrEqual(510);
        } finally {
            stub.stop();
        }
    });

    test("fallback: /tokenize answering 500 embeds the 510-code-unit hard cut and still succeeds", async () => {
        const key = "test-key-fallback-500";
        const stub = startStub(key, { tokenizeStatus: 500 });
        __setSidecarLauncherForTest(() =>
            Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() })),
        );
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            const over = "abcd ".repeat(600); // 3000 code units, over budget
            const vectors = await provider.embed([over], fakeSession).match(
                (v) => v,
                () => null,
            );
            // The embed succeeds even though measurement failed.
            expect(vectors).not.toBeNull();
            const embedded = stub.getLastInputs()[0]!;
            // Hard cut at 510 code units (word-boundary-backed) — a provable fit with no tokenizer.
            expect(over.startsWith(embedded)).toBe(true);
            expect(embedded.length).toBeLessThanOrEqual(510);
        } finally {
            stub.stop();
        }
    });

    test("fallback: /tokenize hanging past the timeout embeds the 510-code-unit hard cut and still succeeds", async () => {
        const key = "test-key-fallback-hang";
        const stub = startStub(key, { tokenizeHang: true });
        // A short per-request bound so the wedged /tokenize degrades to the fallback fast.
        __setTokenizeTimeoutForTest(100);
        __setSidecarLauncherForTest(() =>
            Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() })),
        );
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            const over = "abcd ".repeat(600);
            const vectors = await provider.embed([over], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(vectors).not.toBeNull();
            const embedded = stub.getLastInputs()[0]!;
            expect(over.startsWith(embedded)).toBe(true);
            expect(embedded.length).toBeLessThanOrEqual(510);
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
            return Promise.resolve(
                ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve(), exited }),
            );
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

    test("watcher ABA guard: a superseded sidecar's late crash does not clobber the replacement's cache", async () => {
        const key = "test-key-aba";
        const stub = startStub(key);
        // Only the FIRST sidecar carries a resolvable exit; the replacement's never
        // settles, so its own watcher stays dormant for the test.
        let crashFirst!: () => void;
        const firstExited = new Promise<number>((resolve) => {
            crashFirst = (): void => resolve(137);
        });
        let launches = 0;
        __setSidecarLauncherForTest(() => {
            launches++;
            const exited = launches === 1 ? firstExited : new Promise<number>(() => {});
            return Promise.resolve(
                ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve(), exited }),
            );
        });
        try {
            const provider = createLocalEmbeddingProvider({ modelPath: "/model.gguf" });
            // Launch 1.
            await provider.embed(["one"], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(launches).toBe(1);

            // Stop supersedes launch 1: bumps the epoch, clears the cache.
            await stopLocalSidecarAndWait();

            // Launch 2 — a fresh spawn now that the cache is clear.
            await provider.embed(["two"], fakeSession).match(
                (v) => v,
                () => null,
            );
            expect(launches).toBe(2);

            // NOW crash sidecar 1, LATE. Its exit watcher fires against the current epoch:
            // the epoch guard recognizes it as superseded and leaves launch 2's cache
            // intact. Remove that guard and the watcher would clear the cache here.
            crashFirst();
            await Bun.sleep(10);

            // Launch 2's cache survived: a third embed reuses it with no new launch.
            await provider.embed(["three"], fakeSession).match(
                (v) => v,
                () => null,
            );
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
            resolveLaunch({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: stopSpy });
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
        __setSidecarLauncherForTest(() =>
            Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() })),
        );
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
        __setSidecarLauncherForTest(() =>
            Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() })),
        );
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
        __setSidecarLauncherForTest(() =>
            Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop: () => Promise.resolve() })),
        );
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
        __setSidecarLauncherForTest(() => Promise.resolve(ok<StubHandle, ProviderError>({ baseURL: `${stub.origin}/v1`, origin: stub.origin, key, stop })));
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
            // A live modeled server never closes its stderr pipe; settled stays pending,
            // matching production. These success/401 paths never await it.
            tailSettled: new Promise<void>(() => {}),
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
                // Already settled: the modeled child has exited and its pipe is closed.
                tailSettled: Promise.resolve(),
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

    test("an old-glibc exec failure surfaces the actionable libc message, not a raw loader dump, and skips the port retry", async () => {
        // Model the Ubuntu < 24 case: the prebuilt binary's dynamic loader aborts at
        // exec because the host glibc is too old, so the child exits immediately with
        // the loader's "version `GLIBC_x.y' not found" line on stderr.
        const loaderLine =
            "/data/inflexa/llama/b9310/llama-server: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by /data/inflexa/llama/b9310/llama-server)";
        let spawns = 0;
        __setSpawnForTest(() => {
            spawns++;
            return ok({
                exited: Promise.resolve(127),
                tail: () => loaderLine,
                tailSettled: Promise.resolve(),
                terminate: () => Promise.resolve(),
            });
        });
        const result = await launchWithBinary("/fake/llama-server", "/model.gguf", 400, 40);
        expect(result.isErr()).toBe(true);
        const error = result._unsafeUnwrapErr();
        // The message explains the cause and the remedy instead of "before becoming ready".
        expect(error.message).toContain("newer C/C++ runtime");
        expect(error.message).toContain('embedding.mode = "api-key"');
        expect(error.message).not.toContain("before becoming ready");
        // The exact loader line is preserved as ground truth for which symbol is missing.
        expect(error.message).toContain("GLIBC_2.39");
        // An incompatible libc is not a port race — no fresh-port second attempt, not retryable.
        expect(spawns).toBe(1);
        expect(error.retryable).toBe(false);
    });

    test("a too-old libstdc++ (GLIBCXX) exec failure is recognized as the same libc-incompatibility, not a generic exit", async () => {
        // libstdc++ is resolved from the system (not bundled), so on a distro whose
        // glibc is new enough but libstdc++ is not (GCC < 12), the loader aborts on a
        // GLIBCXX symbol instead of GLIBC — the classifier must catch that form too.
        const loaderLine =
            "/data/inflexa/llama/b9310/libggml-base.so: /usr/lib/x86_64-linux-gnu/libstdc++.so.6: version `GLIBCXX_3.4.30' not found (required by /data/inflexa/llama/b9310/libggml-base.so)";
        __setSpawnForTest(() =>
            ok({
                exited: Promise.resolve(127),
                tail: () => loaderLine,
                tailSettled: Promise.resolve(),
                terminate: () => Promise.resolve(),
            }),
        );
        const result = await launchWithBinary("/fake/llama-server", "/model.gguf", 400, 40);
        expect(result.isErr()).toBe(true);
        const error = result._unsafeUnwrapErr();
        expect(error.message).toContain("newer C/C++ runtime");
        expect(error.message).toContain("GLIBCXX_3.4.30");
        expect(error.message).not.toContain("before becoming ready");
        expect(error.retryable).toBe(false);
    });

    test("a shutdown mid-launch reaps the in-flight child through the spawn slot", async () => {
        // The child never becomes ready (no server answers) and never exits on its own,
        // so the launch stays in flight until we resolve the exit manually at the end.
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => {
            resolveExit = resolve;
        });
        const terminate = mock(() => Promise.resolve());
        // Signals that spawnFor has run — by the time it resolves, launchWithBinary has
        // synchronously set the module-level spawn slot (no await between them).
        let markSpawned!: () => void;
        const spawnedOnce = new Promise<void>((resolve) => {
            markSpawned = resolve;
        });
        __setSpawnForTest((_bin, _model, _port, _key) => {
            markSpawned();
            return ok({ exited, tail: () => "", tailSettled: Promise.resolve(), terminate });
        });

        // Kick off the launch but do NOT await it; the long health window means readiness
        // never resolves within the test.
        const launchP = launchWithBinary("/fake/llama-server", "/model.gguf", 30_000, 50);
        await spawnedOnce;
        expect(terminate).toHaveBeenCalledTimes(0);

        // Shutdown lands mid-launch: `running` is still null (never promoted), so the reap
        // must reach the in-flight child through the spawn slot. Remove slot tracking and
        // this terminates nothing.
        await stopLocalSidecarAndWait();
        expect(terminate).toHaveBeenCalledTimes(1);

        // Unblock the dangling launch so it resolves and leaves no pending poll behind.
        resolveExit(0);
        await launchP;
    });

    test.skipIf(process.platform === "win32")("tail completeness on early exit through the real drain (marker survives settlement)", async () => {
        // A real short-lived process: writes a marker to stderr, then exits 1. The REAL
        // spawnLlamaServer pipes and drains its stderr, and the exit-failure path awaits
        // the drain's settlement so the marker reaches the failure message rather than
        // racing it. spawnLlamaServer invokes `<serverBin> -m <model> --embeddings ...`,
        // so the script simply ignores its args.
        const marker = `llama-stub-marker-${randomUUIDv7()}`;
        const scriptPath = join(tmpdir(), `llama-stub-${randomUUIDv7()}.sh`);
        await Bun.write(scriptPath, `#!/bin/sh\necho "${marker}" >&2\nexit 1\n`);
        chmodSync(scriptPath, 0o755);
        try {
            const result = await launchWithBinary(scriptPath, "/model.gguf", 2_000, 100, 200);
            expect(result.isErr()).toBe(true);
            // The marker was written to stderr, drained, and — because settlement was
            // awaited — is present in the failure tail.
            expect(result._unsafeUnwrapErr().message).toContain(marker);
        } finally {
            rmSync(scriptPath, { force: true });
        }
    });

    test("a half-open server that accepts but never answers fails at the deadline, not a hang", async () => {
        // Model a process whose port accepts TCP connections but never sends a response.
        // Without the per-request timeout a single readiness fetch would hang forever and
        // defeat the shared deadline; with it, each fetch aborts and the loop ends at the
        // deadline.
        const sockets = new Set<Socket>();
        __setSpawnForTest((_bin, _model, port, _key) => {
            const server = createServer((socket) => {
                sockets.add(socket);
                socket.on("close", () => sockets.delete(socket));
                // Never write or end — hold the connection half-open.
            });
            server.listen(port, "127.0.0.1");
            return ok({
                // Stays alive (never exits) — only the per-request timeout can end the poll.
                exited: new Promise<number>(() => {}),
                tail: (): string => "",
                tailSettled: new Promise<void>(() => {}),
                terminate: (): Promise<void> => {
                    for (const s of sockets) s.destroy();
                    server.close();
                    return Promise.resolve();
                },
            });
        });
        const started = Date.now();
        // Shared deadline 600ms, poll 50ms, per-request timeout 100ms: each fetch aborts
        // at ~100ms and the loop ends at the ~600ms deadline (twice, for the fresh-port
        // retry).
        const result = await launchWithBinary("/fake/llama-server", "/model.gguf", 600, 50, 100);
        const elapsedMs = Date.now() - started;
        expect(result.isErr()).toBe(true);
        // Bounded — proof the per-request timeout defeated the half-open hang. Without it
        // this launch never returns and the test times out.
        expect(elapsedMs).toBeLessThan(5_000);
        // And it waited for the deadline rather than failing instantly.
        expect(elapsedMs).toBeGreaterThanOrEqual(500);
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

describe("sweepOrphanedSidecars (orphan reap decision table)", () => {
    test.skipIf(process.platform === "win32")("kills only the ppid-1 process running our binary; spares live-parented and foreign", async () => {
        const serverBin = "/data/inflexa/llama/b9310/llama-server";
        __setProcessScanForTest(() =>
            Promise.resolve(
                [
                    // Orphan: our binary, reparented to init (ppid 1) → must be killed.
                    `424242     1 ${serverBin} -m /model.gguf --embeddings --host 127.0.0.1 --port 5001`,
                    // Live-parented: our binary, owned by a live CLI (ppid 4242) → spared.
                    `  5555  4242 ${serverBin} -m /model.gguf --embeddings --host 127.0.0.1 --port 5002`,
                    // Foreign: a different command reparented to init → spared (path mismatch).
                    `  7777     1 /usr/local/bin/some-other-daemon --serve`,
                ].join("\n"),
            ),
        );
        const killed: number[] = [];
        // Spy on process.kill so the injected pids are recorded, never actually signalled:
        // the decision is observed through the spy, not against real processes. The cast
        // narrows the recorder to process.kill's exact `(pid, signal?) => true` signature.
        const killSpy = spyOn(process, "kill").mockImplementation(((pid: number): true => {
            killed.push(pid);
            return true;
        }) as typeof process.kill);
        try {
            await sweepOrphanedSidecars(serverBin);
        } finally {
            killSpy.mockRestore();
        }
        expect(killed).toEqual([424242]);
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
