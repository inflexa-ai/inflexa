/**
 * The sandbox image, end to end: the `inflexa sandbox` command actions (pull, status), the config
 * write that records the chosen image, and the pre-flight gate that a launch passes through.
 *
 * Two entry points reach the registry, and each one owns a different question. `sandboxPull` is the
 * DELIBERATE provisioning path — the `sandbox pull` command and the `inflexa setup` wizard both
 * funnel through it, and it re-pulls a moving `:latest` so it doubles as the upgrade path.
 * `ensureSandboxImage` is the IMPLICIT one — a launch asking only whether the configured image is
 * here, and pulling it when it is not. Both live here so neither can drift from the variant naming
 * and the presence read they share.
 *
 * The model: the user picks an image VARIANT (`python` | `python-r`), the CLI
 * `docker pull`s `ghcr.io/inflexa-ai/sandbox-<variant>`, and records it as
 * `harness.sandboxImage` so sandboxes launch on the baked image — no local store
 * directory, no `/mnt/libs` bind mount, and no arch-forcing (a multi-arch manifest
 * resolves the host architecture automatically). The per-track tarballs are managed-only
 * (mounted by infra, not this CLI).
 */

import { isCancel, log, select as clackSelect } from "@clack/prompts";
import { err, ok, type Result } from "neverthrow";

import { confirm, fail } from "../../lib/cli.ts";
import { ensureRuntime, readConfig, selectedRuntime, writeConfig } from "../../lib/config.ts";
import { capture, firstReadyRuntime, inherit, runtimeIds, runtimes, type ContainerRuntime } from "../../lib/container.ts";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_VARIANTS, VARIANT_DESCRIPTIONS, VARIANT_LABELS, variantImage, variantOfImage, type SandboxVariant } from "./images.ts";
import { resolvePackagesFile } from "./packages.ts";

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

/** Whether `rt` already has `image` locally. */
async function imagePresent(rt: ContainerRuntime, image: string): Promise<boolean> {
    return (await capture(rt, ["image", "inspect", image])).code === 0;
}

/**
 * Whether `image` is a MOVING reference — a `:latest` tag or no tag at all (which
 * the runtime treats as `:latest`). A moving ref must be re-pulled even when it is
 * present locally, because a newer remote digest can hide behind the same tag; an
 * immutable ref (a pinned `:<version>` tag or an `@sha256:` digest) that is present
 * is already authoritative and needs no pull. The last path segment carries the
 * tag, so a registry `host:port/` prefix never confuses the check.
 */
export function isMovingTag(image: string): boolean {
    if (image.includes("@")) return false; // digest pin — immutable
    const lastSegment = image.slice(image.lastIndexOf("/") + 1);
    const colon = lastSegment.indexOf(":");
    const tag = colon === -1 ? "latest" : lastSegment.slice(colon + 1);
    return tag === "latest";
}

/**
 * Pre-flight gate: the configured sandbox image must be present before a command stages anything.
 * After staging it is too late to find out. A missing PUBLISHED variant is pulled from GHCR (offered
 * and confirmed on a TTY, pulled directly otherwise). A missing CUSTOM local tag cannot be pulled, so
 * this names the build command instead. Never a silent dead-end.
 *
 * A present image short-circuits, which is the deliberate difference from {@link sandboxPull}. That
 * one re-pulls a moving `:latest` even when it is present, because it doubles as the upgrade path. A
 * gate that downloaded on every launch would be a tax on every launch.
 *
 * This is the one function here that exits the process through `fail` instead of giving a `Result`.
 * Every caller is a CLI entry point at a pre-flight gate with nothing to recover to: with no sandbox
 * image the command cannot run at all, so a `Result` would buy each caller one `match` that ends in
 * this same exit. {@link sandboxPull} keeps its `Result` because a declined pull is a state the setup
 * wizard genuinely continues past.
 */
export async function ensureSandboxImage(image: string): Promise<void> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) fail(rtResult.error.message);
    const rt = rtResult.value;
    if (await imagePresent(rt, image)) return;

    const variant = variantOfImage(image);
    if (variant === null) {
        // A custom local tag (a user's `FROM` image) — we cannot pull it.
        fail(
            [
                `Sandbox image "${image}" not found in ${rt.id}.`,
                `Build it locally (e.g. \`${rt.bin} build -f images/sandbox-python-r/Dockerfile -t ${image} .\`),`,
                "or set `harness.sandboxImage` to a published `ghcr.io/inflexa-ai/sandbox-*` tag and run `inflexa sandbox pull`.",
            ].join("\n"),
        );
    }

    // Published variant: offer + pull. The image is genuinely required to launch a
    // sandbox, so a decline is an actionable stop, not a silent dead-end.
    if (process.stdin.isTTY) {
        console.log(`\n  Sandbox image "${image}" (${variant}) is not installed.`);
        const proceed = await confirm("Pull it from GitHub Packages now? (may be a multi-GB download)");
        if (!proceed) fail("A sandbox image is required to run a profile. Run `inflexa sandbox pull` and retry.");
    } else {
        console.log(`  Sandbox image "${image}" not present — pulling ${variant} from GitHub Packages…`);
    }
    const code = await inherit(rt, ["pull", image]);
    if (code !== 0) fail(`Failed to pull ${image} (\`${rt.bin} pull\` exited ${code}). Check your network and that ghcr.io is reachable.`);
}

