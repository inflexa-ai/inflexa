/**
 * CLI-side realization of the harness {@link EmbeddingProvider} seam, backed by a
 * pinned `llama-server` sidecar running `bge-small-en-v1.5` (GGUF, q8_0, 384-dim,
 * CLS pooling baked into the model metadata).
 *
 * The provider does not link any native inference code. On the first `embed()`
 * it materializes the pinned runtime ({@link ensureLlamaServer}), spawns
 * `llama-server --embeddings` bound to loopback on an ephemeral port behind a
 * freshly-minted API key, health-checks it, and then transports embeddings
 * through the harness's own OpenAI-shaped {@link createEmbeddingProvider} pointed
 * at that loopback endpoint. This is the SAME client `api-key` mode uses — the
 * HTTP boundary insulates the product from llama.cpp's daily C-ABI churn, and it
 * makes local mode behave identically in the compiled binary and from source (no
 * `/$bunfs`-reachability gap, so no compiled-context refusal exists anymore).
 *
 * The sidecar is a process-wide singleton: spawned lazily (a process that never
 * embeds never starts it), reused for the process lifetime, and reaped via the
 * shutdown path so it never outlives the CLI. The minted key means a foreign
 * process squatting the same port can never be mistaken for ours — the readiness
 * probe authenticates, so only our server answers 200.
 *
 * llama-server returns L2-normalized 384-dim vectors already (CLS pooling +
 * normalization happen server-side), so this provider does no client-side
 * normalization — vectors are passed through as the store-ready unit vectors.
 *
 * The `session` argument is forwarded to the harness client but drives no local
 * behavior: the local provider does no billing (noop resolver) and needs no
 * identity — it is a pure function of (model, text).
 */

import { createServer } from "node:net";

import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";

import { createEmbeddingProvider, createNoopBillingResolver } from "@inflexa-ai/harness";
import type { AgentSession, EmbeddingProvider, ProviderError } from "@inflexa-ai/harness";

import { onShutdown } from "../../lib/shutdown.ts";
import { ensureLlamaServer } from "./llama_runtime.ts";

export interface LocalEmbeddingProviderDeps {
    /** Absolute path to the GGUF model file (typically `env.embeddingModelPath`). */
    readonly modelPath: string;
}

/**
 * Vector width `bge-small-en-v1.5` emits. Advertised on the provider
 * (`EmbeddingProvider.dimensions`) so the harness sizes each per-analysis
 * pgvector index to it, and used by setup's post-download verification
 * (`setup.ts`) to detect a wrong-model GGUF.
 */
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

/**
 * The model id sent in each `/v1/embeddings` request. llama-server echoes the
 * `model` field back without validating it (a single GGUF is loaded per process),
 * so this is a label, not a selector — it just names what we loaded.
 */
const LOCAL_EMBEDDING_MODEL = "bge-small-en-v1.5";

/**
 * Character budget applied to every input before it reaches the sidecar.
 *
 * bge-small's context ceiling is 512 WordPiece tokens; llama-server answers an
 * over-length input with HTTP 500 ("input is too large to process"), so the
 * guard must live client-side (the harness sends whole documents — step
 * summaries and run syntheses — un-chunked, so over-length inputs do occur). We
 * cannot tokenize without pulling in the model's tokenizer, so we bound by
 * characters: English prose runs ~4 chars/token, and we budget at a deliberately
 * conservative ~3.1 chars/token (512 tokens → 1600 chars, leaving headroom for
 * the 2 special tokens and for token-dense content like citations, markdown, and
 * numbers) so even dense prose stays under 512 and the server never 500s.
 *
 * Truncation (keep the head) is chosen over chunk-then-mean-pool: these inputs
 * are retrieval documents whose salient topic sits up front (a synthesis leads
 * with its overview/conclusions; a summary with its lede), mean-pooling several
 * chunk vectors dilutes that signal and would make local vectors qualitatively
 * unlike the api-key path's, and truncation matches the prior in-process
 * realization (llama.cpp silently truncated to its context) — no retrieval
 * regression, far less code.
 */
const MAX_INPUT_CHARS = 1600;

/**
 * How long to wait for the sidecar's `/health` to answer 200. Warm start is
 * ~0.16s, but the very first spawn on macOS pays a one-time OS malware scan of
 * the fresh binaries (~10s measured); the generous ceiling absorbs that, and
 * setup-time verification runs this same path so the cost is paid there, not on
 * the analysis hot path.
 */
const READINESS_TIMEOUT_MS = 30_000;
/** Gap between readiness polls — short enough that a warm start is near-instant. */
const READINESS_POLL_INTERVAL_MS = 150;

