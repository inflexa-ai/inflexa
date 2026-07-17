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
 * Content-token budget every input is fitted under before it reaches the embeddings
 * endpoint.
 *
 * bge-small's hard ceiling is 512 WordPiece positions per input, and llama-server
 * answers an over-length input with HTTP 500 ("input is too large to process"), so the
 * bound MUST hold client-side (the harness sends whole documents — step summaries, run
 * syntheses — un-chunked, so over-length inputs do occur). The budget is 510, not 512:
 * the tokenizer wraps content in a `[CLS]`/`[SEP]` pair that consumes the remaining two
 * positions (measured live — a 590-content-token input is rejected as 592), and
 * `/tokenize` is called WITHOUT special tokens so it measures content only, leaving the
 * pair already reserved here.
 *
 * The bound is token-EXACT, not a chars-per-token estimate: counts come from the ready
 * sidecar's own `/tokenize` — the exact tokenizer of the loaded model, in the process
 * that serves the embed — so an input the fit passes can NEVER be rejected as
 * over-length. A char cap cannot promise that: the only provable char cap is 510 (worst
 * case one token per char), which discards ~⅔ of a typical document, and any higher cap
 * is the same probabilistic bet that let dense prose (~2.69 chars/token) cross 512 and
 * draw a 500. `/tokenize` is the loaded model's own tokenizer — free, no bundled-vocab
 * dependency, and no drift against the model actually loaded.
 *
 * The same 510 doubles as the fast-path length threshold and the fallback cut, both
 * sound because a WordPiece token spans at least one UTF-16 code unit: an input of ≤510
 * code units cannot exceed 510 tokens (skip measurement entirely — the dominant
 * one-sentence-description case pays no round-trip), and a hard cut at 510 code units
 * provably fits with no tokenizer (the deterministic landing zone when measurement
 * fails).
 *
 * Truncation keeps the HEAD rather than chunk-then-mean-pool: these are retrieval
 * documents whose salient topic sits up front (a synthesis leads with its conclusions,
 * a summary with its lede); mean-pooling chunk vectors dilutes that signal and would
 * make local vectors qualitatively unlike the api-key path's single-vector embeds.
 */
const CONTENT_TOKEN_BUDGET = 510;

/**
 * Safety margin on a proportional cut: aim slightly under budget so the first cut
 * typically lands in a single round. A few tokens of headroom traded for convergence —
 * density is near-uniform within a document, so 0.95 almost always fits immediately.
 */
const PROPORTIONAL_MARGIN = 0.95;

/**
 * Measurement rounds after the whole-input measurement before degrading to the fallback:
 * one proportional cut, then one overshoot-scaled shrink. Density can vary within a
 * document (prose lede, then a dense table), so each candidate is re-measured rather
 * than trusting the margin; two rounds converge on essentially every real input, and
 * exhaustion degrades to the provable 510-code-unit cut.
 */
const PROPORTIONAL_ROUNDS = 2;

/**
 * Per-request timeout on a single `/tokenize` call, distinct from any whole-batch bound.
 * A healthy loopback `/tokenize` answers in sub-ms, so on every real path this never
 * fires; it exists solely to bound a half-open server that accepts the connection but
 * never answers. Measurement must never fail an embed, so a timed-out request becomes
 * the deterministic hard-cut fallback rather than a hung embed path.
 */
const TOKENIZE_REQUEST_TIMEOUT_MS = 2_000;

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
 * Per-request timeout on each individual readiness fetch, distinct from the
 * whole-sequence {@link READINESS_TIMEOUT_MS}. A healthy loopback `/health` answers in
 * single-digit ms, and a server still binding refuses the connection immediately (also
 * fast) — so on every real path this never fires. It exists solely to bound a
 * half-open server that accepts the TCP connection but never sends a response: without
 * it, one such `fetch` hangs forever (the shared deadline is only re-checked BETWEEN
 * requests), defeating the advertised bound. Capped at ~13× the poll interval — long
 * enough never to clip a legitimately slow answer, short enough that a timed-out
 * request is retried within the shared deadline rather than after it.
 */
