/**
 * The `inflexa sandbox` command actions. `latest` is an update-discovery
 * channel only: a successful published-image pull resolves the image's stamped
 * version, creates the matching local version tag, and persists that stable
 * execution reference.
 */

import { isCancel, log, select as clackSelect } from "@clack/prompts";
import { err, ok, type Result } from "neverthrow";

import { confirm } from "../../lib/cli.ts";
import { ensureRuntime, readConfig, selectedRuntime, writeConfig } from "../../lib/config.ts";
import { capture, firstReadyRuntime, inherit, runtimeIds, runtimes, type CaptureResult, type ContainerRuntime } from "../../lib/container.ts";
import {
    DEFAULT_SANDBOX_IMAGE,
    SANDBOX_VARIANTS,
    SANDBOX_VERSION_LABEL,
    VARIANT_DESCRIPTIONS,
    VARIANT_LABELS,
    parseSandboxVersion,
    publishedVersionOfImage,
    variantImage,
    variantOfImage,
    variantRepository,
    versionedVariantImage,
    type SandboxVariant,
} from "./images.ts";
import { resolvePackagesFile } from "./packages.ts";

/** Flags accepted by `inflexa sandbox pull` (and reused by setup). */
export type PullOptions = {
    /** The image variant to pull; when absent, prompt interactively. */
    readonly variant?: SandboxVariant;
    /** Skip the pull-size confirmation (also implied non-interactively). */
    readonly yes?: boolean;
    /** Suppress streamed pull progress and informational cleanup messages. */
    readonly quiet?: boolean;
};

/** Best-effort post-commit cleanup results. */
export type CleanupReport = {
    /** Exact version tags removed successfully. */
    readonly removed: readonly string[];
    /** Exact version tags retained because non-forced removal failed. */
    readonly retained: readonly string[];
};

/** The result of resolving and committing a published sandbox version. */
export type PullOutcome =
    | {
          readonly type: "up_to_date" | "pulled";
          readonly variant: SandboxVariant;
          readonly image: string;
          readonly cleanup: CleanupReport;
      }
    | { readonly type: "declined" };

/** A failure from one stage of the published-image transition. */
export type PullStageError =
    | { readonly type: "runtime_unavailable"; readonly message: string }
    | { readonly type: "no_variant"; readonly message: string }
    | { readonly type: "pull_failed"; readonly message: string }
    | { readonly type: "version_unavailable"; readonly message: string }
    | { readonly type: "tag_failed"; readonly message: string }
    | { readonly type: "verification_failed"; readonly message: string }
    | { readonly type: "config_write_failed"; readonly message: string; readonly cause?: unknown };

/** A stage failure or the stronger signal that restoring prior local aliases also failed. */
export type PullError = PullStageError | { readonly type: "rollback_failed"; readonly message: string; readonly original: PullStageError };

/**
 * Runtime and persistence seams for the published-image transaction. Production
 * uses the container/config implementations below; tests inject deterministic
 * Docker- and Podman-shaped command results without touching a daemon.
 */
export type PullRuntimeOps = {
    /** Execute and capture one runtime command. */
    readonly capture: (rt: ContainerRuntime, args: string[]) => Promise<CaptureResult>;
    /** Execute a progress-bearing runtime command with inherited stdio. */
    readonly inherit: (rt: ContainerRuntime, args: string[]) => Promise<number>;
    /** Read the currently configured execution reference. */
    readonly configuredImage: () => string;
    /** Persist a verified execution reference. */
    readonly configureImage: (image: string) => Result<void, PullStageError>;
    /** Resolve/cache package inventory for an already-present image. */
    readonly resolvePackages: (rt: ContainerRuntime, image: string) => Promise<string | null>;
};

/**
 * The configured sandbox image from the raw config's opaque `harness` block,
 * defaulting to the bootstrap channel. This module deliberately does not import
 * the harness config resolver, preserving the libs → harness dependency direction.
 */
export function configuredSandboxImage(): string {
    const harness = readConfig().harness;
    if (typeof harness === "object" && harness !== null) {
        // The harness block is deliberately opaque at the shared config layer; this
        // feature owns and defensively narrows the one field it writes.
        const img = (harness as Record<string, unknown>).sandboxImage;
        if (typeof img === "string" && img.trim() !== "") return img;
    }
    return DEFAULT_SANDBOX_IMAGE;
}