/**
 * A running sidecar, abstracted away from the concrete OS process so the lifecycle
 * is unit-testable against a stub HTTP server (the test launcher returns a handle
 * whose `stop` is a spy and whose `baseURL` points at a `Bun.serve` stub).
 */
type SidecarHandle = {
    /** OpenAI base URL for the harness client — `http://127.0.0.1:<port>/v1`. */
    readonly baseURL: string;
    /** The per-spawn minted key the readiness probe and every request present. */
    readonly key: string;
    /** Terminate the underlying server (SIGTERM). Idempotent from the caller's view. */
    stop(): void;
};

/** Brings up a healthy sidecar for `modelPath`, or explains why it could not. */
type SidecarLauncher = (modelPath: string) => Promise<Result<SidecarHandle, ProviderError>>;

/** A launched sidecar paired with the harness client bound to it. */
type ReadySidecar = {
    readonly handle: SidecarHandle;
    readonly provider: EmbeddingProvider;
};

/**
 * The launcher used by production. Swapped in tests via
 * {@link __setSidecarLauncherForTest} so lazy-spawn/reuse/reap/guard can be
 * exercised without a real subprocess — mirrors the injectable `probe` seam on
 * `firstReadyRuntime` (lib/container.ts).
 */
let launchFor: SidecarLauncher = defaultLaunch;

/**
 * Cached first-launch outcome. A promise so concurrent first `embed()` calls
 * coalesce on one spawn; caches the failure too, so a persistent fault (runtime
 * not materializable) is not re-attempted (with its full readiness timeout) on
 * every call. Cleared by {@link stopLocalSidecar} / the test reset.
 */
let ready: Promise<Result<ReadySidecar, ProviderError>> | null = null;

/** The currently-running sidecar handle, held for reaping. `null` when none is up. */
let running: SidecarHandle | null = null;

/** Guards against registering more than one shutdown reap hook per process. */
let reapHooked = false;

/** Build a `provider`-kind {@link ProviderError} for a local-runtime fault. */
function providerFault(message: string, retryable: boolean): ProviderError {
    return { type: "provider", retryable, message };
}

/**
 * Truncate to {@link MAX_INPUT_CHARS}, backing off to the last word boundary when
 * one sits near the cut so a dangling partial word is not embedded. A single
 * enormous token (rare for these inputs) falls back to the hard cut rather than
 * collapsing the input.
 */
function guardInputLength(text: string): string {
    if (text.length <= MAX_INPUT_CHARS) return text;
    const hardCut = text.slice(0, MAX_INPUT_CHARS);
    const lastSpace = hardCut.lastIndexOf(" ");
    return lastSpace > MAX_INPUT_CHARS * 0.8 ? hardCut.slice(0, lastSpace) : hardCut;
}

/**
 * Bind a throwaway loopback listener on port 0 to learn a free port, then release
 * it. There is a small window between release and the server's bind where another
 * process could claim the port; {@link defaultLaunch} tolerates that by retrying
 * once on a fresh port when readiness fails.
 */
function allocateFreePort(): Promise<Result<number, ProviderError>> {
    return new Promise((resolve) => {
        const srv = createServer();
        srv.once("error", (e) => resolve(err(providerFault(`Could not allocate a local port for the embedding runtime: ${e.message}`, true))));
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            // A listening TCP server's address() is an AddressInfo object; it is only
            // `null`/string before listen or for a unix socket, neither of which applies here.
            const port = typeof addr === "object" && addr !== null ? addr.port : 0;
            srv.close(() => resolve(port > 0 ? ok(port) : err(providerFault("Port allocation returned no port for the embedding runtime.", true))));
        });
    });
}

/**
 * Mint a per-spawn API key. Inline `crypto` (not the proxy's `generateApiKey` —
 * different domain, different key namespace) so a stray same-port process without
 * this exact secret can never pass the sidecar's readiness probe as ours.
 */
function mintApiKey(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return `inflexa-local-${hex}`;
}

/**
 * Spawn `llama-server --embeddings` on loopback. Bun.spawn throws synchronously
 * when the binary is missing (ENOENT); catch it into the `Result` channel so the
 * seam never throws. stdout is discarded (server chatter is CLI noise); stderr is
 * kept for post-mortem if a spawn/health failure needs diagnosing.
 */
