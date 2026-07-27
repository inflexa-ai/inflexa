/**
 * Local embedding model lifecycle: acquire, verify, configure, and the hot-path
 * readiness gate. Mirrors `modules/infra/setup.ts` — "acquire a thing on opt-in,
 * verify it, record the choice in config, and gate the hot path on it being
 * present" — and uses the same `@clack/prompts` UI (`select`/`spinner`/`log`) so
 * the two setup flows feel consistent.
 *
 * The model is `bge-small-en-v1.5` (GGUF, q8_0, 384-dim, ~36 MB), pinned in
 * `model_pin.ts`. Acquisition is source-aware, mirroring the llama runtime: the
 * compiled binary copies its build-time embedded asset (no network — the whole
 * point for egress-restricted environments); a source checkout downloads the
 * pinned revision from HuggingFace. Acquisition is skipped if the file already
 * exists; verification (spawn the sidecar + embed probe + dim check) always runs
 * so a truncated/corrupt file is caught now, not on the first hot-path `embed()`
 * call. Verification goes through the SAME `llama-server` sidecar the hot path
 * uses, so it is identical in the compiled binary and from source — no separate
 * load path to diverge.
 */

import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { log, spinner as clackSpinner } from "@clack/prompts";
import { err, ok, type Result } from "neverthrow";

import { createEmbeddingProvider, createNoopBillingResolver, type AgentSession } from "@inflexa-ai/harness";

import { readConfig, writeConfig } from "../../lib/config.ts";
import { promptSecret, promptText, select } from "../../lib/cli.ts";
import { EMBEDDING_API_KEY_VAR, env, resolveEmbeddingApiKey } from "../../lib/env.ts";
import { isCompiledBinary } from "../../lib/install_context.ts";
import { ensureLlamaServer, materializedLlamaServer } from "./llama_runtime.ts";
import { createLocalEmbeddingProvider, LOCAL_EMBEDDING_DIMENSIONS, stopLocalSidecar } from "./local-provider.ts";
import { MODEL_SHA256, MODEL_URL } from "./model_pin.ts";
import { DEFAULT_API_BASE_URL, DEFAULT_API_EMBEDDING_DIMENSIONS, DEFAULT_API_EMBEDDING_MODEL } from "./resolve.ts";

export type EmbeddingSetupError =
    // Model acquisition failed — spans BOTH byte sources: a from-source HuggingFace download fault AND a
    // compiled-binary embedded-asset fault (this binary embedded no model, or the embedded bytes are
    // corrupt). Named for `acquireModel`, not "download", because neither embedded case is a download.
    | { readonly type: "acquire_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "verify_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "dimension_mismatch"; readonly message: string; readonly expected: number; readonly actual: number }
    | { readonly type: "not_configured"; readonly message: string }
    // The GGUF is present but the pinned llama-server runtime could not be acquired. Distinct from
    // `not_configured` (nothing was ever set up — remediation is the setup command): here the user DID
    // set up, and the runtime bytes are what's missing — in practice the offline source-checkout case,
    // since a compiled binary materializes from its embedded asset without touching the network.
    | { readonly type: "runtime_unavailable"; readonly message: string; readonly cause?: unknown };

// Baked to the literal `true` by scripts/build.ts for every release target, exactly as
// install_context.ts's `__INFLEXA_COMPILED__` — that module owns the canonical declaration and its
// `isCompiledBinary()` accessor. It is RE-declared here because the constant-fold in
// `embeddedModelPath` below needs the BARE identifier under a `typeof` guard: a read through
// `isCompiledBinary()` is opaque to the bundler and would not fold, whereas the folded-away branch
// is precisely what keeps the `.llama-cache/` import specifier from being resolved outside a release
// build (the asset is absent from a from-source tree). Safe because the only read is `typeof`-guarded,
// so an undeclared identifier in dev/test evaluates to `undefined`, never a ReferenceError.
declare const __INFLEXA_COMPILED__: boolean | undefined;

// Module-level test seams (mirroring llama_runtime's __set…ForTest): a forced embedded path lets a
// unit test exercise the embedded-copy branch without a real compiled binary; a forced pin drives the
// whole acquire pipeline against a fixture url/hash; a forced secret reader drives the api-key branch
// without mutating the process environment. All `null` in production.
let embeddedModelOverride: string | null = null;
let modelPinOverride: { readonly url: string; readonly sha256: string } | null = null;
let embeddingApiKeyOverride: (() => string | undefined) | null = null;

/**
 * The api-key embedding secret, read through the sole `process.env` reader (lib/env.ts) at CALL time so
 * setup sees the live shell. Routed through the seam above rather than read directly for the same reason
 * `setup_answers.ts` injects it: it is the one value in this flow that is not a function of its inputs.
 */
function readEmbeddingApiKey(): string | undefined {
    return (embeddingApiKeyOverride ?? resolveEmbeddingApiKey)();
}

