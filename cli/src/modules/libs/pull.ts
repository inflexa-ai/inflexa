/**
 * The `inflexa sandbox` command actions — pull, status — plus the config write
 * that records the chosen image. `sandboxPull` is the ONE dogfooded provisioning
 * path: the `sandbox pull` command and the `inflexa setup` wizard both funnel
 * through it. There is no second image-fetch path.
 *
 * The model: the user picks an image VARIANT (`python` | `python-r`), the CLI
 * `docker pull`s `ghcr.io/inflexa-ai/inf-cli/sandbox-<variant>`, and records it as
 * `harness.sandboxImage` so sandboxes launch on the baked image — no local store
 * directory, no `/mnt/libs` bind mount, and no arch-forcing (a multi-arch manifest
 * resolves the host architecture automatically). The pre-flight `ensureSandboxImage`
 * (modules/harness/profile.ts) pulls the configured image on launch when it is
 * absent; the per-track tarballs are managed-only (mounted by infra, not this
 * CLI).
 */

import { isCancel, log, select as clackSelect } from "@clack/prompts";
import { err, ok, type Result } from "neverthrow";

import { confirm } from "../../lib/cli.ts";
import { activeRuntime, readConfig, writeConfig } from "../../lib/config.ts";
import { capture, ensureReady, inherit } from "../../lib/container.ts";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_VARIANTS, VARIANT_DESCRIPTIONS, variantImage, variantOfImage, type SandboxVariant } from "./images.ts";

/** Flags accepted by `inflexa sandbox pull` (and reused by setup). */
export type PullOptions = {
    /** The image variant to pull; when absent, prompt interactively. */
    readonly variant?: SandboxVariant;
    /** Skip the pull-size confirmation (also implied non-interactively). */
    readonly yes?: boolean;
    /** Suppress the streamed pull progress — used when a caller owns its own spinner. */
    readonly quiet?: boolean;
};

/** The result of a pull, for the caller to report. */
export type PullOutcome =
    | { readonly type: "up_to_date"; readonly variant: SandboxVariant; readonly image: string }
    | { readonly type: "pulled"; readonly variant: SandboxVariant; readonly image: string }
    | { readonly type: "declined" };

/**
 * A pull failed. Each variant names one stage (runtime readiness → variant choice
 * → docker pull → config write); the message is user-facing and the optional
 * `cause` carries the underlying throw for logs.
 */
