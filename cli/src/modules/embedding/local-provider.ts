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
 * embeds never starts it), reused across every embed, and reaped via the shutdown
 * path (SIGTERM escalating to SIGKILL) so it never outlives the CLI — including on a
 * SIGTERM/SIGHUP of the CLI itself. A sidecar that exits after becoming ready
 * invalidates the cache so the next embed respawns; a mid-session crash costs one
 * batch, not the rest of the process lifetime. The minted key travels in the child's
 * environment (`LLAMA_API_KEY`), not argv, so it never shows in the host's process
 * listing. The key protects the data plane — llama-server 401s any `/v1/embeddings`
 * request without it — while readiness is two-phase: llama-server's `/health` is
 * public upstream (it honors no auth and answers 200 to anyone once the model is
 * loaded), so a 200 there signals liveness/load-completion only, and one
 * authenticated `/props` probe must then answer 200 before the launch is declared
 * ready. That gate proves the server on this port holds OUR minted key — end-to-end
 * evidence the key reached the child, and a rejection of any auth-enforcing foreign
 * server. A deliberately keyless impostor bound to our just-allocated ephemeral
 * port is outside the threat model.
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

import type { Subprocess } from "bun";
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
 * How long to wait for the sidecar's whole readiness sequence (`/health` 200,
 * then the authenticated `/props` gate). Warm start is ~0.16s, but the very
 * first spawn on macOS pays a one-time OS malware scan of the fresh binaries
 * (~10s measured); the generous ceiling absorbs that, and setup-time
 * verification runs this same path so the cost is paid there, not on the
 * analysis hot path.
 */
const READINESS_TIMEOUT_MS = 30_000;
/** Gap between readiness polls — short enough that a warm start is near-instant. */
const READINESS_POLL_INTERVAL_MS = 150;

/**
 * Upper bound on the stderr tail retained per spawn. The reader keeps only the
 * trailing window of bytes, so an undrained pipe can never fill and block the
 * server, while still preserving enough of llama-server's last output (model-load
 * errors, bind failures) to attach to a launch failure.
 */
const STDERR_TAIL_BYTES = 8192;

/**
 * Grace given to a SIGTERM'd sidecar before escalating to SIGKILL. The measured
 * clean exit is <10ms, so on the healthy path the escalation timer is cleared long
 * before it fires; the grace only matters for a wedged server that ignores SIGTERM.
 */
const STOP_GRACE_MS = 2_000;

/**
 * A running sidecar, abstracted away from the concrete OS process so the lifecycle
 * is unit-testable against a stub HTTP server (the test launcher returns a handle
 * whose `stop` is a spy and whose `baseURL` points at a `Bun.serve` stub).
 */
type SidecarHandle = {
    /** OpenAI base URL for the harness client — `http://127.0.0.1:<port>/v1`. */
    readonly baseURL: string;
    /**
     * The per-spawn minted key every request presents; the authenticated `/props`
     * gate verified at launch that the server on this port holds it.
     */
    readonly key: string;
    /**
     * Settles (with the exit code) when the underlying process exits. The post-ready
     * watcher hangs off it to invalidate cached readiness after a crash. Optional
     * because a stub launcher that models no OS process omits it; production always
     * sets it from `proc.exited`.
     */
    readonly exited?: Promise<number>;
    /**
     * The child's last {@link STDERR_TAIL_BYTES} of stderr, decoded — the server's
     * own diagnostics for a launch failure. Optional for the same reason as
     * `exited`; production always sets it.
     */
    readonly tail?: () => string;
    /**
     * Terminate the underlying server: SIGTERM, escalating to SIGKILL if it has not
     * exited within {@link STOP_GRACE_MS}. The returned promise settles once the child
     * is truly gone — fire-and-forget callers ignore it, the shutdown hook awaits it
     * so `shutdown()` cannot resolve over an undead child.
     */
    stop(): Promise<void>;
};

/**
 * The low-level handle {@link spawnLlamaServer} returns: the concrete process's exit
 * promise, its continuously-drained stderr tail, and an escalating terminate.
 * {@link launchWithBinary} projects it onto a {@link SidecarHandle} on success.
 */