/** The active model pin (url + sha256), honoring a test override; otherwise the vendored constants. */
function modelPin(): { readonly url: string; readonly sha256: string } {
    return modelPinOverride ?? { url: MODEL_URL, sha256: MODEL_SHA256 };
}

/**
 * The compiled binary's embedded model asset path, or `null` from source / dev / test. Unlike the
 * per-target llama archives, ONE platform-independent asset serves every target — so this gates on the
 * every-target `__INFLEXA_COMPILED__` define rather than a per-target key. The `typeof` guard folds to
 * a compile-time boolean: the bundler keeps the `import(... with { type: "file" })` only when
 * compiling and drops it otherwise, so the specifier into the out-of-git `.llama-cache/` (which
 * scripts/build.ts populates before compiling) is never resolved outside a release build. That literal
 * must be edited in lockstep with the pin — Bun embeds only statically-known paths (see model_pin.ts).
 */
async function embeddedModelPath(): Promise<string | null> {
    if (embeddedModelOverride !== null) return embeddedModelOverride;
    if (typeof __INFLEXA_COMPILED__ !== "undefined" && __INFLEXA_COMPILED__ === true) {
        return (await import("../../../.llama-cache/bge-small-en-v1.5-q8_0.gguf", { with: { type: "file" } })).default;
    }
    return null;
}

/**
 * Acquire the GGUF model to {@link env.embeddingModelPath}, skipping if it is already present.
 * Source-aware, mirroring the llama runtime: a compiled binary copies its build-time embedded asset
 * (no network — the point of this path for egress-restricted environments); a source checkout streams
 * the pinned file from HuggingFace. Both sources are verified against the pinned SHA-256 before any
 * bytes land at the final path, so the "nothing lands unverified" invariant holds unconditionally
 * rather than per-source. Every failure surfaces as `acquire_failed` — never thrown.
 *
 * The bytes stage in a `.part` sidecar renamed into place only after a complete, verified flush: the
 * "already present" check above trusts bare existence, so a mid-acquisition failure must never leave
 * bytes at the final path — a truncated file there would be skipped as "already present" on retry and
 * only caught by `verifyModel`, with no hint that deleting it fixes things.
 */