/**
 * Provision the sandbox image. Resolves a variant (prompting interactively when
 * none is given), `docker pull`s the multi-arch image from GHCR, and records it as
 * `harness.sandboxImage`. Because the variant resolves to a moving `:latest` ref,
 * a pull always refreshes to the current remote digest — even when the image is
 * present locally — so `sandbox pull` doubles as the image-upgrade path (a present
 * image transfers only changed layers, so no size prompt). An immutable pinned ref
 * that is already present short-circuits to `up_to_date` with nothing on the wire.
 */
export async function sandboxPull(opts: PullOptions = {}): Promise<Result<PullOutcome, PullError>> {
    const interactive = !opts.quiet && process.stdin.isTTY;

    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });
    const rt = rtResult.value;

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
            options: SANDBOX_VARIANTS.map((v) => ({ value: v, label: VARIANT_LABELS[v], hint: VARIANT_DESCRIPTIONS[v] })),
        });
        if (isCancel(chosen)) return ok({ type: "declined" });
        variant = chosen;
    }
    const image = variantImage(variant);
    const present = await imagePresent(rt, image);

    // An IMMUTABLE ref that is already present is authoritative — record the config
    // and pull nothing. A MOVING `:latest` ref falls through to the pull below even
    // when present, so `sandbox pull` refreshes to the current remote digest.
    if (present && !isMovingTag(image)) {
        const configured = configureSandboxImage(image);
        if (configured.isErr()) return err(configured.error);
        return ok({ type: "up_to_date", variant, image });
    }

    // The size confirmation is only for the FIRST (absent) pull — a multi-GB
    // download. Refreshing a present `:latest` transfers only changed layers (often
    // nothing), so it runs without the prompt.
    if (!present && interactive && !opts.yes) {
        const proceed = await confirm(`Pull the ${variant} sandbox image (${image})? This may be a multi-GB download.`);
        if (!proceed) return ok({ type: "declined" });
    }

    // Stream progress interactively; capture (buffered) when a caller owns the UI.
    if (!opts.quiet) log.info(`${present ? "Refreshing" : "Pulling"} ${image} …`);
    const code = opts.quiet ? (await capture(rt, ["pull", image])).code : await inherit(rt, ["pull", image]);
    if (code !== 0) {
        return err({
            type: "pull_failed",
            message: `\`${rt.bin} pull ${image}\` exited ${code}. Check your network and that GitHub Packages (ghcr.io) is reachable.`,
        });
    }

    const configured = configureSandboxImage(image);
    if (configured.isErr()) return err(configured.error);
    // Cache the image's package inventory while the image is definitely present. A
    // failure here is not a failed pull: the harness reports the package set as
    // unknown and the run proceeds, so it must not turn a good pull into an error.
    if ((await resolvePackagesFile(rt, image)) === null && !opts.quiet) {
        log.warn(`${image} carries no package inventory — agents will be told the installed set is unknown.`);
    }
    return ok({ type: "pulled", variant, image });
}

// --- status ------------------------------------------------------------------

/** `inflexa sandbox status` — configured variant, GHCR reference, local presence, digest. */
export async function sandboxStatus(): Promise<void> {
    const image = configuredSandboxImage();
    const variant = variantOfImage(image);

    console.log(`  Image    ${image}`);
    console.log(`  Variant  ${variant ?? "(custom — not a published sandbox-python/-r image)"}`);

    // Status is a read-only diagnostic: use the selected runtime, or detect a ready
    // one WITHOUT pinning it — a passive inspection must not write config (that is
    // ensureRuntime's job, reserved for commands that create runtime-bound state).
    const rt =
        selectedRuntime() ??
        (await firstReadyRuntime(runtimeIds.map((id) => runtimes[id]))).match(
            (detected) => detected,
            () => null,
        );
    if (rt === null) {
        console.log("  Present  unknown — no container runtime available (start Docker or Podman)");
        return;
    }

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