function spawnLlamaServer(serverBin: string, modelPath: string, port: number, key: string): Result<{ stop: () => void }, ProviderError> {
    try {
        const proc = Bun.spawn({
            cmd: [serverBin, "-m", modelPath, "--embeddings", "--host", "127.0.0.1", "--port", String(port), "--api-key", key],
            stdout: "ignore",
            stderr: "pipe",
        });
        // SIGTERM is the server's clean-exit signal (<10ms to exit, measured); the
        // shutdown reap and the fresh-port retry both route through this.
        return ok({ stop: () => proc.kill("SIGTERM") });
    } catch (cause) {
        return err(
            providerFault(`Could not start the local embedding runtime (llama-server): ${cause instanceof Error ? cause.message : String(cause)}`, false),
        );
    }
}

/**
 * Poll `${origin}/health` (authenticated with `key`) until it answers 200 or the
 * timeout elapses. Only OUR server answers 200 to the minted key, so a 200
 * uniquely identifies the sidecar we started — a foreign squatter on the port
 * cannot forge it. Exported for the readiness test, which drives it against a
 * stub with a short timeout.
 *
 * @param origin loopback origin without the `/v1` suffix (e.g. `http://127.0.0.1:PORT`)
 */
export async function pollLlamaHealth(
    origin: string,
    key: string,
    timeoutMs: number = READINESS_TIMEOUT_MS,
    intervalMs: number = READINESS_POLL_INTERVAL_MS,
): Promise<Result<void, ProviderError>> {
    const deadline = Date.now() + timeoutMs;
    const healthUrl = `${origin}/health`;
    for (;;) {
        try {
            const res = await fetch(healthUrl, { headers: { Authorization: `Bearer ${key}` } });
            if (res.status === 200) return ok(undefined);
        } catch {
            // Connection refused/reset while the server is still binding is expected
            // during startup — keep polling until the deadline.
        }
        if (Date.now() >= deadline) {
            return err(providerFault(`The local embedding runtime did not become ready within ${Math.round(timeoutMs / 1000)}s.`, true));
        }
        await Bun.sleep(intervalMs);
    }
}

/**
 * Production launcher: materialize the runtime, then allocate a port, mint a key,
 * spawn, and wait for health — retrying once on a fresh port to absorb the tiny
 * port-allocation race. A runtime that cannot be materialized points the user at
 * `inflexa setup --embeddings local`, which succeeds in every install context.
 */
async function defaultLaunch(modelPath: string): Promise<Result<SidecarHandle, ProviderError>> {
    const runtime = await ensureLlamaServer();
    if (runtime.isErr()) {
        return err(
            providerFault(
                `The local embedding runtime could not be prepared: ${runtime.error.message}\n  Run \`inflexa setup --embeddings local\` to (re)install it.`,
                false,
            ),
        );
    }
    const serverBin = runtime.value;

    let lastError: ProviderError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const port = await allocateFreePort();
        if (port.isErr()) {
            lastError = port.error;
            continue;
        }
        const key = mintApiKey();
        const spawned = spawnLlamaServer(serverBin, modelPath, port.value, key);
        // A spawn failure is not a port race (the binary is missing/unrunnable), so
        // surface it immediately rather than burning the retry on the same fault.
        // Re-wrap: the Err's ok-type is the spawn handle, not SidecarHandle.
        if (spawned.isErr()) return err(spawned.error);

        const origin = `http://127.0.0.1:${port.value}`;
        const readyResult = await pollLlamaHealth(origin, key);
        if (readyResult.isOk()) {
            return ok({ baseURL: `${origin}/v1`, key, stop: spawned.value.stop });
        }
        // Never became healthy — possibly a foreign process squatting this port.
        // Reap ours and try a fresh port once.
        spawned.value.stop();
        lastError = readyResult.error;
    }
    return err(lastError ?? providerFault("The local embedding runtime failed to start.", true));
}

/**
 * Make this process's proxy-bypass env cover loopback before any sidecar traffic
 * flows. With `HTTP_PROXY`/`HTTPS_PROXY` set (corporate proxies) and no loopback
 * `NO_PROXY` entry, Bun's fetch routes even `http://127.0.0.1:<port>` requests
 * through the proxy — the sidecar spawns fine but the health poll never reaches
 * it and times out, and every embedding POST would transit the proxy (verified
 * empirically with a dead proxy address). Appending `127.0.0.1`/`localhost` to
 * `NO_PROXY` (both spellings; existing entries preserved) fixes BOTH consumers at
 * once: our health poll and the harness embedding client, which resolves the same
 * process env per request.
 *
 * Mutating our own process env is deliberate: it is the one channel that reaches
 * the harness client's fetch without adding configuration surface, and it is
 * scoped to sidecar launch — a process that never embeds locally never touches
 * it. (lib/env.ts's sole-reader convention governs config READS; this is a
 * targeted mutation with the invariant documented here.) Assignment only, never
 * delete-then-set: after a `delete process.env.NO_PROXY`, Bun (verified on
 * 1.3.14) stops propagating later NO_PROXY assignments to fetch's proxy
 * resolution — plain read-append-assign is the path that works.
 */