export async function acquireModel(): Promise<Result<void, EmbeddingSetupError>> {
    const partPath = `${env.embeddingModelPath}.part`;
    const pin = modelPin();
    const embedded = isCompiledBinary();
    try {
        if (await Bun.file(env.embeddingModelPath).exists()) {
            log.info(`Embedding model already present at ${env.embeddingModelPath}`);
            return ok(undefined);
        }

        await mkdir(dirname(env.embeddingModelPath), { recursive: true });

        const s = clackSpinner();
        s.start(embedded ? "Installing the bundled bge-small-en-v1.5 model (q8_0, ~36 MB)" : "Downloading bge-small-en-v1.5 (q8_0, ~36 MB) from HuggingFace");

        // One hasher spans both byte sources so the digest check below is source-agnostic.
        const hasher = new Bun.CryptoHasher("sha256");
        if (embedded) {
            const assetPath = await embeddedModelPath();
            if (assetPath === null) {
                s.error("Bundled model missing");
                return err({
                    type: "acquire_failed",
                    message:
                        "This inflexa binary did not embed the bge-small embedding model. Reinstall the official binary for your platform, or run inflexa from source.",
                });
            }
            // Bun.file().bytes() mmaps the embedded segment and Bun.write() lands it on a real disk
            // path — the bunfs-safe pair (fd-based APIs ENOENT on /$bunfs), the same constraint
            // documented at llama_runtime's writeEmbeddedArchive.
            const bytes = await Bun.file(assetPath).bytes();
            hasher.update(bytes);
            await Bun.write(partPath, bytes);
        } else {
            const response = await fetch(pin.url);
            if (!response.ok || response.body === null) {
                s.error("Download failed");
                return err({
                    type: "acquire_failed",
                    message: `Download failed: HTTP ${response.status} ${response.statusText}`,
                });
            }

            const file = Bun.file(partPath);
            const writer = file.writer();
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                hasher.update(value);
                await writer.write(value);
            }
            await writer.flush();
        }

        const digest = hasher.digest("hex");
        if (digest !== pin.sha256) {
            s.error("Checksum mismatch");
            await unlink(partPath).catch(() => {});
            return err({
                type: "acquire_failed",
                message: embedded
                    ? `The bundled model's sha256 (${digest}) does not match the pinned checksum — the embedded asset is corrupt. Reinstall the official binary for your platform.`
                    : `Downloaded file's sha256 (${digest}) does not match the pinned model checksum. Retry, or check your network path to huggingface.co.`,
            });
        }
        await rename(partPath, env.embeddingModelPath);

        const written = (await stat(env.embeddingModelPath)).size;
        s.stop(embedded ? `Installed ${written.formatBytes()} (bundled model)` : `Downloaded ${written.formatBytes()}`);
        return ok(undefined);
    } catch (cause) {
        // Best-effort cleanup; a `.part` leftover is harmless (never mistaken
        // for the model) but would confuse a du/ls of the model dir.
        await unlink(partPath).catch(() => {});
        return err({
            type: "acquire_failed",
            message: `Model acquisition failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
        });
    }
}

/**
 * Verify the model end-to-end through the sidecar: spawn `llama-server` against the GGUF, embed a probe
 * text, and MEASURE the vector width it emits (llama-server returns the model's native width — it ignores
 * any requested `dimensions` — which is exactly what lets this detect a wrong model). This is the identical
 * path the hot loop uses, so a "works in dev, dead in the binary" divergence cannot hide here. Catches a
 * truncated/corrupt file or a wrong-model GGUF now, so the hot path never hits a startup failure. Returns
 * the measured width on success. A start/probe error is `verify_failed`.
 *
 * `expectedDim` gates the width check: pass it for the BUILT-IN model (384) so a corrupt/wrong bundled GGUF
 * is caught as `dimension_mismatch`; omit it for a user's OWN GGUF, whose width is unknown ahead of time —
 * whatever it emits (any positive width) is accepted and returned so the caller can record it as the index
 * width. A zero-width probe is always `verify_failed` (an unusable model, whatever the mode).
 *
 * The sidecar is torn down immediately after the probe rather than left running
 * for the process lifetime — setup only needs the one probe.
 */
export async function verifyModel(modelPath: string, expectedDim?: number): Promise<Result<number, EmbeddingSetupError>> {
    const s = clackSpinner();
    s.start("Verifying model (spawn runtime + embed probe)");

    const provider = createLocalEmbeddingProvider({ modelPath });
    // The local provider does no billing and reads only `scope` (for a log label),
    // so a structural stand-in satisfies the seam. The `as unknown as` is required
    // because we do not build a full RunSession for a one-shot probe, and nothing
    // downstream reads the omitted fields (the noop billing resolver ignores it).
    const probeSession = { scope: { kind: "analysis", analysisId: "embedding-setup-verify" } } as unknown as AgentSession;
    const outcome = await provider.embed(["inflexa embedding verification probe"], probeSession).match(
        (vectors): { readonly ok: true; readonly dim: number } => ({ ok: true, dim: vectors[0]?.length ?? 0 }),
        (e): { readonly ok: false; readonly message: string } => ({ ok: false, message: e.message }),
    );
    // Tear the probe server down at once; don't hold ~86 MB RSS for the rest of setup.
    stopLocalSidecar();

    if (!outcome.ok) {
        s.error("Verification failed");
        return err({ type: "verify_failed", message: `Model verification failed: ${outcome.message}` });
    }
    if (outcome.dim <= 0) {
        s.error("Verification failed");
        return err({ type: "verify_failed", message: "Model produced empty vectors — the GGUF is not a usable embedding model." });
    }
    if (expectedDim !== undefined && outcome.dim !== expectedDim) {
        s.error("Dimension mismatch");
        return err({
            type: "dimension_mismatch",
            message: `Model produced ${outcome.dim}-dim vectors, expected ${expectedDim}. The GGUF may be the wrong model.`,
            expected: expectedDim,
            actual: outcome.dim,
        });
    }
    s.stop(`Verified: ${outcome.dim}-dim vectors`);
    return ok(outcome.dim);
}

/**
 * The embedding questions this step can be handed answers for instead of asking. Structurally the
 * `embedding` block of setup's `SetupAnswers` (modules/infra/setup_answers.ts) plus the run-level
 * `--no-validate` switch, declared HERE rather than imported so the dependency arrow keeps pointing
 * one way: the setup orchestrator consumes this module, and importing its answers schema back would
 * make the two domains mutually dependent. `setup.test.ts` pins the two shapes together with a
 * compile-time assignability check, the same way `setup_answers.ts` pins its auth answer against
 * `lib/config.ts`'s persisted schema.
 */
export type EmbeddingSetupAnswers = {
    /** The backend to configure. Replaces `preselected`, and unlike it an answered `off` is PERSISTED. */
    readonly mode?: "local" | "api-key" | "off";
    /** `api-key`: the endpoint, skipping its prompt. */
    readonly baseURL?: string;
    /** `api-key`: the embedding model id, skipping its prompt. */
    readonly model?: string;
    /** `local`: a path to the user's OWN GGUF, skipping the path prompt (selects the custom branch). */
    readonly gguf?: string;
    /** `false` (from `--no-validate`) skips the api-key endpoint's NETWORK probe. Defaults to `true`. */
    readonly validate?: boolean;
};

/**
 * Embedding setup, run as part of `inflexa setup`. Every question is either ANSWERED (from
 * `--embeddings…` / the `--config` file, via `answers`) or asked with a clack prompt — the built-in
 * bge-small model, a path to the user's OWN local GGUF, a remote API-key endpoint, or off:
 * - built-in → materialize the sidecar runtime + acquire the pinned GGUF (embedded asset in the compiled
 *   binary, download from source), verify it (asserting the 384-dim width), and record `mode = "local"`
 *   + `modelPath = env.embeddingModelPath`.
 * - your own GGUF → take the path from `answers.gguf` or prompt for it, verify it (measuring whatever
 *   width it emits), and record `mode = "local"` + that `modelPath` + the measured `dimensions`.
 * - API key → take the endpoint/model from the answers or prompt for them, take the secret from
 *   {@link EMBEDDING_API_KEY_VAR} or the MASKED prompt, probe the endpoint with one real embed
 *   (measuring the emitted width), and record `mode = "api-key"` + the key + only the fields that
 *   differ from the provider defaults.
 *
 * Non-interactive shells (no TTY, or `interactive === false`) never prompt: an unanswered question
 * resolves to what an empty submit at its prompt would have produced, and an unanswered MODE skips the
 * step entirely without hanging — `mode` stays whatever it was.
 *
 * `preselected` is the pre-answers spelling of `answers.mode` and stays supported while the
 * orchestrator migrates. The two are equivalent EXCEPT for `off`: an ANSWER declares desired state, so
 * an answered `off` persists `mode = "off"` (disabling a previously configured backend), whereas a
 * preselected `off` — like the interactive picker's "Off / skip" — leaves the configured mode alone.
 * `answers.mode` wins when both are supplied; the value answers (`baseURL`/`model`/`gguf`/`validate`)
 * apply whichever channel carried the mode, and equally to a mode the user picks at the prompt.
 */
export async function runEmbeddingSetup(
    interactive: boolean,
    preselected?: "local" | "api-key" | "off",
    answers?: EmbeddingSetupAnswers,
): Promise<Result<void, EmbeddingSetupError>> {
    const config = readConfig();
    // The single "may this run ask a question?" fact. Both call sites pass `process.stdin.isTTY` as
    // `interactive`, so this is exactly the guard the no-preselection flow already applied — extending it
    // to the answered branches is what lets a batch run fall back to defaults instead of dying inside a
    // prompt that cannot render.
    const canPrompt = interactive && process.stdin.isTTY === true;
    const validate = answers?.validate ?? true;

    const mode = answers?.mode ?? preselected;
    if (mode !== undefined) {
        if (mode === "off") {
            // Only an ANSWERED off is a declaration of desired state; a preselected one keeps the
            // leave-unchanged behavior its call site was written against (see this function's contract).
            return answers?.mode === "off" ? writeEmbeddingOff(config) : ok(undefined);
        }
        if (mode === "api-key") return runApiKeySetup(config, { baseURL: answers?.baseURL, model: answers?.model, validate, canPrompt });
        // `local` + an answered GGUF is the custom branch (the answer replaces the path prompt); `local`
        // alone is the built-in model.
        if (answers?.gguf !== undefined) return runCustomLocalSetup(config, answers.gguf);
        return runBuiltinLocalSetup(config);
    }

    // Already configured (mode is no longer the default `off`): don't re-prompt
    // on every launch — the user already made a choice. `ensureEmbedderReady`
    // separately gates the hot path on a local model being present.
    if (config.embedding.mode !== "off") return ok(undefined);

    // Non-interactive with no mode answer: skip the question, leave mode unchanged (no hang).
    if (!canPrompt) return ok(undefined);

    const choice = await promptEmbeddingMode();
    if (choice === "off") {
        log.info("Embeddings skipped (mode left unchanged).");
        return ok(undefined);
    }
    // A value answer skips its prompt even when the MODE came from the picker, so a partially-filled
    // `--config` file composes with the questions it left open (the answers layer's precedence rule).
    if (choice === "api-key") return runApiKeySetup(config, { baseURL: answers?.baseURL, model: answers?.model, validate, canPrompt });
    if (choice === "custom") return runCustomLocalSetup(config, answers?.gguf);
    // choice === "builtin"
    return runBuiltinLocalSetup(config);
}

/**
 * Persist an ANSWERED `off`: the answers layer's values declare the client's desired state, so naming
 * `off` must disable a backend that is already configured rather than mean "no opinion" (which is what
 * an ABSENT answer means, and what the picker's "Off / skip" choice keeps meaning).
 *
 * Nothing on disk is touched — the GGUF and the materialized runtime stay where they are — and the rest
 * of the `embedding` block is preserved rather than cleared: switching off is not "forget how I was
 * configured", the recorded `modelPath`/`apiKey` are what make re-enabling one word, and clearing would
 * silently destroy a key the user pasted. `resolveEmbedder` already reports the resulting
 * explicit-off-beside-a-backend-field state precisely, so the leftovers cannot read as a mystery.
 */
function writeEmbeddingOff(config: ReturnType<typeof readConfig>): Result<void, EmbeddingSetupError> {
    return writeConfig({ ...config, embedding: { ...config.embedding, mode: "off" } })
        .mapErr((e): EmbeddingSetupError => ({
            type: "verify_failed",
            message: `Embeddings could not be switched off — config could not be written: ${e.type}`,
        }))
        .map(() => {
            log.success("Embeddings disabled — `embedding.mode` is now `off`. Model files on disk are untouched.");
            return undefined;
        });
}

/**
 * Loudly warn when the user is about to change an already-chosen embedding
 * backend. Vector widths differ per backend (local = 384; api-key defaults to
 * 1536), and each analysis's search index keeps the width it was created with —
 * switching strands every existing index at the old width, so search and
 * further indexing on those analyses fail until they are re-profiled.
 * Automatic re-embedding is a deliberate non-feature for now (see the
 * local-embeddings design doc); the warning is the mitigation.
 */
function warnOnModeSwitch(current: "local" | "api-key" | "off", next: "local" | "api-key"): void {
    if (current === "off" || current === next) return;
    log.warn(
        [
            `SWITCHING EMBEDDING BACKEND (${current} → ${next})`,
            "",
            "Embedding models emit different vector widths, and every existing analysis's",
            "search index keeps the width it was created with. After this switch:",
            "  - semantic search on existing analyses will return errors or nothing,",
            "  - further indexing into them (new runs, re-profiles) will fail,",
            "until each analysis is re-profiled under the new backend.",
            "Automatic re-embedding is not supported yet.",
        ].join("\n"),
    );
}

/**
 * Materialize the pinned `llama-server` runtime under a narrated spinner. Shared by both local branches
 * (built-in and custom GGUF). Under its own spinner so the one-time first-run cost is narrated rather than
 * a silent stall: macOS pays a ~10s OS scan of the fresh binaries the first time they run, and paying it
 * here (not mid-analysis) is the whole point of setup-time verification. Idempotent — a subsequent spawn
 * reuses it.
 */
async function materializeEmbeddingRuntime(): Promise<Result<void, EmbeddingSetupError>> {
    const runtimeSpinner = clackSpinner();
    runtimeSpinner.start("Preparing the local embedding runtime (llama-server)");
    const runtime = await ensureLlamaServer();
    if (runtime.isErr()) {
        runtimeSpinner.error("Runtime setup failed");
        return err({
            type: "runtime_unavailable",
            message: `Local embedding runtime could not be prepared: ${runtime.error.message}`,
            cause: runtime.error.cause,
        });
    }
    runtimeSpinner.stop("Local embedding runtime ready");
    return ok(undefined);
}

/** The built-in-model branch: materialize runtime, acquire the pinned bge-small, verify at 384, write config. */
async function runBuiltinLocalSetup(config: ReturnType<typeof readConfig>): Promise<Result<void, EmbeddingSetupError>> {
    warnOnModeSwitch(config.embedding.mode, "local");
    log.message("Setting up the built-in embedding model (bge-small-en-v1.5, 384-dim, via the pinned llama-server runtime — no API key needed)");

    const runtime = await materializeEmbeddingRuntime();
    if (runtime.isErr()) return runtime;

    const acquireResult = await acquireModel();
    if (acquireResult.isErr()) return acquireResult;

    // Assert the 384 width: the bundled model is SHA-256-pinned, so any other width here means a corrupt
    // or wrong asset, not a legitimate model choice.
    const verifyResult = await verifyModel(env.embeddingModelPath, LOCAL_EMBEDDING_DIMENSIONS);
    if (verifyResult.isErr()) return err(verifyResult.error);

    // Write the config choice. No `dimensions` — the built-in is always 384, which the provider defaults to,
    // so recording it would be redundant. `writeConfig` is sync; mapErr translates its ConfigError, map
    // records the success side-effect. Both consume the Result so the must-use-result rule is satisfied.
    return writeConfig({ ...config, embedding: { mode: "local", modelPath: env.embeddingModelPath } })
        .mapErr((e): EmbeddingSetupError => ({ type: "verify_failed", message: `Verification passed but config could not be written: ${e.type}` }))
        .map(() => {
            log.success("Local embeddings configured (built-in model). `embedding.mode` is now `local`.");
            return undefined;
        });
}

/**
 * The "your own GGUF" branch: take the local model path from the answer (`--embeddings-gguf` / the file's
 * `embedding.gguf`) or prompt for it, verify it emits a usable width through the sidecar, and record that
 * path + width. No acquisition — the file is the user's, so nothing is copied or downloaded; only
 * verification runs, and that verification is OFFLINE, so `--no-validate` never skips it. The measured
 * width is persisted as `embedding.dimensions` (unless it equals the built-in 384, where the provider
 * default already applies), so the harness sizes each analysis index to exactly what this model emits.
 *
 * An answered path takes exactly the same route as a prompted one — exists-check, runtime materialization,
 * measured-width verification, config write — so the batch outcome cannot drift from the interactive one.
 */
async function runCustomLocalSetup(config: ReturnType<typeof readConfig>, answeredPath: string | undefined): Promise<Result<void, EmbeddingSetupError>> {
    warnOnModeSwitch(config.embedding.mode, "local");

    // No answer means a prompt, and the prompt is reached only when this run may ask (an unanswered path
    // in a non-interactive run resolves to the built-in branch upstream, never here). promptText hard-exits
    // on cancel, exactly like the mode picker above, so a cancelled path prompt aborts setup rather than
    // half-configuring.
    const entered =
        answeredPath ??
        (await promptText("Path to your GGUF embedding model", {
            placeholder: "/path/to/model.gguf",
            validate: (v) => (v.trim() === "" ? "Enter a path to a .gguf file." : undefined),
        }));
    const modelPath = entered.trim();
    if (!(await Bun.file(modelPath).exists())) {
        return err({ type: "acquire_failed", message: `No file at ${modelPath}. Provide the path to a local GGUF embedding model.` });
    }

    log.message(`Setting up local embeddings from your model at ${modelPath}`);

    const runtime = await materializeEmbeddingRuntime();
    if (runtime.isErr()) return runtime;

    // No expectedDim: accept whatever width this model emits and size the index to it.
    const verifyResult = await verifyModel(modelPath);
    if (verifyResult.isErr()) return err(verifyResult.error);
    const dimensions = verifyResult.value;

    // Record dimensions only when it differs from the built-in default (which the provider already applies),
    // keeping config minimal — a 384-dim custom model persists just its path.
    const embedding = { mode: "local" as const, modelPath, ...(dimensions === LOCAL_EMBEDDING_DIMENSIONS ? {} : { dimensions }) };
    return writeConfig({ ...config, embedding })
        .mapErr((e): EmbeddingSetupError => ({ type: "verify_failed", message: `Verification passed but config could not be written: ${e.type}` }))
        .map(() => {
            log.success(`Local embeddings configured from your model (${dimensions}-dim). \`embedding.mode\` is now \`local\`.`);
            return undefined;
        });
}