type SpawnHandle = {
    /** Resolves with the exit code when the child exits (`proc.exited`). */
    readonly exited: Promise<number>;
    /** The last {@link STDERR_TAIL_BYTES} of the child's stderr, decoded. */
    tail(): string;
    /** SIGTERM then SIGKILL after {@link STOP_GRACE_MS}; resolves when the child is gone. */
    terminate(): Promise<void>;
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
 * The spawn step {@link launchWithBinary} uses. A test seam
 * ({@link __setSpawnForTest}) swaps in a stub process — one that exits fast with a
 * canned stderr tail — so the early-exit fast-fail path is exercisable without a
 * real `llama-server`.
 */
let spawnFor: (serverBin: string, modelPath: string, port: number, key: string) => Result<SpawnHandle, ProviderError> = spawnLlamaServer;

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

/**
 * Monotonic launch counter. Captured when a launch begins and compared when it
 * resolves and when its post-ready exit watcher fires; a `stopLocalSidecar*` bumps
 * it to mark any in-flight launch superseded. This is the sole guard against
 * ABA-style staleness now that `ready`/`running` are also written from the async
 * exit watcher (both writers — the watcher and `stopLocalSidecar*` — go through it).
 */
let launchEpoch = 0;

/**
 * Whether {@link ensureReady} applies the loopback proxy bypass before launching.
 * Always true in production; a test flips it off ({@link __setProxyBypassEnabledForTest})
 * to prove the bypass is load-bearing — with it suppressed, a loopback embed behind a
 * poisoned proxy must fail.
 */
let proxyBypassEnabled = true;

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
    // TODO(robustness): the budget is tuned for ~3.1 chars/token English prose. CJK
    // and emoji tokenize far denser (often <1 char/token), so a sub-MAX_INPUT_CHARS
    // input of such text can still cross the model's 512-token ceiling and draw an
    // HTTP 500 for that one request — a bounded per-request failure, not a wedge. The
    // real fix is token-aware truncation, which needs the model's own tokenizer.
    if (text.length <= MAX_INPUT_CHARS) return text;
    const hardCut = text.slice(0, MAX_INPUT_CHARS);
    const lastSpace = hardCut.lastIndexOf(" ");
    return lastSpace > MAX_INPUT_CHARS * 0.8 ? hardCut.slice(0, lastSpace) : hardCut;
}

/**
 * Bind a throwaway loopback listener on port 0 to learn a free port, then release
 * it. There is a small window between release and the server's bind where another
 * process could claim the port; {@link launchWithBinary} tolerates that by retrying
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
 * different domain, different key namespace). The secret cuts both ways: the data
 * plane (`/v1/embeddings`) rejects any caller without it, and the launch-time
 * `/props` gate rejects any server that does not hold it.
 */
function mintApiKey(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return `inflexa-local-${hex}`;
}

/**
 * Continuously drain `stream` into a bounded ~{@link STDERR_TAIL_BYTES} tail. The
 * drain starts at spawn (before health polling) so the pipe can never fill and block
 * the server regardless of how the launch proceeds; the returned closure decodes the
 * retained bytes on demand for a launch-failure message.
 */
function drainStderrTail(stream: ReadableStream<Uint8Array>): () => string {
    let tail = new Uint8Array(0);
    void (async () => {
        const reader = stream.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                const combined = new Uint8Array(tail.length + value.length);
                combined.set(tail, 0);
                combined.set(value, tail.length);
                // Keep only the trailing window — the head is the least useful part of a
                // crash log and dropping it bounds retained memory to the window size.
                tail = combined.length > STDERR_TAIL_BYTES ? combined.slice(combined.length - STDERR_TAIL_BYTES) : combined;
            }
        } catch {
            // The stream errors when the process ends and closes its pipe; the tail
            // captured up to that point is exactly what we want to report.
        } finally {
            reader.releaseLock();
        }
    })();
    // A leading multi-byte char can be sliced mid-sequence when the window rotates;
    // TextDecoder emits a replacement char there, acceptable for a diagnostic tail.
    return () => new TextDecoder().decode(tail);
}