function ensureLoopbackProxyBypass(): void {
    /* eslint-disable no-restricted-properties -- env.ts owns config READS; this is the sidecar's
       deliberate loopback-bypass MUTATION of the ambient proxy env (rationale in the JSDoc above). */
    const hosts = ["127.0.0.1", "localhost"];
    for (const name of ["NO_PROXY", "no_proxy"] as const) {
        const entries = (process.env[name] ?? "")
            .split(",")
            .map((e) => e.trim())
            .filter((e) => e.length > 0);
        const missing = hosts.filter((h) => !entries.includes(h));
        if (missing.length > 0) process.env[name] = [...entries, ...missing].join(",");
    }
    /* eslint-enable no-restricted-properties */
}

/**
 * Launch (or reuse) the process-wide sidecar and pair it with a harness client.
 * The client construction and reap-hook registration are the success-side effects;
 * a failed launch is cached so the readiness timeout is paid at most once.
 */
function ensureReady(modelPath: string): Promise<Result<ReadySidecar, ProviderError>> {
    if (ready === null) {
        // Must precede the launch: the health poll inside it and the harness
        // client's later POSTs are both loopback fetches an ambient corporate
        // proxy would otherwise swallow.
        ensureLoopbackProxyBypass();
        ready = launchFor(modelPath).then((launched) =>
            launched.map((handle) => {
                running = handle;
                if (!reapHooked) {
                    reapHooked = true;
                    // Reap on normal process exit so the sidecar never outlives the CLI.
                    onShutdown(async () => stopLocalSidecar());
                }
                // The sidecar is just another loopback OpenAI endpoint, so the local
                // provider IS the harness OpenAI-shaped client pointed at it — no bespoke
                // wire code. Local mode does no billing attribution, hence the noop resolver.
                const provider = createEmbeddingProvider({
                    baseURL: handle.baseURL,
                    token: handle.key,
                    model: LOCAL_EMBEDDING_MODEL,
                    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
                    resolveBilling: createNoopBillingResolver(),
                });
                return { handle, provider };
            }),
        );
    }
    return ready;
}

/**
 * Terminate the running sidecar (SIGTERM) and clear the cache so a later `embed()`
 * would spawn a fresh one. Registered with the shutdown path (no orphan on normal
 * exit) and called by setup's verification to tear the probe server down at once
 * rather than holding it for the process lifetime.
 */
export function stopLocalSidecar(): void {
    const handle = running;
    running = null;
    ready = null;
    if (handle) handle.stop();
}

/**
 * Build the local {@link EmbeddingProvider}. Construction is cheap and side-effect
 * free — the sidecar is spawned lazily on the first non-empty `embed()`.
 */
export function createLocalEmbeddingProvider(deps: LocalEmbeddingProviderDeps): EmbeddingProvider {
    function embed(texts: readonly string[], session: AgentSession): ResultAsync<number[][], ProviderError> {
        // Empty input is a no-op: don't spawn the sidecar just to return nothing.
        // Matches the harness `createEmbeddingProvider` shortcut.
        if (texts.length === 0) return okAsync([]);

        // Guard the 512-token ceiling before anything hits the wire.
        const guarded = texts.map(guardInputLength);

        return new ResultAsync(
            ensureReady(deps.modelPath).then((rs) =>
                rs.match(
                    (sidecar) => sidecar.provider.embed(guarded, session),
                    (e) => errAsync<number[][], ProviderError>(e),
                ),
            ),
        );
    }

    return { embed, dimensions: LOCAL_EMBEDDING_DIMENSIONS };
}

/**
 * TEST ONLY. Override the sidecar launcher (pass `null` to restore the real one).
 * Lets tests point the lifecycle at a stub HTTP server and assert lazy-spawn,
 * reuse, and reap without spawning a real `llama-server`.
 */
export function __setSidecarLauncherForTest(launcher: SidecarLauncher | null): void {
    launchFor = launcher ?? defaultLaunch;
}

/**
 * TEST ONLY. Clear the module-level lazy-launch cache so a subsequent `embed()`
 * re-runs the launcher. Unlike {@link stopLocalSidecar} it does NOT signal the
 * handle — the test owns the stub server's lifecycle. Production never calls this;
 * the sidecar is a process-wide singleton by design.
 */
export function __resetLocalRuntimeForTest(): void {
    ready = null;
    running = null;
}