/**
 * Probe a candidate api-key configuration with ONE real embed against the endpoint — the same wire path
 * the hot loop uses (the harness provider + noop billing) — and MEASURE the vector width it emits. A
 * wrong key, endpoint, or model id surfaces here, at setup, instead of late in the profile workflow;
 * the measured width is returned so the caller records the true index size rather than trusting a
 * guessed `dimensions`. Failures are `verify_failed` — the message carries the provider's own cause.
 */
async function probeApiEmbedding(candidate: { baseURL: string; apiKey: string; model: string }): Promise<Result<number, EmbeddingSetupError>> {
    const s = clackSpinner();
    s.start(`Probing ${candidate.baseURL} with one ${candidate.model} embed`);

    const provider = createEmbeddingProvider({
        baseURL: candidate.baseURL,
        token: candidate.apiKey,
        model: candidate.model,
        resolveBilling: createNoopBillingResolver(),
    });
    // Same structural stand-in as verifyModel's probe: the noop billing resolver reads only `scope`,
    // and nothing downstream touches the omitted RunSession fields — hence the `as unknown as`.
    const probeSession = { scope: { kind: "analysis", analysisId: "embedding-setup-verify" } } as unknown as AgentSession;
    const outcome = await provider.embed(["inflexa embedding verification probe"], probeSession).match(
        (vectors): { readonly ok: true; readonly dim: number } => ({ ok: true, dim: vectors[0]?.length ?? 0 }),
        (e): { readonly ok: false; readonly message: string } => ({ ok: false, message: e.message }),
    );

    if (!outcome.ok) {
        s.error("Endpoint probe failed");
        return err({ type: "verify_failed", message: `The embeddings endpoint rejected the probe: ${outcome.message}` });
    }
    if (outcome.dim <= 0) {
        s.error("Endpoint probe failed");
        return err({ type: "verify_failed", message: "The endpoint answered but produced empty vectors — check the model id names an embedding model." });
    }
    s.stop(`Verified: ${outcome.dim}-dim vectors`);
    return ok(outcome.dim);
}