/** Persist the sandbox image while preserving every other opaque harness key. */
function configureSandboxImage(image: string): Result<void, PullStageError> {
    const cfg = readConfig();
    // The owning harness schema validates this opaque block later; preserving its
    // existing keys requires a shallow record view after the object guard.
    const harness = typeof cfg.harness === "object" && cfg.harness !== null ? (cfg.harness as Record<string, unknown>) : {};
    return writeConfig({ ...cfg, harness: { ...harness, sandboxImage: image } }).mapErr((e) => ({
        type: "config_write_failed",
        message: `Could not record the sandbox image in config.json: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`,
        cause: e.cause,
    }));
}

const realPullOps: PullRuntimeOps = {
    capture,
    inherit,
    configuredImage: configuredSandboxImage,
    configureImage: configureSandboxImage,
    resolvePackages: resolvePackagesFile,
};

/** Whether an image reference is moving (`latest` explicitly or implicitly). */
export function isMovingTag(image: string): boolean {
    if (image.includes("@")) return false;
    const lastSegment = image.slice(image.lastIndexOf("/") + 1);
    const colon = lastSegment.indexOf(":");
    const tag = colon === -1 ? "latest" : lastSegment.slice(colon + 1);
    return tag === "latest";
}

async function inspectImageId(rt: ContainerRuntime, image: string, ops: PullRuntimeOps): Promise<string | null> {
    const result = await ops.capture(rt, ["image", "inspect", "--format", "{{.Id}}", image]);
    return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
}

async function rollbackTransition(
    rt: ContainerRuntime,
    channel: string,
    priorChannelId: string | null,
    uncommittedImage: string | null,
    priorConfigured: string,
    original: PullStageError,
    ops: PullRuntimeOps,
): Promise<PullError> {
    const failures: string[] = [];

    if (uncommittedImage !== null && uncommittedImage !== priorConfigured) {
        const removed = await ops.capture(rt, ["image", "rm", uncommittedImage]);
        if (removed.code !== 0) failures.push(`could not remove uncommitted tag ${uncommittedImage}`);
    }

    if (priorChannelId !== null) {
        const restored = await ops.capture(rt, ["tag", priorChannelId, channel]);
        if (restored.code !== 0) failures.push(`could not restore ${channel} to ${priorChannelId}`);
    }

    if (failures.length === 0) return original;
    return {
        type: "rollback_failed",
        message: `${original.message}\n  Rollback was incomplete: ${failures.join("; ")}.`,
        original,
    };
}

async function cleanupSupersededVersions(
    rt: ContainerRuntime,
    variant: SandboxVariant,
    currentImage: string,
    legacyImageId: string | null,
    currentImageId: string,
    ops: PullRuntimeOps,
): Promise<CleanupReport> {
    const repository = variantRepository(variant);
    const listed = await ops.capture(rt, ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}", repository]);
    const candidates = [
        ...new Set(
            (listed.code === 0 ? listed.stdout : "")
                .split("\n")
                .map((line) => line.trim())
                .filter((ref) => {
                    const parsed = publishedVersionOfImage(ref);
                    return ref !== currentImage && parsed?.variant === variant;
                }),
        ),
    ];
    const removed: string[] = [];
    const retained: string[] = [];
    for (const image of candidates) {
        const result = await ops.capture(rt, ["image", "rm", image]);
        (result.code === 0 ? removed : retained).push(image);
    }
    // A legacy `latest` image has no version tag after the channel moves. Its
    // captured ID is still an exact target; non-forced removal preserves it when
    // a container or another tag retains a real dependency.
    if (legacyImageId !== null && legacyImageId !== currentImageId) {
        const result = await ops.capture(rt, ["image", "rm", legacyImageId]);
        (result.code === 0 ? removed : retained).push(legacyImageId);
    }
    return { removed, retained };
}

/**
 * Pull a variant's update channel and atomically commit its stamped version as
 * the execution reference. This is shared by the public command, setup, and the
 * required first-launch bootstrap path.
 */
