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

import type { AgentSession } from "@inflexa-ai/harness";

import { readConfig, writeConfig } from "../../lib/config.ts";
import { select } from "../../lib/cli.ts";
import { env } from "../../lib/env.ts";
import { isCompiledBinary } from "../../lib/install_context.ts";
import { ensureLlamaServer, materializedLlamaServer } from "./llama_runtime.ts";
import { createLocalEmbeddingProvider, LOCAL_EMBEDDING_DIMENSIONS, stopLocalSidecar } from "./local-provider.ts";
import { MODEL_SHA256, MODEL_URL } from "./model_pin.ts";

export type EmbeddingSetupError =
    | { readonly type: "download_failed"; readonly message: string; readonly cause?: unknown }
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
// whole acquire pipeline against a fixture url/hash. Both `null` in production.
let embeddedModelOverride: string | null = null;
let modelPinOverride: { readonly url: string; readonly sha256: string } | null = null;

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
 * rather than per-source. Every failure surfaces as `download_failed` — never thrown.
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
                    type: "download_failed",
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
                    type: "download_failed",
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
                type: "download_failed",
                message: embedded
                    ? `The bundled model's sha256 (${digest}) does not match the pinned checksum — the embedded asset is corrupt. Reinstall the official binary for your platform.`
                    : `Downloaded file's sha256 (${digest}) does not match the pinned model checksum. Retry, or check your network path to huggingface.co.`,
            });
        }
        await rename(partPath, env.embeddingModelPath);

        const written = (await stat(env.embeddingModelPath)).size;
        s.stop(embedded ? `Installed ${(written / 1024 / 1024).toFixed(1)} MB (bundled model)` : `Downloaded ${(written / 1024 / 1024).toFixed(1)} MB`);
        return ok(undefined);
    } catch (cause) {
        // Best-effort cleanup; a `.part` leftover is harmless (never mistaken
        // for the model) but would confuse a du/ls of the model dir.
        await unlink(partPath).catch(() => {});
        return err({
            type: "download_failed",
            message: `Model acquisition failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
        });
    }
}

/**
 * Verify the model end-to-end through the sidecar: spawn `llama-server` against
 * the downloaded GGUF, embed a probe text, and assert the vector width is 384.
 * This is the identical path the hot loop uses, so a "works in dev, dead in the
 * binary" divergence cannot hide here — verification proves the real runtime, not
 * a separate load path. Catches a truncated/corrupt file or a wrong-model
 * download now, so the hot path never hits a startup failure. A start/probe error
 * is `verify_failed`; a wrong dimension is `dimension_mismatch` (so the caller can
 * distinguish "the file is broken" from "the file is the wrong model").
 *
 * The sidecar is torn down immediately after the probe rather than left running
 * for the process lifetime — setup only needs the one probe.
 */
export async function verifyModel(modelPath: string): Promise<Result<void, EmbeddingSetupError>> {
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
    if (outcome.dim !== LOCAL_EMBEDDING_DIMENSIONS) {
        s.error("Dimension mismatch");
        return err({
            type: "dimension_mismatch",
            message: `Model produced ${outcome.dim}-dim vectors, expected ${LOCAL_EMBEDDING_DIMENSIONS}. The GGUF may be the wrong model.`,
            expected: LOCAL_EMBEDDING_DIMENSIONS,
            actual: outcome.dim,
        });
    }
    s.stop(`Verified: ${LOCAL_EMBEDDING_DIMENSIONS}-dim vectors`);
    return ok(undefined);
}

/**
 * Interactive embedding setup, run as part of `inflexa setup`. Prompts the user
 * to pick an embedding mode via a clack `select` picker (local / api-key / off),
 * then for `local`: materializes the sidecar runtime + acquires the GGUF (embedded
 * asset in the compiled binary, download from source), verifies it through the
 * sidecar, and records `embedding.mode = "local"` + `embedding.modelPath` in config.
 *
 * Non-interactive shells (no TTY, or `interactive === false`) skip the prompt
 * entirely without hanging — `mode` stays whatever it was. A preselected `mode`
 * (from `--embeddings`) overrides the prompt and runs the matching branch
 * non-interactively.
 */
export async function runEmbeddingSetup(interactive: boolean, preselected?: "local" | "api-key" | "off"): Promise<Result<void, EmbeddingSetupError>> {
    const config = readConfig();

    // A preselected mode from `--embeddings` short-circuits the prompt.
    if (preselected !== undefined) {
        if (preselected === "off") return ok(undefined);
        if (preselected === "api-key") {
            warnOnModeSwitch(config.embedding.mode, "api-key");
            // API-key mode setup is deferred; only local setup is implemented
            // here. Decline cleanly rather than half-doing it.
            log.warn("API-key embedding mode is selected but not yet configured by setup. Set `embedding.apiKey` in config manually.");
            return ok(undefined);
        }
        // preselected === "local"
        return runLocalSetup(config);
    }

    // Already configured (mode is no longer the default `off`): don't re-prompt
    // on every launch — the user already made a choice. `ensureEmbedderReady`
    // separately gates the hot path on a local model being present.
    if (config.embedding.mode !== "off") return ok(undefined);

    // Non-interactive: skip the prompt, leave mode unchanged (no hang).
    if (!interactive || !process.stdin.isTTY) return ok(undefined);

    const choice = await promptEmbeddingMode();
    if (choice === "off") {
        log.info("Embeddings skipped (mode left unchanged).");
        return ok(undefined);
    }
    if (choice === "api-key") {
        warnOnModeSwitch(config.embedding.mode, "api-key");
        log.warn("API-key embedding mode is not yet configured by setup. Set `embedding.apiKey` in config manually.");
        return ok(undefined);
    }
    // choice === "local"
    return runLocalSetup(config);
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

/** The local-embeddings opt-in branch: materialize runtime, acquire model, verify through the sidecar, write config. */
async function runLocalSetup(config: ReturnType<typeof readConfig>): Promise<Result<void, EmbeddingSetupError>> {
    warnOnModeSwitch(config.embedding.mode, "local");
    log.message("Setting up local embeddings (bge-small-en-v1.5 via the pinned llama-server runtime, no API key needed)");

    // Materialize the runtime first, under its own spinner, so the one-time first-run
    // cost is narrated rather than a silent stall: macOS pays a ~10s OS scan of the
    // fresh binaries the first time they run, and paying it here (not mid-analysis) is
    // the whole point of setup-time verification. Idempotent — a subsequent spawn reuses it.
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

    const acquireResult = await acquireModel();
    if (acquireResult.isErr()) return acquireResult;

    const verifyResult = await verifyModel(env.embeddingModelPath);
    if (verifyResult.isErr()) return verifyResult;

    // Write the config choice. `writeConfig` is sync; mapErr translates its
    // ConfigError into an EmbeddingSetupError, and map records the success
    // side-effect. Both consume the Result so the must-use-result rule is satisfied.
    return writeConfig({ ...config, embedding: { mode: "local", modelPath: env.embeddingModelPath } })
        .mapErr((e): EmbeddingSetupError => ({ type: "verify_failed", message: `Verification passed but config could not be written: ${e.type}` }))
        .map(() => {
            log.success("Local embeddings configured. `embedding.mode` is now `local`.");
            return undefined;
        });
}

/**
 * Embedding mode picker via clack `select`. Offers all three modes so the user
 * can choose `api-key` interactively (not just local-vs-skip). Returns the
 * chosen mode string; clack handles cancel (Ctrl-C / Esc) by aborting.
 */
async function promptEmbeddingMode(): Promise<"local" | "api-key" | "off"> {
    // Local mode works identically in the compiled binary and from source (both the runtime AND the
    // model are downloaded/embedded assets, not native addons), so all three modes are offered in
    // every install context — no context gates the offering.
    const chosen = await select("Embedding mode", [
        {
            value: "local",
            label: isCompiledBinary()
                ? "Local (installs the bundled ~36 MB model + runtime, no API key or network)"
                : "Local (downloads a ~36 MB model + runtime, no API key)",
        },
        { value: "api-key", label: "API key (direct to an OpenAI-compatible endpoint)" },
        { value: "off", label: "Off / skip" },
    ]);
    return chosen as "local" | "api-key" | "off";
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
    const { mode } = readConfig().embedding;
    if (mode !== "local") return ok(undefined);

    if (!(await Bun.file(env.embeddingModelPath).exists())) {
        return err({
            type: "not_configured",
            message: `Local embedding model not found at ${env.embeddingModelPath}. Run \`inflexa setup --embeddings local\` to install it.`,
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
