/**
 * Local embedding model lifecycle: download, verify, configure, and the hot-path
 * readiness gate. Mirrors `modules/infra/setup.ts` — "download a thing on opt-in,
 * verify it, record the choice in config, and gate the hot path on it being
 * present" — and uses the same `@clack/prompts` UI (`select`/`spinner`/`log`) so
 * the two setup flows feel consistent.
 *
 * The model is `bge-small-en-v1.5` (GGUF, q8_0, 384-dim, ~36 MB) from
 * `CompendiumLabs/bge-small-en-v1.5-gguf` on HuggingFace. Download is skipped if
 * the file already exists; verification (load + embed probe + dim check) always
 * runs so a truncated/corrupt file is caught now, not on the first hot-path
 * `embed()` call.
 */

import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { log, spinner as clackSpinner } from "@clack/prompts";
import { err, ok, type Result } from "neverthrow";

import { readConfig, writeConfig } from "../../lib/config.ts";
import { select } from "../../lib/cli.ts";
import { env } from "../../lib/env.ts";
import { LOCAL_EMBEDDING_DIMENSIONS } from "./local-provider.ts";

export type EmbeddingSetupError =
    | { readonly type: "download_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "verify_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "dimension_mismatch"; readonly message: string; readonly expected: number; readonly actual: number }
    | { readonly type: "not_configured"; readonly message: string };

/**
 * Pinned to the repo revision current as of 2026-07 (last modified 2024-02-17),
 * not `main`: an unpinned ref would let a repo update (or a MITM on the ref)
 * silently swap the model, with only the dimension probe standing between a
 * different model and the vector store. The sha256 below is the file's LFS
 * object id at this revision, verified against the download stream.
 */
const MODEL_URL = "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/d32f8c040ea3b516330eeb75b72bcc2d3a780ab7/bge-small-en-v1.5-q8_0.gguf";
const MODEL_SHA256 = "ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514";

/**
 * Download the GGUF model to {@link env.embeddingModelPath}, skipping if it is
 * already present. Streams the response to disk under a clack spinner so the
 * ~36 MB download is visible. A network/HTTP failure surfaces as
 * `download_failed` — never thrown.
 *
 * The stream lands in a `.part` sidecar that is renamed into place only after a
 * complete flush: the "already present" check above trusts bare existence, so a
 * mid-stream failure must never leave bytes at the final path — a truncated
 * file there would be skipped as "already present" on retry and only caught by
 * `verifyModel`, with no hint that deleting it fixes things.
 */
export async function downloadModel(): Promise<Result<void, EmbeddingSetupError>> {
    const partPath = `${env.embeddingModelPath}.part`;
    try {
        if (await Bun.file(env.embeddingModelPath).exists()) {
            log.info(`Embedding model already present at ${env.embeddingModelPath}`);
            return ok(undefined);
        }

        await mkdir(dirname(env.embeddingModelPath), { recursive: true });

        const s = clackSpinner();
        s.start("Downloading bge-small-en-v1.5 (q8_0, ~36 MB) from HuggingFace");

        const response = await fetch(MODEL_URL);
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
        const hasher = new Bun.CryptoHasher("sha256");
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            hasher.update(value);
            await writer.write(value);
        }
        await writer.flush();

        const digest = hasher.digest("hex");
        if (digest !== MODEL_SHA256) {
            s.error("Checksum mismatch");
            await unlink(partPath).catch(() => {});
            return err({
                type: "download_failed",
                message: `Downloaded file's sha256 (${digest}) does not match the pinned model checksum. Retry, or check your network path to huggingface.co.`,
            });
        }
        await rename(partPath, env.embeddingModelPath);

        const written = (await stat(env.embeddingModelPath)).size;
        s.stop(`Downloaded ${(written / 1024 / 1024).toFixed(1)} MB`);
        return ok(undefined);
    } catch (cause) {
        // Best-effort cleanup; a `.part` leftover is harmless (never mistaken
        // for the model) but would confuse a du/ls of the model dir.
        await unlink(partPath).catch(() => {});
        return err({
            type: "download_failed",
            message: `Download failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
        });
    }
}

/**
 * Verify the GGUF loads and produces 384-dim vectors by embedding a probe text.
 * Catches a truncated/corrupt file or a wrong-model download now, so the hot
 * path never hits a load failure. A load error is `verify_failed`; a wrong
 * dimension is `dimension_mismatch` (so the caller can distinguish "the file is
 * broken" from "the file is the wrong model").
 */
export async function verifyModel(modelPath: string): Promise<Result<void, EmbeddingSetupError>> {
    const s = clackSpinner();
    s.start("Verifying model (load + embed probe)");
    try {
        const { getLlama } = await import("node-llama-cpp");
        const llama = await getLlama();
        const model = await llama.loadModel({ modelPath });
        const context = await model.createEmbeddingContext();
        const probe = await context.getEmbeddingFor("inflexa embedding verification probe");
        const dim = probe.vector.length;
        await llama.dispose();
        if (dim !== LOCAL_EMBEDDING_DIMENSIONS) {
            s.error("Dimension mismatch");
            return err({
                type: "dimension_mismatch",
                message: `Model produced ${dim}-dim vectors, expected ${LOCAL_EMBEDDING_DIMENSIONS}. The GGUF may be the wrong model.`,
                expected: LOCAL_EMBEDDING_DIMENSIONS,
                actual: dim,
            });
        }
        s.stop(`Verified: ${LOCAL_EMBEDDING_DIMENSIONS}-dim vectors`);
        return ok(undefined);
    } catch (cause) {
        s.error("Verification failed");
        return err({
            type: "verify_failed",
            message: `Model verification failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
        });
    }
}

