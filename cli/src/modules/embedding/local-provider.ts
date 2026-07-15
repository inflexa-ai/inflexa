/**
 * CLI-side realization of the harness {@link EmbeddingProvider} seam: an in-process
 * `bge-small-en-v1.5` (GGUF, q8_0, 384-dim) embedding model loaded via `node-llama-cpp`.
 *
 * `node-llama-cpp` is an optional dependency (see `cli/package.json` →
 * `optionalDependencies`) whose native runtime is fetched at setup-yes time, not at
 * install time. To keep a process that never embeds from ever loading the native
 * runtime, `node-llama-cpp` is imported via a dynamic `import()` evaluated lazily on
 * the first `embed()` call — there is no static top-level import here.
 *
 * The GGUF quantized model emits UN-normalized vectors (raw L2 norm ≈ 9.24, per the
 * spike in `cli/spike/NOTES.md`); this provider L2-normalizes every vector before
 * returning it, so the output is store-agnostic and interchangeable with the
 * harness's OpenAI-shaped `createEmbeddingProvider` (which returns normalized
 * vectors). The harness seam is none the wiser.
 *
 * The `session` argument is intentionally ignored: the local provider does no
 * billing and needs no identity — it is a pure function of (model, text).
 */

import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";

import type { AgentSession, EmbeddingProvider, ProviderError } from "@inflexa-ai/harness";
// Reusing the harness's `toProviderError` keeps the local provider's error
// shape identical to the cloud `createEmbeddingProvider`'s, so the seam yields
// the same `ProviderError` no matter which realization runs.
import { toProviderError } from "@inflexa-ai/harness";

import { isCompiledBinary } from "../../lib/install_context.ts";

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
 * Why local embeddings cannot run in the compiled single-file binary: the native
 * inference runtime is `external` in the build (scripts/build.ts) and unreachable
 * inside `/$bunfs`. The single source for that reason phrase; setup.ts composes
 * context-specific remediation onto it, so the diagnosis stays consistent whether
 * the user hit it at setup time or on the hot path.
 */
export const COMPILED_LOCAL_UNAVAILABLE_REASON =
    "Local embeddings are unavailable in the packaged inflexa binary: it does not include the native inference runtime (node-llama-cpp).";

/**
 * Lazily-initialized native runtime state. Created once on the first `embed()`
 * call and reused for every subsequent call. Cached as a promise so concurrent
 * first calls coalesce on the same load (the one-time init cost — ~1s runtime
 * + ~250ms model load — is paid only once).
 */
interface LoadedRuntime {
    getEmbeddingFor(text: string): Promise<{ readonly vector: readonly number[] }>;
}

let runtime: Promise<Result<LoadedRuntime, ProviderError>> | null = null;

/**
 * Maximum concurrent `getEmbeddingFor` calls. node-llama-cpp embeds one text at
 * a time; the docs suggest `Promise.all` for concurrency. Capping at 4 keeps a
 * large batch from saturating CPU — acceptable for CLI-scale indexing
 * (10–50 file descriptions per step).
 */
const MAX_CONCURRENCY = 4;

/**
 * Run async tasks over `items` with at most `concurrency` in flight at once,
 * preserving input order in the output. Rejections propagate (the caller wraps
 * the run so failures fold into a `ProviderError`).
 */