/**
 * SIGTERM the child, escalating to SIGKILL if it has not exited within
 * {@link STOP_GRACE_MS}. Resolves only when the process is actually gone (via
 * `proc.exited`), so an awaiting shutdown hook never returns over an undead child.
 */
async function terminateProcess(proc: Subprocess): Promise<void> {
    proc.kill("SIGTERM");
    const killer = setTimeout(() => proc.kill("SIGKILL"), STOP_GRACE_MS);
    try {
        await proc.exited;
    } finally {
        clearTimeout(killer);
    }
}

/**
 * Spawn `llama-server --embeddings` on loopback. Bun.spawn throws synchronously when
 * the binary is missing (ENOENT); catch it into the `Result` channel so the seam
 * never throws. The minted key rides the child's environment (`LLAMA_API_KEY`, the
 * documented equivalent of `--api-key` for the pinned build) rather than argv, so it
 * never appears in the host's process listing. stdout is discarded (server chatter is
 * CLI noise); stderr is piped and drained into a bounded tail for diagnostics.
 */
function spawnLlamaServer(serverBin: string, modelPath: string, port: number, key: string): Result<SpawnHandle, ProviderError> {
    try {
        const proc = Bun.spawn({
            cmd: [serverBin, "-m", modelPath, "--embeddings", "--host", "127.0.0.1", "--port", String(port)],
            /* eslint-disable no-restricted-properties -- the child inherits the parent's PATH/dyld env so
               llama-server can resolve its colocated shared libraries; LLAMA_API_KEY is layered onto the
               child's own env object only, never onto this process's env, so the secret stays off both the
               host's `ps` listing and the ambient environment. env.ts governs config READS; this is a
               child-process env WRITE, not a read of our own config. */
            env: { ...process.env, LLAMA_API_KEY: key },
            /* eslint-enable no-restricted-properties */
            stdout: "ignore",
            stderr: "pipe",
        });
        return ok({
            exited: proc.exited,
            // `stderr: "pipe"` above makes `proc.stderr` a ReadableStream; the literal
            // option guarantees it, which the general Subprocess type cannot narrow.
            tail: drainStderrTail(proc.stderr),
            terminate: () => terminateProcess(proc),
        });
    } catch (cause) {
        return err(
            providerFault(`Could not start the local embedding runtime (llama-server): ${cause instanceof Error ? cause.message : String(cause)}`, false),
        );
    }
}

/**
 * Poll `${origin}/health` until it answers 200 or the timeout elapses. This is a
 * liveness/load-completion signal ONLY: llama-server's `/health` is public upstream
 * (it honors no auth — verified live against the pinned b9310 binary) and 503s while
 * the model is still loading, so a 200 says "a server on this port has finished
 * loading" and nothing about WHICH server it is. Identity is the separate
 * authenticated `/props` gate ({@link awaitSidecarReady}). Exported for the
 * readiness test, which drives it against a stub with a short timeout.
 *
 * @param origin loopback origin without the `/v1` suffix (e.g. `http://127.0.0.1:PORT`)
 * @param signal aborted by the launch's exit race so a dead-on-startup child does
 *   not leave this loop fetching a dead port until the deadline
 */
export async function pollLlamaHealth(
    origin: string,
    timeoutMs: number = READINESS_TIMEOUT_MS,
    intervalMs: number = READINESS_POLL_INTERVAL_MS,
    signal?: AbortSignal,
): Promise<Result<void, ProviderError>> {
    const deadline = Date.now() + timeoutMs;
    const healthUrl = `${origin}/health`;
    for (;;) {
        if (signal?.aborted) return err(providerFault("Readiness polling was cancelled because the runtime exited.", true));
        try {
            const res = await fetch(healthUrl, { signal });
            if (res.status === 200) return ok(undefined);
        } catch {
            // Connection refused/reset while the server is still binding — or an abort —
            // is expected; the loop decides via the signal and the deadline below.
        }
        if (Date.now() >= deadline) {
            return err(providerFault(`The local embedding runtime did not become ready within ${Math.round(timeoutMs / 1000)}s.`, true));
        }
        await Bun.sleep(intervalMs);
    }
}

