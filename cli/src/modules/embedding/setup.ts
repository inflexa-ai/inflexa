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

import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { log, spinner as clackSpinner } from "@clack/prompts";
import { err, ok, type Result } from "neverthrow";

import { readConfig, writeConfig } from "../../lib/config.ts";
import { select } from "../../lib/cli.ts";
import { env } from "../../lib/env.ts";

export type EmbeddingSetupError =
    | { readonly type: "download_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "verify_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "dimension_mismatch"; readonly message: string; readonly expected: number; readonly actual: number }
    | { readonly type: "not_configured"; readonly message: string };

const MODEL_URL = "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf";
const EXPECTED_DIM = 384;

/**
 * Download the GGUF model to {@link env.embeddingModelPath}, skipping if it is
 * already present. Streams the response to disk under a clack spinner so the
 * ~36 MB download is visible. A network/HTTP failure surfaces as
 * `download_failed` — never thrown.
 */
export async function downloadModel(): Promise<Result<void, EmbeddingSetupError>> {
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

        const file = Bun.file(env.embeddingModelPath);
        const writer = file.writer();
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
        }
        await writer.flush();

        const written = (await stat(env.embeddingModelPath)).size;
        s.stop(`Downloaded ${(written / 1024 / 1024).toFixed(1)} MB`);
        return ok(undefined);
    } catch (cause) {
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
        if (dim !== EXPECTED_DIM) {
            s.error("Dimension mismatch");
            return err({
                type: "dimension_mismatch",
                message: `Model produced ${dim}-dim vectors, expected ${EXPECTED_DIM}. The GGUF may be the wrong model.`,
                expected: EXPECTED_DIM,
                actual: dim,
            });
        }
        s.stop(`Verified: ${EXPECTED_DIM}-dim vectors`);
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
            // API-key mode setup is deferred to the harness-wiring change; only
            // local setup is implemented here. Decline cleanly rather than half-doing it.
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
        log.warn("API-key embedding mode is not yet configured by setup. Set `embedding.apiKey` in config manually.");
        return ok(undefined);
    }
    // choice === "local"
    return runLocalSetup(config);
}

/** The local-embeddings opt-in branch: trust runtime, download, verify, write config. */
async function runLocalSetup(config: ReturnType<typeof readConfig>): Promise<Result<void, EmbeddingSetupError>> {
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
        { value: "api-key", label: "API key (route through the proxy)" },
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