const READINESS_REQUEST_TIMEOUT_MS = 2_000;

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
     * Server root origin (`http://127.0.0.1:<port>`), carried beside `baseURL` because
     * `/tokenize` (the token-exact fit's measurement endpoint) lives at the root, not
     * under `/v1`. The launch site has the origin in scope and records it here so the
     * fit never string-parses it back out of `baseURL`.
     */
    readonly origin: string;
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
    /**
     * Resolves when the stderr drain loop has finished (the pipe closed). The
     * early-exit failure path awaits this before reading {@link tail} so the tail is
     * complete rather than raced — safe there because the child's exit closes the
     * pipe, so the drain settles promptly. Never awaited while the child may still be
     * alive (a plain readiness timeout), where the pipe stays open and this would be
     * unbounded.
     */
    readonly tailSettled: Promise<void>;
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
 * How the orphan sweep enumerates processes. Production shells out to `ps`; a test
 * seam ({@link __setProcessScanForTest}) supplies canned rows so the parse/decision
 * runs without real processes. Returns raw `ps -axo pid=,ppid=,command=` output, one
 * process per line.
 */
type ProcessScan = () => Promise<string>;

/** The process lister {@link sweepOrphanedSidecars} uses; swapped in tests via {@link __setProcessScanForTest}. */
let scanProcesses: ProcessScan = defaultProcessScan;

/**
 * Cached first-launch outcome. A promise so concurrent first `embed()` calls
 * coalesce on one spawn; caches the failure too, so a persistent fault (runtime
 * not materializable) is not re-attempted (with its full readiness timeout) on
 * every call. Cleared by {@link stopLocalSidecar} / the test reset.
 */
let ready: Promise<Result<ReadySidecar, ProviderError>> | null = null;

/** The currently-running sidecar handle, held for reaping. `null` when none is up. */
let running: SidecarHandle | null = null;

/**
 * The in-flight spawn handle, held from the moment {@link spawnLlamaServer} returns
 * until the launch either fails (reaped, then cleared) or is promoted to
 * {@link running}. It closes the reachability gap {@link launchEpoch} cannot: during
 * the launch window (child spawned, readiness pending) `running` is still `null`, so a
 * shutdown landing there would find nothing to reap — {@link stopLocalSidecarAndWait}
 * terminates this slot instead. Set/cleared inside {@link launchWithBinary} (which
 * tests also drive directly), so the slot lives at module scope rather than in the
 * launch.
 */
let spawnSlot: SpawnHandle | null = null;

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

/**
 * Per-request `/tokenize` timeout the fit uses. Its own mutable so a test can drive the
 * measurement-timeout → fallback path fast ({@link __setTokenizeTimeoutForTest}) without
 * waiting the production {@link TOKENIZE_REQUEST_TIMEOUT_MS}. Always the production value
 * in a real run.
 */
let tokenizeRequestTimeoutMs = TOKENIZE_REQUEST_TIMEOUT_MS;

/** Build a `provider`-kind {@link ProviderError} for a local-runtime fault. */
function providerFault(message: string, retryable: boolean): ProviderError {
    return { type: "provider", retryable, message };
}

/**
 * Measure `text`'s content-token count with the ready sidecar's own tokenizer via
 * `POST {origin}/tokenize` — the exact tokenizer of the loaded model, in the same
 * process that serves the embed. The body is `{ content }` and no special tokens are
 * requested, so the count is content-only (the `[CLS]`/`[SEP]` pair is already reserved
 * in {@link CONTENT_TOKEN_BUDGET}). The minted key is sent because the pinned b9310 build
 * key-gates `/tokenize` (verified live against the pinned binary: a missing or wrong key
 * answers 401, the minted key answers 200) — and sending it stays correct even if a
 * future build stopped gating it. The response is `{ "tokens": number[] }`; the count is
 * its length.
 *
 * Returns `Result` per the CLI's error discipline: fetch/JSON throws, a non-200 status,
 * and a malformed body are all bridged into an `err` at the boundary so this never
 * throws. {@link fitInput} consumes the error locally to select the fallback — it never
 * reaches the embed's error channel — so `retryable` is a formality here.
 */
async function tokenizeCount(origin: string, key: string, text: string, timeoutMs: number): Promise<Result<number, ProviderError>> {
    try {
        const res = await fetch(`${origin}/tokenize`, {
            method: "POST",
            headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ content: text }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200) return err(providerFault(`The local embedding runtime's /tokenize endpoint answered ${res.status}.`, true));
        // External JSON: the Array.isArray guard below validates the shape before the
        // count is trusted, so this cast only names the one field we probe.
        const body = (await res.json()) as { tokens?: unknown };
        if (!Array.isArray(body.tokens)) {
            return err(providerFault("The local embedding runtime's /tokenize endpoint returned an unexpected body (no tokens array).", true));
        }
        return ok(body.tokens.length);
    } catch (cause) {
        return err(providerFault(`Measuring token length via /tokenize failed: ${cause instanceof Error ? cause.message : String(cause)}`, true));
    }
}

/**
 * Back a cut off to the last word boundary when a space sits within the final 20% of the
 * cut, so a dangling partial word is dropped without discarding a meaningful tail. A cut
 * whose only near text is a single enormous token (rare for these inputs) is kept as the
 * hard cut.
 */
function truncateAtWordBoundary(text: string, cut: number): string {
    const hardCut = text.slice(0, cut);
    const lastSpace = hardCut.lastIndexOf(" ");
    return lastSpace > cut * 0.8 ? hardCut.slice(0, lastSpace) : hardCut;
}

/**
 * The deterministic fallback: a hard cut at {@link CONTENT_TOKEN_BUDGET} code units,
 * word-boundary-backed. It provably fits with no tokenizer — a WordPiece token spans at
 * least one code unit, so ≤510 code units is ≤510 tokens — so measurement failure or
 * exhausted rounds degrade the input bound, never the embed. Backoff may shorten it
 * slightly, which only drops a partial word and cannot break the ≤510-token guarantee.
 */
function hardCutToBudget(text: string): string {
    return truncateAtWordBoundary(text, CONTENT_TOKEN_BUDGET);
}

/**
 * Cut `text` proportionally to its measured chars-per-token density, aimed at the token
 * budget with the {@link PROPORTIONAL_MARGIN} margin, then backed off to a word boundary.
 * `measuredTokens` is always over {@link CONTENT_TOKEN_BUDGET} at the call sites, so the
 * target is strictly shorter than `text` and the fit makes progress every round.
 */
function proportionalCut(text: string, measuredTokens: number): string {
    const target = Math.floor(CONTENT_TOKEN_BUDGET * (text.length / measuredTokens) * PROPORTIONAL_MARGIN);
    return truncateAtWordBoundary(text, target);
}

/**
 * Fit one input under the token budget against the ready sidecar, keeping the head:
 *
 * 1. ≤{@link CONTENT_TOKEN_BUDGET} code units → unchanged, no round-trip (a token spans
 *    ≥1 code unit, so it cannot be over budget).
 * 2. Measure the whole input; at or under budget → unchanged (a long document that
 *    actually fits is embedded whole, not cut by a worst-case char cap).
 * 3. Over budget → cut proportionally to the measured density and re-measure, up to
 *    {@link PROPORTIONAL_ROUNDS} rounds (each round re-scales by the latest overshoot).
 * 4. Rounds exhausted, or ANY `/tokenize` failure → {@link hardCutToBudget}.
 *
 * Never rejects: every path yields a fitting string, so measurement can never fail an
 * embed.
 */
async function fitInput(origin: string, key: string, text: string): Promise<string> {
    if (text.length <= CONTENT_TOKEN_BUDGET) return text;

    const whole = await tokenizeCount(origin, key, text, tokenizeRequestTimeoutMs);
    if (whole.isErr()) return hardCutToBudget(text);
    if (whole.value <= CONTENT_TOKEN_BUDGET) return text;

    let candidate = text;
    let measured = whole.value;
    for (let round = 0; round < PROPORTIONAL_ROUNDS; round++) {
        candidate = proportionalCut(candidate, measured);
        const remeasured = await tokenizeCount(origin, key, candidate, tokenizeRequestTimeoutMs);
        if (remeasured.isErr()) return hardCutToBudget(text);
        if (remeasured.value <= CONTENT_TOKEN_BUDGET) return candidate;
        measured = remeasured.value;
    }
    return hardCutToBudget(text);
}

/**
 * Fit every input in a batch under the token budget against the ready sidecar. Fitted in
 * order; the dominant short-input case returns synchronously with no round-trip, and only
 * over-length inputs pay measurement.
 */
async function fitInputs(handle: SidecarHandle, texts: readonly string[]): Promise<string[]> {
    const fitted: string[] = [];
    for (const text of texts) fitted.push(await fitInput(handle.origin, handle.key, text));
    return fitted;
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
 * the server regardless of how the launch proceeds.
 *
 * Returns both the on-demand decoder (`tail`) and `settled`, which resolves when the
 * reader loop finishes (the pipe closed). The early-exit failure path awaits `settled`
 * before reading `tail` so the final diagnostics are captured rather than raced: the
 * drain is a background loop, so `proc.exited` can resolve a tick before the loop has
 * consumed the last chunk. `settled` never rejects — the reader swallows the
 * pipe-closed error and always runs its `finally`.
 */
function drainStderrTail(stream: ReadableStream<Uint8Array>): { tail(): string; settled: Promise<void> } {
    let tail = new Uint8Array(0);
    const settled = (async (): Promise<void> => {
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
    return {
        // A leading multi-byte char can be sliced mid-sequence when the window rotates;
        // TextDecoder emits a replacement char there, acceptable for a diagnostic tail.
        tail: () => new TextDecoder().decode(tail),
        settled,
    };
}

/**
 * Memoized termination promises, keyed by the child process. The reap can be requested
 * more than once for the same child (the fire-and-forget {@link stopLocalSidecar} and
 * the awaited shutdown hook can both fire, and a failed launch reaps its own handle),
 * and each request must send ONE SIGTERM and arm ONE SIGKILL timer — not stack
 * duplicate signals and timers. A `WeakMap` so a reaped child's entry is collectable
 * once the handle is dropped.
 */
const terminations = new WeakMap<Subprocess, Promise<void>>();

/**
 * SIGTERM the child, escalating to SIGKILL if it has not exited within
 * {@link STOP_GRACE_MS}. Resolves only when the process is actually gone (via
 * `proc.exited`), so an awaiting shutdown hook never returns over an undead child.
 * Idempotent: repeated calls return the first call's promise, so the signal and the
 * escalation timer are issued exactly once per process.
 */
function terminateProcess(proc: Subprocess): Promise<void> {
    const existing = terminations.get(proc);
    if (existing !== undefined) return existing;
    const done = (async (): Promise<void> => {
        proc.kill("SIGTERM");
        const killer = setTimeout(() => proc.kill("SIGKILL"), STOP_GRACE_MS);
        try {
            await proc.exited;
        } finally {
            clearTimeout(killer);
        }
    })();
    terminations.set(proc, done);
    return done;
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
        // `stderr: "pipe"` above makes `proc.stderr` a ReadableStream; the literal
        // option guarantees it, which the general Subprocess type cannot narrow.
        const drain = drainStderrTail(proc.stderr);
        return ok({
            exited: proc.exited,
            tail: drain.tail,
            tailSettled: drain.settled,
            terminate: () => terminateProcess(proc),
        });
    } catch (cause) {
        return err(
            providerFault(`Could not start the local embedding runtime (llama-server): ${cause instanceof Error ? cause.message : String(cause)}`, false),
        );
    }
}

/**
 * The abort signal for a single readiness `fetch`: the child-exit signal (if present)
 * OR-combined with a fresh per-request timeout. Without the timeout, a half-open
 * server that accepts the connection but never answers hangs one `fetch` forever, and
 * because the shared deadline is only re-checked between requests, that one hang
 * defeats the whole bound. The timeout converts the hang into an ordinary aborted
 * request; the poll loop then treats it exactly like a refused connection and keeps
 * polling until the shared deadline. The exit signal aborting is the separate,
 * terminal case (the loop checks it and stops).
 */
function readinessRequestSignal(requestTimeoutMs: number, exitSignal?: AbortSignal): AbortSignal {
    const perRequest = AbortSignal.timeout(requestTimeoutMs);
    return exitSignal ? AbortSignal.any([exitSignal, perRequest]) : perRequest;
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
 * @param requestTimeoutMs per-fetch bound so a half-open server cannot hang a single
 *   request past the shared deadline (parameterized so tests can drive it fast)
 */
export async function pollLlamaHealth(
    origin: string,
    timeoutMs: number = READINESS_TIMEOUT_MS,
    intervalMs: number = READINESS_POLL_INTERVAL_MS,
    signal?: AbortSignal,
    requestTimeoutMs: number = READINESS_REQUEST_TIMEOUT_MS,
): Promise<Result<void, ProviderError>> {
    const deadline = Date.now() + timeoutMs;
    const healthUrl = `${origin}/health`;
    for (;;) {
        if (signal?.aborted) return err(providerFault("Readiness polling was cancelled because the runtime exited.", true));
        try {
            const res = await fetch(healthUrl, { signal: readinessRequestSignal(requestTimeoutMs, signal) });
            if (res.status === 200) return ok(undefined);
        } catch {
            // Connection refused/reset while the server is still binding, a per-request
            // timeout against a half-open server, or an exit abort — all expected; the
            // loop decides via the exit signal and the deadline below.
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
    /**
     * `true` only when the child exited before readiness. The exit closes the stderr
     * pipe, so {@link launchWithBinary} can await the drain's settlement for a complete
     * tail; a plain-timeout failure (child possibly still alive) leaves this unset and
     * the tail is read as-is.
     */
    readonly fromExit?: boolean;
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
    requestTimeoutMs: number = READINESS_REQUEST_TIMEOUT_MS,
): Promise<Result<void, ReadinessFailure>> {
    const deadline = Date.now() + timeoutMs;
    const health = await pollLlamaHealth(origin, timeoutMs, intervalMs, signal, requestTimeoutMs);
    if (health.isErr()) return err({ portRetryable: true, error: health.error });

    const propsUrl = `${origin}/props`;
    for (;;) {
        if (signal?.aborted) return err({ portRetryable: true, error: providerFault("Readiness polling was cancelled because the runtime exited.", true) });
        try {
            const res = await fetch(propsUrl, { headers: { Authorization: `Bearer ${key}` }, signal: readinessRequestSignal(requestTimeoutMs, signal) });
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
 * The dynamic loader's signature of "this prebuilt binary needs a newer C/C++
 * runtime than this host provides". The pinned llama.cpp Linux artifact is built on
 * the Ubuntu 22.04 toolchain and resolves — from the SYSTEM, not the archive, which
 * bundles only the ggml/llama `.so`s — glibc `libc.so.6`, libstdc++ `libstdc++.so.6`,
 * and libgomp. Its floor (measured on the pinned b9310 ubuntu-x64 artifact) is
 * glibc >= 2.34 and libstdc++/CXXABI from GCC 12 (max GLIBC_2.34, GLIBCXX_3.4.30,
 * CXXABI_1.3.13), i.e. Ubuntu 22.04 / Debian 12 or newer. On an older release
 * (Ubuntu 20.04 / Debian 11 → glibc 2.31, libstdc++ < 3.4.30) `ld.so` aborts
 * llama-server at exec time — before it binds a port — with a line like
 *   `.../libc.so.6: version `GLIBC_2.34' not found (required by .../libggml-base.so)`.
 * The child then exits immediately, so {@link launchWithBinary}'s exit race would
 * otherwise report a bare "exited before becoming ready" wrapping the raw loader
 * dump. Matching the line lets us swap in an actionable message instead.
 *
 * Covers the glibc (`GLIBC_`), libstdc++ (`GLIBCXX_`), and C++ ABI (`CXXABI_`)
 * version-symbol forms; the chars between the version and `not found` (a
 * backtick+quote pair the loader prints, or a bare space on variants that omit the
 * quotes) are matched loosely.
 */
const INCOMPATIBLE_LIBC = /(?:GLIBC(?:XX)?|CXXABI)_[0-9.]+.{0,3}not found/;

/**
 * The user-facing explanation for an {@link INCOMPATIBLE_LIBC} launch failure,
 * carrying the exact loader line (the ground truth for which symbol is missing) so
 * the prose never leans solely on a version floor that a pin bump could move.
 */
function incompatibleLibcMessage(stderrTail: string): string {
    const loaderLine =
        stderrTail
            .split("\n")
            .find((line) => INCOMPATIBLE_LIBC.test(line))
            ?.trim() ?? "";
    return [
        "The local embedding runtime (llama-server) cannot run on this system: its prebuilt binary needs a",
        "newer C/C++ runtime than your Linux distribution provides. The pinned llama.cpp build targets the",
        "Ubuntu 22.04 toolchain — it needs glibc >= 2.34 and libstdc++ from GCC 12+ (Ubuntu 22.04 / Debian 12",
        "or newer). Older releases such as Ubuntu 20.04 or Debian 11 ship an older glibc/libstdc++, so their",
        "dynamic loader rejects the binary at startup. To fix: upgrade the OS (Ubuntu 22.04+), or use a hosted",
        'embedder — set `embedding.mode = "api-key"` (or `"off"` to disable embeddings).',
        loaderLine.length > 0 ? `  llama-server reported: ${loaderLine}` : "",
    ]
        .filter((line) => line.length > 0)
        .join("\n");
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
    requestTimeoutMs: number = READINESS_REQUEST_TIMEOUT_MS,
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
        // Track the live child for reaping from the instant it exists — before readiness
        // resolves — so a shutdown landing mid-launch can terminate it. Left set on
        // success (ensureReady clears it when it promotes to `running`); cleared here on
        // failure, after the terminate that reaps this handle.
        spawnSlot = handle;
        const origin = `http://127.0.0.1:${port.value}`;

        // Race readiness against the child's exit. A server that dies during startup
        // (port already bound, unloadable model) fails this attempt as soon as we see
        // the exit; the abort tears down the readiness polling so no loop lingers.
        const pollAbort = new AbortController();
        const readyOrExit = await Promise.race([
            awaitSidecarReady(origin, key, healthTimeoutMs, healthPollMs, pollAbort.signal, requestTimeoutMs),
            handle.exited.then((code): Result<void, ReadinessFailure> => {
                pollAbort.abort();
                return err({
                    portRetryable: true,
                    fromExit: true,
                    error: providerFault(`The local embedding runtime exited (code ${code}) before becoming ready.`, true),
                });
            }),
        ]);
        if (readyOrExit.isOk()) {
            return ok({ baseURL: `${origin}/v1`, origin, key, exited: handle.exited, tail: handle.tail, stop: handle.terminate });
        }
        // Reap ours (a no-op if already gone). Guard the clear against a concurrent
        // launch having already re-set the slot to its own handle.
        void handle.terminate();
        if (spawnSlot === handle) spawnSlot = null;
        const failure = readyOrExit.error;
        // When the child exited, its stderr pipe closed, so the drain settles promptly —
        // await it so the failure carries the COMPLETE tail rather than a raced partial.
        // A plain readiness timeout may leave the child alive (a half-open server) with
        // its pipe still open, where awaiting settlement would be unbounded: read as-is.
        if (failure.fromExit) await handle.tailSettled;
        const tail = handle.tail().trim();
        // A glibc/libstdc++ "version not found" tail means the host's C runtime is
        // older than the prebuilt binary's build host (the reported Ubuntu < 24 case).
        // No fresh-port retry can change that, so surface the actionable cause at once
        // rather than a raw loader dump wrapped in "exited before becoming ready".
        if (INCOMPATIBLE_LIBC.test(tail)) return err(providerFault(incompatibleLibcMessage(tail), false));
        lastError =
            tail.length > 0 ? providerFault(`${failure.error.message}\n  llama-server stderr (tail):\n${tail}`, failure.error.retryable) : failure.error;
        if (!failure.portRetryable) return err(lastError);
    }
    return err(lastError ?? providerFault("The local embedding runtime failed to start.", true));
}

/** Enumerate every process via `ps` for the orphan sweep. A spawn/read fault throws into {@link sweepOrphanedSidecars}'s own try/catch, which swallows it — the sweep is best-effort. */
async function defaultProcessScan(): Promise<string> {
    const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
}

/**
 * Best-effort reap of leftover sidecars from a previous CLI that died without its
 * shutdown chain (SIGKILL, crash). Kills every process executing THIS installation's
 * materialized `serverBin` whose parent is pid 1 — reparenting to init is the one
 * orphan signature that cannot lie, so a sidecar still owned by a live CLI (parented to
 * that CLI, ppid ≠ 1) is never touched, and the binary path lives under inflexa's data
 * dir so a foreign llama-server cannot prefix-match it. Runs at sidecar spawn, not CLI
 * startup: a process that never embeds scans nothing, and the moment we add a sidecar
 * is exactly when the graveyard matters.
 *
 * Best-effort throughout: a scan or kill fault must never fail the launch, and this
 * module does not log, so faults are swallowed silently. Exported for the sweep
 * decision-table test, which injects scan rows and spies on `process.kill`.
 *
 * @param serverBin absolute path to the materialized `llama-server` binary
 */
export async function sweepOrphanedSidecars(serverBin: string): Promise<void> {
    // TODO(extend): Windows has no ppid-1 reparent signature (and the Windows sidecar
    // target is cross-compiled and untested); a Job Object or a WMI ParentProcessId
    // scan would be the equivalent to wire when that target is supported.
    if (process.platform === "win32") return;
    let output: string;
    try {
        output = await scanProcesses();
    } catch {
        return;
    }
    for (const line of output.split("\n")) {
        // pid and ppid are the first two whitespace-delimited columns; the rest is the
        // command, kept verbatim so a data-dir path containing spaces still matches.
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (match === null) continue;
        const ppid = Number(match[2]);
        const command = match[3] ?? "";
        if (ppid !== 1 || !command.startsWith(serverBin)) continue;
        try {
            process.kill(Number(match[1]), "SIGKILL");
        } catch {
            // Already gone (ESRCH) or not ours to signal (EPERM) — nothing left to heal.
        }
    }
}

/**
 * Production launcher: materialize the pinned runtime, sweep any orphaned sidecars from
 * an unsurvivable prior exit, then hand off to {@link launchWithBinary}. A runtime that
 * cannot be materialized points the user at `inflexa setup --embeddings local`, which
 * succeeds in every install context.
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
    await sweepOrphanedSidecars(runtime.value);
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
        if (!reapHooked) {
            reapHooked = true;
            // Register BEFORE the first launch begins, not in the success continuation:
            // the launch window (child spawned, readiness pending) is exactly the gap a
            // late registration leaves uncovered. A shutdown landing there reaps the
            // in-flight child via `running ?? spawnSlot`. The awaited form keeps
            // shutdown() from returning over an undead child.
            onShutdown(stopLocalSidecarAndWait);
        }
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
                // Promotion supersedes the spawn slot: `running` is now the reachable
                // handle a stop reaps, so the slot (its low-level SpawnHandle, matching
                // the same child) is redundant and cleared. Epoch matched, so no
                // concurrent launch owns the slot.
                spawnSlot = null;
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
 *
 * Reaps the ready sidecar if one exists, otherwise the in-flight spawn — a stop landing
 * mid-launch (before promotion) still terminates the already-spawned child rather than
 * finding nothing. Both are cleared, and the epoch bumped so an in-flight launch that
 * has yet to resolve reaps its own process and caches nothing.
 */
export async function stopLocalSidecarAndWait(): Promise<void> {
    const sidecar = running;
    const spawn = spawnSlot;
    running = null;
    spawnSlot = null;
    ready = null;
    launchEpoch++;
    if (sidecar) await sidecar.stop();
    else if (spawn) await spawn.terminate();
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

        return new ResultAsync(
            ensureReady(deps.modelPath).then((rs) =>
                rs.match(
                    // The token-exact fit measures against the sidecar's own tokenizer, so
                    // it runs AFTER readiness against the ready handle; the fitted texts
                    // then embed. Fitting always yields a fitting string (never fails), so it
                    // enters the Result chain through fromSafePromise.
                    (sidecar) => ResultAsync.fromSafePromise(fitInputs(sidecar.handle, texts)).andThen((fitted) => sidecar.provider.embed(fitted, session)),
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
 * TEST ONLY. Override the per-request `/tokenize` timeout so a test can drive the
 * measurement-timeout → hard-cut fallback fast against a hanging stub, instead of
 * waiting the production {@link TOKENIZE_REQUEST_TIMEOUT_MS}. Pass `null` to restore it.
 */
export function __setTokenizeTimeoutForTest(ms: number | null): void {
    tokenizeRequestTimeoutMs = ms ?? TOKENIZE_REQUEST_TIMEOUT_MS;
}

/**
 * TEST ONLY. Override the process lister the orphan sweep uses, so a test drives the
 * parse/decision against canned `ps` rows (spying on `process.kill`) without real
 * processes. Pass `null` to restore the real `ps` scan.
 */
export function __setProcessScanForTest(fn: ProcessScan | null): void {
    scanProcesses = fn ?? defaultProcessScan;
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
    spawnSlot = null;
}