/**
 * A readiness failure, annotated with whether retrying on a fresh port could help.
 * A health timeout might be a foreign process squatting the allocated port (the
 * documented port-allocation race), so it is worth one fresh-port attempt; a key
 * rejection is not — the same key would be re-minted and re-delivered the same way.
 */
type ReadinessFailure = {
    /** `false` when a fresh-port retry cannot change the outcome (key rejection). */
    readonly portRetryable: boolean;
    readonly error: ProviderError;
};

/**
 * The full readiness sequence for one launch attempt, both phases sharing one
 * deadline:
 *
 * 1. **Load-completion**: {@link pollLlamaHealth} until the public `/health`
 *    answers 200 (llama-server 503s it during model load).
 * 2. **Identity/auth gate**: one authenticated `GET /props` must answer 200.
 *    `/props` is auth-gated by llama-server when a key is configured, so a 200 to
 *    OUR minted key proves the server on this port holds it — end-to-end evidence
 *    that `LLAMA_API_KEY` reached the child. A 401 means the server holds a
 *    different key (key delivery broke, or a foreign auth-enforcing server owns
 *    the port) and fails the launch outright — not a port race, so not
 *    port-retryable. Anything else (`/props` can briefly 503 while the server
 *    settles) keeps polling within the shared deadline, like phase 1.
 *
 * A keyless server answers `/props` 200 to anything, so this gate cannot reject a
 * deliberately keyless impostor — that impostor is outside the threat model (it
 * would have to squat the just-allocated ephemeral port in a sub-second window).
 */
async function awaitSidecarReady(
    origin: string,
    key: string,
    timeoutMs: number,
    intervalMs: number,
    signal?: AbortSignal,
): Promise<Result<void, ReadinessFailure>> {
    const deadline = Date.now() + timeoutMs;
    const health = await pollLlamaHealth(origin, timeoutMs, intervalMs, signal);
    if (health.isErr()) return err({ portRetryable: true, error: health.error });

    const propsUrl = `${origin}/props`;
    for (;;) {
        if (signal?.aborted) return err({ portRetryable: true, error: providerFault("Readiness polling was cancelled because the runtime exited.", true) });
        try {
            const res = await fetch(propsUrl, { headers: { Authorization: `Bearer ${key}` }, signal });
            if (res.status === 200) return ok(undefined);
            if (res.status === 401) {
                return err({
                    portRetryable: false,
                    error: providerFault(
                        "The local embedding runtime is up but rejected the minted API key (authenticated /props probe answered 401). " +
                            "Either the key did not reach the server through LLAMA_API_KEY, or a foreign llama-server is answering on this port.",
                        false,
                    ),
                });
            }
        } catch {
            // Transient network fault or abort — the signal check and deadline decide.
        }
        if (Date.now() >= deadline) {
            return err({
                portRetryable: true,
                error: providerFault(
                    `The local embedding runtime did not pass its authenticated readiness check within ${Math.round(timeoutMs / 1000)}s.`,
                    true,
                ),
            });
        }
        await Bun.sleep(intervalMs);
    }
}

/**
 * Bring up a healthy sidecar from an already-materialized `serverBin`: allocate a
 * port, mint a key, spawn, and race the readiness sequence ({@link awaitSidecarReady}
 * — public `/health` load-completion, then the authenticated `/props` identity gate)
 * against the child's own exit — retrying once on a fresh port to absorb the tiny
 * port-allocation race. A child that exits before becoming ready fails the attempt
 * the instant the exit is observed (the readiness timeout is a bound, not a
 * sentence); a `/props` key rejection fails the whole launch without the fresh-port
 * retry (re-minting the key cannot fix delivery); and every failure carries the
 * server's stderr tail. Split out from {@link defaultLaunch} — with its spawn step
 * indirected through {@link spawnFor} — so the failure paths are testable without
 * materializing a real runtime.
 */