async function mapPool<T, R>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    async function worker(): Promise<void> {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await run(items[i]!, i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
}

/** Euclidean (L2) norm of a vector. */
function l2Norm(v: readonly number[]): number {
    let sum = 0;
    for (const x of v) sum += x * x;
    return Math.sqrt(sum);
}

/**
 * Normalize `v` to unit L2 length. The GGUF model emits un-normalized vectors
 * (norm ≈ 9.24); dividing every component by its norm yields a unit vector the
 * future store can treat as already-normalized (safe for dot-product or cosine).
 * A zero vector (degenerate, never produced by bge) is returned unchanged to
 * avoid a NaN from 0/0.
 */
function l2Normalize(v: readonly number[]): number[] {
    const n = l2Norm(v);
    if (n === 0) return [...v];
    return v.map((x) => x / n);
}

/**
 * Initialize the native llama runtime + model + embedding context on first use.
 * Wrapped in `Result` so a missing/broken `node-llama-cpp` or model file is an
 * `err(ProviderError)` — never a throw — per the seam contract.
 */
function loadRuntime(modelPath: string): Promise<Result<LoadedRuntime, ProviderError>> {
    return (async (): Promise<Result<LoadedRuntime, ProviderError>> => {
        try {
            // Dynamic import: a process that never embeds never evaluates this,
            // so the native addon is never loaded. If `node-llama-cpp` is absent
            // (not installed / install corrupted), the import rejects and we
            // surface a clear, actionable error rather than crashing.
            const { getLlama } = await import("node-llama-cpp");
            const llama = await getLlama();
            const model = await llama.loadModel({ modelPath });
            const context = await model.createEmbeddingContext();
            // Wrap only the method we use; the model + llama stay alive for the
            // process lifetime (the model is mmap'd, the context is reusable).
            return ok({
                getEmbeddingFor: (text: string) => context.getEmbeddingFor(text),
            });
        } catch (e) {
            // `toProviderError` classifies the cause; the appended guidance is
            // install-context-aware. From source the common cause is the optional
            // dep not being trusted/fetched or the GGUF missing — both fixed by
            // `inflexa setup`. In the compiled binary the import can NEVER resolve
            // (the runtime is external, /$bunfs has no node_modules), so pointing
            // at a setup command that cannot succeed would be a dead end; direct
            // the user to a mode that works instead.
            const base = toProviderError(e, "local-embeddings");
            const remediation = isCompiledBinary()
                ? `${COMPILED_LOCAL_UNAVAILABLE_REASON} Switch \`embedding.mode\` to \`api-key\` or \`off\`.`
                : "Run `inflexa setup --embeddings local` to install the local embedding model.";
            return err({
                ...base,
                message: `${base.message}\n  ${remediation}`,
            } satisfies ProviderError);
        }
    })();
}

export function createLocalEmbeddingProvider(deps: LocalEmbeddingProviderDeps): EmbeddingProvider {
    function embed(texts: readonly string[], _session: AgentSession): ResultAsync<number[][], ProviderError> {
        // Empty input is a no-op: don't trigger the lazy native load just to
        // return nothing. Matches the harness `createEmbeddingProvider` shortcut.
        if (texts.length === 0) return okAsync([]);

        // Coalesce concurrent first calls on the same load promise.
        if (runtime === null) runtime = loadRuntime(deps.modelPath);

        const result: Promise<Result<number[][], ProviderError>> = runtime.then((rt) =>
            rt.match(
                (loaded) =>
                    new ResultAsync(
                        (async (): Promise<Result<number[][], ProviderError>> => {
                            try {
                                const vectors = await mapPool([...texts], MAX_CONCURRENCY, (text) =>
                                    loaded.getEmbeddingFor(text).then((emb) => l2Normalize(emb.vector)),
                                );
                                return ok(vectors);
                            } catch (e) {
                                return err(toProviderError(e, "local-embeddings"));
                            }
                        })(),
                    ),
                // Init already failed — surface the cached error without re-trying.
                (e) => errAsync<number[][], ProviderError>(e),
            ),
        );

        return new ResultAsync(result);
    }

    return { embed, dimensions: LOCAL_EMBEDDING_DIMENSIONS };
}

/**
 * TEST ONLY. Clear the module-level lazy-runtime cache so a subsequent `embed()`
 * re-runs {@link loadRuntime}. The runtime is a process-wide singleton keyed to
 * the first caller's model path; without this reset a test that induces a load
 * failure would poison it for every later test in the same process. Production
 * code never calls this — the singleton is loaded once and reused for the
 * process lifetime by design.
 */
export function __resetLocalRuntimeForTest(): void {
    runtime = null;
}