export async function provisionPublishedVariant(
    rt: ContainerRuntime,
    variant: SandboxVariant,
    opts: Pick<PullOptions, "quiet"> = {},
    ops: PullRuntimeOps = realPullOps,
): Promise<Result<Exclude<PullOutcome, { type: "declined" }>, PullError>> {
    const channel = variantImage(variant);
    const priorConfigured = ops.configuredImage();
    const priorChannelId = priorConfigured === channel ? await inspectImageId(rt, channel, ops) : null;
    const channelWasPresent = (await inspectImageId(rt, channel, ops)) !== null;

    if (!opts.quiet) log.info(`${channelWasPresent ? "Refreshing" : "Pulling"} ${channel} …`);
    const pullCode = opts.quiet ? (await ops.capture(rt, ["pull", channel])).code : await ops.inherit(rt, ["pull", channel]);
    if (pullCode !== 0) {
        return err({
            type: "pull_failed",
            message: `\`${rt.bin} pull ${channel}\` exited ${pullCode}. Check your network and that GitHub Packages (ghcr.io) is reachable.`,
        });
    }

    const label = await ops.capture(rt, ["image", "inspect", "--format", `{{index .Config.Labels "${SANDBOX_VERSION_LABEL}"}}`, channel]);
    const version = label.code === 0 ? parseSandboxVersion(label.stdout.trim()) : null;
    if (version === null) {
        const failure: PullStageError = {
            type: "version_unavailable",
            message: `${channel} does not carry a valid ${SANDBOX_VERSION_LABEL} label.`,
        };
        return err(await rollbackTransition(rt, channel, priorChannelId, null, priorConfigured, failure, ops));
    }

    const pinnedImage = versionedVariantImage(variant, version);
    const tagged = await ops.capture(rt, ["tag", channel, pinnedImage]);
    if (tagged.code !== 0) {
        const failure: PullStageError = {
            type: "tag_failed",
            message: `Could not create the local sandbox version tag ${pinnedImage}.`,
        };
        return err(await rollbackTransition(rt, channel, priorChannelId, null, priorConfigured, failure, ops));
    }

    const [channelId, pinnedId] = await Promise.all([inspectImageId(rt, channel, ops), inspectImageId(rt, pinnedImage, ops)]);
    if (channelId === null || pinnedId === null || channelId !== pinnedId) {
        const failure: PullStageError = {
            type: "verification_failed",
            message: `The local tag ${pinnedImage} does not resolve to the pulled channel image.`,
        };
        return err(await rollbackTransition(rt, channel, priorChannelId, pinnedImage, priorConfigured, failure, ops));
    }

    if ((await ops.resolvePackages(rt, pinnedImage)) === null && !opts.quiet) {
        log.warn(`${pinnedImage} carries no package inventory — agents will be told the installed set is unknown.`);
    }

    const configured = ops.configureImage(pinnedImage);
    if (configured.isErr()) {
        return err(await rollbackTransition(rt, channel, priorChannelId, pinnedImage, priorConfigured, configured.error, ops));
    }

    const cleanup = await cleanupSupersededVersions(rt, variant, pinnedImage, priorChannelId, pinnedId, ops);
    if (cleanup.retained.length > 0 && !opts.quiet) {
        log.info(`Retained sandbox version(s) still in use: ${cleanup.retained.join(", ")}`);
    }
    return ok({
        type: priorConfigured === pinnedImage ? "up_to_date" : "pulled",
        variant,
        image: pinnedImage,
        cleanup,
    });
}

/** Resolve a variant choice, confirm a first download, then provision its published version. */
export async function sandboxPull(opts: PullOptions = {}): Promise<Result<PullOutcome, PullError>> {
    const interactive = !opts.quiet && process.stdin.isTTY;
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });
    const rt = rtResult.value;

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

    const channel = variantImage(variant);
    const present = (await inspectImageId(rt, channel, realPullOps)) !== null;
    if (!present && interactive && !opts.yes) {
        const proceed = await confirm(`Pull the ${variant} sandbox image (${channel})? This may be a multi-GB download.`);
        if (!proceed) return ok({ type: "declined" });
    }
    return provisionPublishedVariant(rt, variant, { quiet: opts.quiet });
}

/** `inflexa sandbox status` — configured identity, local presence, and image ID. */
export async function sandboxStatus(): Promise<void> {
    const image = configuredSandboxImage();
    const variant = variantOfImage(image);
    const published = publishedVersionOfImage(image);

    console.log(`  Image    ${image}`);
    console.log(`  Variant  ${variant ?? "(custom — not a published sandbox-python/-r image)"}`);
    console.log(`  Version  ${published?.version ?? (variant !== null && isMovingTag(image) ? "(unpinned channel)" : "(custom)")}`);

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

    const inspect = await capture(rt, ["image", "inspect", "--format", "{{.Id}}", image]);
    if (inspect.code === 0) {
        console.log("  Present  yes");
        console.log(`  Digest   ${inspect.stdout.trim()}`);
    } else {
        console.log("  Present  no");
        console.log(`  Run \`inflexa sandbox pull${variant ? ` ${variant}` : ""}\` to download it.`);
    }
}