export async function launchWithBinary(
    serverBin: string,
    modelPath: string,
    healthTimeoutMs: number = READINESS_TIMEOUT_MS,
    healthPollMs: number = READINESS_POLL_INTERVAL_MS,
): Promise<Result<SidecarHandle, ProviderError>> {
    let lastError: ProviderError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const port = await allocateFreePort();
        if (port.isErr()) {
            lastError = port.error;
            continue;
        }
        const key = mintApiKey();
        const spawned = spawnFor(serverBin, modelPath, port.value, key);
        // A spawn failure is not a port race (the binary is missing/unrunnable), so
        // surface it immediately rather than burning the retry on the same fault.
        if (spawned.isErr()) return err(spawned.error);
        const handle = spawned.value;
        const origin = `http://127.0.0.1:${port.value}`;

        // Race readiness against the child's exit. A server that dies during startup
        // (port already bound, unloadable model) fails this attempt as soon as we see
        // the exit; the abort tears down the readiness polling so no loop lingers.
        const pollAbort = new AbortController();
        const readyOrExit = await Promise.race([
            awaitSidecarReady(origin, key, healthTimeoutMs, healthPollMs, pollAbort.signal),
            handle.exited.then((code): Result<void, ReadinessFailure> => {
                pollAbort.abort();
                return err({ portRetryable: true, error: providerFault(`The local embedding runtime exited (code ${code}) before becoming ready.`, true) });
            }),
        ]);
        if (readyOrExit.isOk()) {
            return ok({ baseURL: `${origin}/v1`, key, exited: handle.exited, tail: handle.tail, stop: handle.terminate });
        }
        // Reap ours (a no-op if already gone) and append the server's own stderr so
        // its diagnostics reach the user.
        void handle.terminate();
        const failure = readyOrExit.error;
        const tail = handle.tail().trim();
        lastError =
            tail.length > 0 ? providerFault(`${failure.error.message}\n  llama-server stderr (tail):\n${tail}`, failure.error.retryable) : failure.error;
        if (!failure.portRetryable) return err(lastError);
    }
    return err(lastError ?? providerFault("The local embedding runtime failed to start.", true));
}

/**
 * Production launcher: materialize the pinned runtime, then hand off to
 * {@link launchWithBinary}. A runtime that cannot be materialized points the user at
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
    return launchWithBinary(runtime.value, modelPath);
}

/**
 * Make this process's proxy-bypass env cover loopback before any sidecar traffic
 * flows. With `HTTP_PROXY`/`HTTPS_PROXY` set (corporate proxies) and no loopback
 * `NO_PROXY` entry, Bun's fetch routes even `http://127.0.0.1:<port>` requests through
 * the proxy — the sidecar spawns fine but the health poll never reaches it and times
 * out, and every embedding POST would transit the proxy (verified empirically with a
 * dead proxy address).
 *
 * Both `NO_PROXY` and `no_proxy` spellings are honored by different tools and Bun may
 * consult either; a user's corp-bypass entry can live in just one. So compute the
 * UNION of entries across both spellings, add the loopback hosts, and write that same
 * union back to BOTH — mutating each spelling independently could leave one without
 * the user's corp host. Whichever spelling Bun's fetch prefers, no previously honored
 * entry is shadowed and loopback is always bypassed. This fixes both consumers at once:
 * our health poll and the harness embedding client, which resolves the same process
 * env per request.
 *
 * Mutating our own process env is deliberate: it is the one channel that reaches the
 * harness client's fetch without adding configuration surface, and it is scoped to
 * sidecar launch — a process that never embeds locally never touches it. (lib/env.ts's
 * sole-reader convention governs config READS; this is a targeted mutation with the
 * invariant documented here.) Assignment only, never delete-then-set: after a
 * `delete process.env.NO_PROXY`, Bun (verified on 1.3.14) stops propagating later
 * NO_PROXY assignments to fetch's proxy resolution — plain read-append-assign works.
 */
function ensureLoopbackProxyBypass(): void {
    /* eslint-disable no-restricted-properties -- env.ts owns config READS; this is the sidecar's
       deliberate loopback-bypass MUTATION of the ambient proxy env (rationale in the JSDoc above). */
    const union = new Set<string>();
    for (const name of ["NO_PROXY", "no_proxy"] as const) {
        for (const entry of (process.env[name] ?? "").split(",")) {
            const trimmed = entry.trim();
            if (trimmed.length > 0) union.add(trimmed);
        }
    }
    for (const host of ["127.0.0.1", "localhost"]) union.add(host);
    const merged = [...union].join(",");
    process.env.NO_PROXY = merged;
    process.env.no_proxy = merged;
    /* eslint-enable no-restricted-properties */
}