/** What the api-key branch was told, as opposed to what it must still ask for. */
type ApiKeyInputs = {
    /** The answered endpoint, or `undefined` to prompt / fall back to the pre-fill. */
    readonly baseURL: string | undefined;
    /** The answered model id, or `undefined` to prompt / fall back to the pre-fill. */
    readonly model: string | undefined;
    /** `false` (`--no-validate`) skips the endpoint probe — the one NETWORK validation in this module. */
    readonly validate: boolean;
    /** Whether an unanswered question may be prompted for at all (see {@link runEmbeddingSetup}). */
    readonly canPrompt: boolean;
};

/**
 * The api-key branch: resolve endpoint + key + model from the answers, the environment, or the prompts,
 * probe with one real embed, and record the choice. The key never rides an answer (setup's secrets rule):
 * it comes from {@link EMBEDDING_API_KEY_VAR} when set, else the MASKED prompt (paste-friendly, never
 * echoed into scrollback). It is still persisted in the clear to config.json, which the log line says out
 * loud so the trade-off is the user's. Only fields that differ from the provider defaults are written
 * (minimal-config, mirroring {@link runCustomLocalSetup}'s dimensions handling): the measured width
 * replaces any guessed `dimensions`, so a non-default model sizes the per-analysis index to what it
 * actually emits.
 *
 * A run that cannot prompt and was given no answer resolves each field to its pre-fill — precisely the
 * value an empty submit at that prompt would have produced — so a batch `--embeddings api-key` provisions
 * the provider defaults rather than dying inside a prompt no terminal can render. The secret has no such
 * fallback: it is the one input nothing can invent, so its absence is an error naming the variable.
 */