/**
 * Trigger `bun pm trust node-llama-cpp` to fetch the prebuilt native binaries
 * (bun blocks postinstall scripts by default; this is the sanctioned opt-in).
 * On platforms where the platform package already ships binaries in its tarball
 * this is effectively a no-op, but it is the cross-platform-safe way to ensure
 * the native runtime is present. A failure here is non-fatal — the download +
 * verify steps will surface a clearer error if the runtime is genuinely missing.
 */
async function trustNativeRuntime(): Promise<void> {
    try {
        const proc = Bun.spawn(["bun", "pm", "trust", "node-llama-cpp"], { stdout: "ignore", stderr: "pipe" });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            log.warn(`\`bun pm trust\` exited ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`);
        }
    } catch (cause) {
        // Non-fatal: verifyModel will report a clearer error if the runtime is missing.
        log.warn(`\`bun pm trust\` could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
}

/**
 * Interactive embedding setup, run as part of `inflexa setup`. Prompts the user
 * to pick an embedding mode via a clack `select` picker (local / api-key / off),
 * then for `local`: fetches the native runtime + GGUF, verifies it, and records
 * `embedding.mode = "local"` + `embedding.modelPath` in config.
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
        // preselected === "local": fall through to the local setup branch.
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

/** The local-embeddings opt-in branch: trust runtime, download, verify, write config. */
async function runLocalSetup(config: ReturnType<typeof readConfig>): Promise<Result<void, EmbeddingSetupError>> {
    warnOnModeSwitch(config.embedding.mode, "local");
    log.message("Setting up local embeddings (bge-small-en-v1.5, in-process, no API key needed)");

    await trustNativeRuntime();

    const downloadResult = await downloadModel();
    if (downloadResult.isErr()) return downloadResult;

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
    const chosen = await select("Embedding mode", [
        { value: "local", label: "Local (in-process, downloads a 36 MB model, no API key)" },
        { value: "api-key", label: "API key (direct to an OpenAI-compatible endpoint)" },
        { value: "off", label: "Off / skip" },
    ]);
    return chosen as "local" | "api-key" | "off";
}

/**
 * Hot-path readiness gate, mirroring `ensureProxyReady`. For `local` mode,
 * checks the GGUF file exists — a file-exists check is sufficient here (the
 * first `embed()` lazily loads it, and `verifyModel` ran at setup time). A
 * missing file directs the user to `inflexa setup`. For `off` / `api-key`,
 * readiness is not the embedding setup's concern — return `ok`.
 */
export async function ensureEmbedderReady(): Promise<Result<void, EmbeddingSetupError>> {
    const { mode } = readConfig().embedding;
    if (mode !== "local") return ok(undefined);

    if (!(await Bun.file(env.embeddingModelPath).exists())) {
        return err({
            type: "not_configured",
            message: `Local embedding model not found at ${env.embeddingModelPath}. Run \`inflexa setup --embeddings local\` to download it.`,
        });
    }
    return ok(undefined);
}