/**
 * Launch (or reuse) the process-wide sidecar and pair it with a harness client. The
 * client construction and reap-hook registration are the success-side effects; a
 * failed launch is cached so the readiness timeout is paid at most once.
 *
 * The captured launch epoch is compared when the launch resolves and when the
 * post-ready exit watcher fires: a `stopLocalSidecar*` that raced this launch (bumping
 * the epoch) makes the resolving launch reap its own process and cache nothing, and a
 * superseded sidecar's crash never clobbers its replacement's cache.
 */
function ensureReady(modelPath: string): Promise<Result<ReadySidecar, ProviderError>> {
    if (ready === null) {
        // Must precede the launch: the health poll inside it and the harness client's
        // later POSTs are both loopback fetches an ambient corporate proxy would
        // otherwise swallow.
        if (proxyBypassEnabled) ensureLoopbackProxyBypass();
        const epoch = ++launchEpoch;
        ready = launchFor(modelPath).then((launched) =>
            launched.andThen((handle): Result<ReadySidecar, ProviderError> => {
                if (epoch !== launchEpoch) {
                    // A stopLocalSidecar* raced this launch and already cleared the cache;
                    // reap the process we just brought up and cache nothing.
                    void handle.stop();
                    return err(providerFault("The local embedding runtime was stopped while it was still launching.", true));
                }
                running = handle;
                // Post-ready exit watcher: a sidecar that dies after readiness (a crash)
                // invalidates the cached readiness so the next embed() spawns a fresh one —
                // but only while this launch is still current, or a superseded handle's
                // watcher would clobber its replacement's cache.
                if (handle.exited) {
                    void handle.exited.then(() => {
                        if (epoch === launchEpoch) {
                            running = null;
                            ready = null;
                        }
                    });
                }
                if (!reapHooked) {
                    reapHooked = true;
                    // Reap on normal process exit so the sidecar never outlives the CLI; the
                    // awaited form keeps shutdown() from returning over an undead child.
                    onShutdown(stopLocalSidecarAndWait);
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
                return ok({ handle, provider });
            }),
        );
    }
    return ready;
}

/**
 * Terminate the running sidecar (escalating SIGTERM→SIGKILL) and clear the cache so a
 * later `embed()` spawns a fresh one, superseding any in-flight launch. Synchronous
 * fire-and-forget for its existing callers (setup verification, sync shutdown paths);
 * {@link stopLocalSidecarAndWait} is the awaited form the shutdown hook uses so
 * `shutdown()` cannot resolve while the child is undead.
 */
export function stopLocalSidecar(): void {
    void stopLocalSidecarAndWait();
}

/**
 * The awaited termination: same effect as {@link stopLocalSidecar}, but the returned
 * promise settles only once the child has actually exited (through the SIGTERM→SIGKILL
 * escalation). Registered as the shutdown reap hook.
 */
export async function stopLocalSidecarAndWait(): Promise<void> {
    const handle = running;
    running = null;
    ready = null;
    // Supersede any launch in flight: its captured epoch no longer matches, so when it
    // resolves it reaps its own process and caches nothing.
    launchEpoch++;
    if (handle) await handle.stop();
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
 * TEST ONLY. Override the spawn step so a test can inject a stub process — one that
 * exits fast with a canned stderr tail — and drive {@link launchWithBinary}'s
 * early-exit fast-fail without a real `llama-server`. Pass `null` to restore the
 * real spawn.
 */
export function __setSpawnForTest(fn: typeof spawnFor | null): void {
    spawnFor = fn ?? spawnLlamaServer;
}

/**
 * TEST ONLY. Toggle the launch-time loopback proxy bypass. A test suppresses it to
 * prove the bypass is load-bearing (a loopback embed behind a poisoned proxy fails
 * without it). Always enabled in production.
 */
export function __setProxyBypassEnabledForTest(enabled: boolean): void {
    proxyBypassEnabled = enabled;
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