async function runApiKeySetup(config: ReturnType<typeof readConfig>, inputs: ApiKeyInputs): Promise<Result<void, EmbeddingSetupError>> {
    warnOnModeSwitch(config.embedding.mode, "api-key");
    log.message("Setting up remote embeddings (an OpenAI-compatible /embeddings endpoint). The key is stored in config.json — keep that file private.");

    const urlPrefill = config.embedding.baseURL ?? DEFAULT_API_BASE_URL;
    const baseURL =
        inputs.baseURL ??
        (inputs.canPrompt
            ? (
                  await promptText("Embeddings endpoint URL — the /v1-terminated root", {
                      defaultValue: urlPrefill,
                      placeholder: urlPrefill,
                      validate: (v) => {
                          const s = v.trim();
                          if (s === "") return undefined; // empty submit keeps the pre-filled default
                          return URL.canParse(s) ? undefined : "Must be a valid URL, including the scheme (e.g. https://…).";
                      },
                  })
              ).trim()
            : "");
    const confirmedURL = baseURL === "" ? urlPrefill : baseURL;

    // The environment is the secret's ONLY answer channel, so it is consulted first in every run — a
    // machine that exports the variable is not asked again. Reaching a prompt-less run without it is a
    // provisioning error the answers resolver normally catches upfront; this branch must still fail
    // honestly (and name the variable) if it is reached some other way, never persist a keyless api-key
    // config the first chat would choke on.
    const envKey = readEmbeddingApiKey();
    if (envKey === undefined && !inputs.canPrompt) {
        return err({
            type: "not_configured",
            message: `api-key embeddings need the ${EMBEDDING_API_KEY_VAR} environment variable — a secret never rides a flag or the answers file, and this run cannot prompt for one. Export it and re-run \`inflexa setup --embeddings api-key\`.`,
        });
    }
    const apiKey =
        envKey ??
        (
            await promptSecret("API key (input is hidden — paste it)", {
                validate: (v) => (v.trim() === "" ? "Enter the API key." : undefined),
            })
        ).trim();

    const modelPrefill = config.embedding.model ?? DEFAULT_API_EMBEDDING_MODEL;
    const enteredModel =
        inputs.model ??
        (inputs.canPrompt
            ? (
                  await promptText("Embedding model id", {
                      defaultValue: modelPrefill,
                      placeholder: modelPrefill,
                  })
              ).trim()
            : "");
    const model = enteredModel === "" ? modelPrefill : enteredModel;

    // `--no-validate` is the deliberate escape for air-gapped staging and gateways that cannot pass a
    // standards-shaped probe. Skipping the probe forfeits the MEASUREMENT, not just the check: the index
    // width can then only be assumed from what is already configured (or the provider default), which is
    // exactly the guess the probe exists to replace — so the run says so out loud rather than presenting an
    // assumption as a verified fact.
    const assumedDimensions = config.embedding.dimensions ?? DEFAULT_API_EMBEDDING_DIMENSIONS;
    if (!inputs.validate) {
        log.warn(
            `Skipping the endpoint probe (--no-validate): ${confirmedURL} is recorded UNVALIDATED, and the index width is ASSUMED to be ${assumedDimensions} rather than measured.`,
        );
    }
    const probe = inputs.validate ? await probeApiEmbedding({ baseURL: confirmedURL, apiKey, model }) : ok<number, EmbeddingSetupError>(assumedDimensions);
    if (probe.isErr()) return err(probe.error);
    const dimensions = probe.value;

    const embedding = {
        mode: "api-key" as const,
        apiKey,
        ...(confirmedURL === DEFAULT_API_BASE_URL ? {} : { baseURL: confirmedURL }),
        ...(model === DEFAULT_API_EMBEDDING_MODEL ? {} : { model }),
        ...(dimensions === DEFAULT_API_EMBEDDING_DIMENSIONS ? {} : { dimensions }),
    };
    return writeConfig({ ...config, embedding })
        .mapErr((e): EmbeddingSetupError => ({ type: "verify_failed", message: `The endpoint probe passed but config could not be written: ${e.type}` }))
        .map(() => {
            log.success(
                inputs.validate
                    ? `Remote embeddings configured (${model}, ${dimensions}-dim). \`embedding.mode\` is now \`api-key\`.`
                    : `Remote embeddings configured UNVALIDATED (${model}, ${dimensions}-dim assumed — the endpoint was not probed). \`embedding.mode\` is now \`api-key\`.`,
            );
            return undefined;
        });
}