export type PullError =
    | { readonly type: "runtime_unavailable"; readonly message: string }
    | { readonly type: "no_variant"; readonly message: string }
    | { readonly type: "pull_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "config_write_failed"; readonly message: string; readonly cause?: unknown };

/**
 * The configured sandbox image from the raw config's opaque `harness` block,
 * defaulting to {@link DEFAULT_SANDBOX_IMAGE}. Reads the raw config (not
 * `resolveHarnessConfig`) so this module does not import modules/harness — keeping
 * the dependency one-directional (harness config → this module for the default).
 */
export function configuredSandboxImage(): string {
    // `harness` is declared `unknown` in the config schema (validated downstream in
    // modules/harness/config.ts); read the one field we own defensively.
    const harness = readConfig().harness;
    if (typeof harness === "object" && harness !== null) {
        const img = (harness as Record<string, unknown>).sandboxImage;
        if (typeof img === "string" && img.trim() !== "") return img;
    }
    return DEFAULT_SANDBOX_IMAGE;
}

/**
 * Record `image` as `harness.sandboxImage`, preserving the rest of the opaque
 * `harness` block. The block is `unknown` in the config schema, so we shallow-merge
 * onto whatever object is there (or a fresh one).
 */
function configureSandboxImage(image: string): Result<void, PullError> {
    const cfg = readConfig();
    const harness = typeof cfg.harness === "object" && cfg.harness !== null ? (cfg.harness as Record<string, unknown>) : {};
    return writeConfig({ ...cfg, harness: { ...harness, sandboxImage: image } }).mapErr((e) => ({
        type: "config_write_failed",
        message: `Could not record the sandbox image in config.json: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`,
        cause: e.cause,
    }));
}

/** Whether the runtime already has `image` locally (a present image is never re-pulled). */
async function imagePresent(image: string): Promise<boolean> {
    return (await capture(activeRuntime(), ["image", "inspect", image])).code === 0;
}

/**
 * Provision the sandbox image. Resolves a variant (prompting interactively when
 * none is given), and — unless the image is already present locally (idempotent
 * no-op) — confirms the download, `docker pull`s the multi-arch image from GHCR,
 * and records it as `harness.sandboxImage`. Re-pulling a present image reports
 * `up_to_date` with nothing on the wire.
 */
export async function sandboxPull(opts: PullOptions = {}): Promise<Result<PullOutcome, PullError>> {
    const interactive = !opts.quiet && process.stdin.isTTY;
    const rt = activeRuntime();

    const ready = await ensureReady(rt);
    if (ready.isErr()) return err({ type: "runtime_unavailable", message: ready.error.message });

    // Resolve the variant: an explicit choice, else an interactive prompt. A
    // non-interactive run without a variant cannot proceed (no way to choose).
    let variant = opts.variant ?? null;
    if (variant === null) {
        if (!interactive) {
            return err({
                type: "no_variant",
                message: "No image variant given. Run `inflexa sandbox pull <python|python-r> --yes` on a non-interactive terminal.",
            });
        }
        const chosen = await clackSelect({
            message: "Which sandbox image?",
            options: SANDBOX_VARIANTS.map((v) => ({ value: v, label: v, hint: VARIANT_DESCRIPTIONS[v] })),
        });
        if (isCancel(chosen)) return ok({ type: "declined" });
        variant = chosen;
    }
    const image = variantImage(variant);

    // Present locally → idempotent no-op (record the config, pull nothing).
    if (await imagePresent(image)) {
        const configured = configureSandboxImage(image);
        if (configured.isErr()) return err(configured.error);
        return ok({ type: "up_to_date", variant, image });
    }

    if (interactive && !opts.yes) {
        const proceed = await confirm(`Pull the ${variant} sandbox image (${image})? This may be a multi-GB download.`);
        if (!proceed) return ok({ type: "declined" });
    }

    // Stream progress interactively; capture (buffered) when a caller owns the UI.
    if (!opts.quiet) log.info(`Pulling ${image} …`);
    const code = opts.quiet ? (await capture(rt, ["pull", image])).code : await inherit(rt, ["pull", image]);
    if (code !== 0) {
        return err({
            type: "pull_failed",
            message: `\`${rt.bin} pull ${image}\` exited ${code}. Check your network and that GitHub Packages (ghcr.io) is reachable.`,
        });
    }

    const configured = configureSandboxImage(image);
    if (configured.isErr()) return err(configured.error);
    return ok({ type: "pulled", variant, image });
}

// --- status ------------------------------------------------------------------

/** `inflexa sandbox status` — configured variant, GHCR reference, local presence, digest. */
export async function sandboxStatus(): Promise<void> {
    const rt = activeRuntime();
    const image = configuredSandboxImage();
    const variant = variantOfImage(image);

    console.log(`  Image    ${image}`);
    console.log(`  Variant  ${variant ?? "(custom — not a published sandbox-python/-r image)"}`);

    // `--format {{.Id}}` prints the local image digest; a non-zero exit means absent.
    const inspect = await capture(rt, ["image", "inspect", "--format", "{{.Id}}", image]);
    if (inspect.code === 0) {
        console.log(`  Present  yes`);
        console.log(`  Digest   ${inspect.stdout.trim()}`);
    } else {
        console.log(`  Present  no`);
        console.log(`  Run \`inflexa sandbox pull${variant ? ` ${variant}` : ""}\` to download it.`);
    }
}