/**
 * Embedding backend picker via clack `select`. Splits the former single "local" option into two distinct
 * choices — the built-in bundled model vs the user's own GGUF — so the built-in is framed as what it is (no
 * "download" claim in a compiled binary, where it is embedded) and a user with a local model can point at
 * it. Returns the chosen value; clack handles cancel (Ctrl-C / Esc) by aborting. All choices work in every
 * install context (both the runtime and the built-in model are embedded/downloaded assets, not native
 * addons), so nothing gates the offering.
 */
async function promptEmbeddingMode(): Promise<"builtin" | "custom" | "api-key" | "off"> {
    const chosen = await select("Embedding backend", [
        {
            value: "builtin",
            label: isCompiledBinary()
                ? "Built-in model — bge-small-en-v1.5 (384-dim, ~36 MB, bundled; no API key or network)"
                : "Built-in model — bge-small-en-v1.5 (384-dim, ~36 MB, downloaded once; no API key)",
        },
        { value: "custom", label: "Your own local model — a path to a GGUF you already have (llama-server compatible)" },
        { value: "api-key", label: "API key — a remote OpenAI-compatible embeddings endpoint" },
        { value: "off", label: "Off / skip" },
    ]);
    return chosen as "builtin" | "custom" | "api-key" | "off";
}

/**
 * Launch-time readiness gate, mirroring `ensureProxyReady` (which likewise
 * self-heals its container substrate at launch). For `local` mode:
 *
 * 1. The GGUF must exist — a missing model means setup never ran (or was undone),
 *    so the remediation is `inflexa setup --embeddings local`, which succeeds in
 *    every install context — and in a compiled binary succeeds offline, since both
 *    the model and the runtime are build-time embedded assets.
 * 2. The pinned runtime must be materialized. When it already is, this is a cheap
 *    directory-existence check and no acquisition work happens. When it is NOT,
 *    the gate materializes it right here rather than returning ok: deferring to
 *    the first `embed()` would surface an acquisition failure (offline
 *    source checkout) mid-chat, where the user can't act on it — at launch they
 *    can. Compiled binaries materialize from their embedded asset with no
 *    network, so this failure path is effectively the offline from-source case.
 *
 * It still NEVER spawns the sidecar or probe-embeds — materialization is
 * download/extract only, and the launch gate must stay off the inference path.
 * For `off` / `api-key`, readiness is not the embedding setup's concern —
 * return `ok`.
 */
export async function ensureEmbedderReady(): Promise<Result<void, EmbeddingSetupError>> {
    const { mode, modelPath: configuredPath } = readConfig().embedding;
    if (mode !== "local") return ok(undefined);

    // Gate on the CONFIGURED model path, not the built-in location: a custom GGUF lives at the user's own
    // path, and checking `env.embeddingModelPath` would spuriously fail when that path isn't the built-in
    // one. Fall back to the built-in location only when nothing is recorded (a legacy/hand-edited config).
    const modelPath = configuredPath ?? env.embeddingModelPath;
    if (!(await Bun.file(modelPath).exists())) {
        return err({
            type: "not_configured",
            message: `Local embedding model not found at ${modelPath}. Run \`inflexa setup\` to configure a model, or point \`embedding.modelPath\` at your GGUF.`,
        });
    }

    if (materializedLlamaServer() !== null) return ok(undefined);

    const materialized = await ensureLlamaServer();
    if (materialized.isErr()) {
        return err({
            type: "runtime_unavailable",
            message: `The local embedding runtime is not installed and could not be acquired: ${materialized.error.message}\n  Reconnect and relaunch, or run \`inflexa setup --embeddings local\`; to proceed without it, switch \`embedding.mode\` to \`api-key\` or \`off\`.`,
            cause: materialized.error.cause,
        });
    }
    return ok(undefined);
}

/**
 * TEST ONLY. Force the embedded-model asset path so a unit test can exercise the embedded-copy
 * acquisition branch without a real compiled binary, or `null` to restore the real
 * `__INFLEXA_COMPILED__`-gated resolution. Production code never calls it.
 */
export function __setEmbeddedModelForTest(path: string | null): void {
    embeddedModelOverride = path;
}

/**
 * TEST ONLY. Force the model pin (url + sha256) so a unit test can drive {@link acquireModel} against
 * a fixture source and checksum, or `null` to restore the vendored constants. Production code never
 * calls it.
 */
export function __setModelPinForTest(pin: { readonly url: string; readonly sha256: string } | null): void {
    modelPinOverride = pin;
}

/**
 * TEST ONLY. Force the api-key embedding secret so a unit test can drive the api-key branch's
 * environment channel without mutating the process environment, or `null` to restore the real
 * {@link resolveEmbeddingApiKey} read. Production code never calls it.
 */
export function __setEmbeddingApiKeyForTest(read: (() => string | undefined) | null): void {
    embeddingApiKeyOverride = read;
}
