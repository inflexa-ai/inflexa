/**
 * The `inflexa sandbox` command actions — pull, status, remove — plus the config
 * write that records the pulled image. `sandboxPull` is the ONE dogfooded provisioning
 * path: the `sandbox pull` command and the `inflexa setup` wizard both funnel
 * through it. There is no second image-fetch path.
 *
 * The model: one runtime image is published, so the command takes no argument and
 * asks no question. The CLI `docker pull`s `ghcr.io/inflexa-ai/sandbox-base` and
 * records it as `harness.sandboxImage`, and no arch is forced (a multi-arch
 * manifest resolves the host architecture automatically). That image bakes no R
 * library and no Python library, so the packages come from the host package store
 * the harness mounts at `/mnt/libs`.
 *
 * The provisioner image rides the same path ({@link provisionerPull}), because
 * both images are prerequisites of a working store. The pre-flight
 * `ensureSandboxImage` (modules/harness/profile.ts) pulls the runtime image on
 * launch when it is absent, and {@link ensureProvisionerImage} does the same for
 * the provisioner at the first store command that starts it.
 */

import { log } from "@clack/prompts";
import { err, ok, type Result } from "neverthrow";

import { confirm } from "../../lib/cli.ts";
import { ensureRuntime, readConfig, selectedRuntime, writeConfig } from "../../lib/config.ts";
import { capture, firstReadyRuntime, inherit, runtimeIds, runtimes, type ContainerRuntime } from "../../lib/container.ts";
import { PROVISIONER_IMAGE, SANDBOX_IMAGE } from "./images.ts";

/** Flags accepted by `inflexa sandbox pull` (and reused by setup). */
export type PullOptions = {
    /** Skip the pull-size confirmation (also implied non-interactively). */
    readonly yes?: boolean;
    /** Suppress the streamed pull progress — used when a caller owns its own spinner. */
    readonly quiet?: boolean;
};

/** The result of a pull, for the caller to report. */
export type PullOutcome =
    { readonly type: "up_to_date"; readonly image: string } | { readonly type: "pulled"; readonly image: string } | { readonly type: "declined" };

/**
 * A pull failed. Each variant names one stage (runtime readiness → docker pull →
 * config write); the message is user-facing and the optional `cause` carries the
 * underlying throw for logs.
 */
export type PullError =
    | { readonly type: "runtime_unavailable"; readonly message: string }
    | { readonly type: "pull_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "config_write_failed"; readonly message: string; readonly cause?: unknown };

/**
 * The configured sandbox image from the raw config's opaque `harness` block,
 * defaulting to {@link SANDBOX_IMAGE}. Reads the raw config (not
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
    return SANDBOX_IMAGE;
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
 * `docker pull` one published multi-arch image, asking the size confirmation on
 * the first (absent) transfer only.
 *
 * Because a published reference is a moving `:latest` ref, a pull always refreshes
 * to the current remote digest — even when the image is present locally — so this
 * doubles as the image-upgrade path. A present image transfers only the changed
 * layers, so it runs without the prompt. An immutable pinned ref that is already
 * present short-circuits to `up_to_date` with nothing on the wire.
 *
 * `label` names the image in the consent line, because a user who is asked for a
 * multi-gigabyte download must know which of the two images it is.
 */
async function pullPublishedImage(rt: ContainerRuntime, image: string, label: string, opts: PullOptions): Promise<Result<PullOutcome, PullError>> {
    const interactive = !opts.quiet && process.stdin.isTTY;
    const present = await imagePresent(rt, image);

    if (present && !isMovingTag(image)) return ok({ type: "up_to_date", image });

    if (!present && interactive && !opts.yes) {
        const proceed = await confirm(`Pull the ${label} (${image})? This may be a multi-GB download.`);
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
    return ok({ type: "pulled", image });
}

/**
 * Provision the sandbox image: `docker pull` the one published multi-arch runtime
 * image from GHCR, and record it as `harness.sandboxImage`. A declined pull writes
 * no config, so the configured image keeps its prior value.
 */
export async function sandboxPull(opts: PullOptions = {}): Promise<Result<PullOutcome, PullError>> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });

    const outcome = await pullPublishedImage(rtResult.value, SANDBOX_IMAGE, "sandbox image", opts);
    if (outcome.isErr() || outcome.value.type === "declined") return outcome;
    const configured = configureSandboxImage(SANDBOX_IMAGE);
    if (configured.isErr()) return err(configured.error);
    return outcome;
}

/**
 * Provision the provisioner image the store-management commands run. It writes no
 * config, because no configuration value names it — the reference is the
 * {@link PROVISIONER_IMAGE} constant.
 */
export async function provisionerPull(opts: PullOptions = {}): Promise<Result<PullOutcome, PullError>> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });
    return pullPublishedImage(rtResult.value, PROVISIONER_IMAGE, "package provisioner image", opts);
}

/**
 * Obtain the provisioner image when the machine does not hold it, for a store
 * command that is about to start the container.
 *
 * This pulls only on ABSENCE, where {@link provisionerPull} also refreshes a
 * present moving tag. A store command is not an image-upgrade path: the user asked
 * to change the store, and a multi-gigabyte refresh in front of every `store add`
 * would be a cost they did not ask for. It asks nothing, because the store command
 * is itself the consent and it is already approval-gated.
 */
export async function ensureProvisionerImage(rt: ContainerRuntime): Promise<Result<void, PullError>> {
    if (await imagePresent(rt, PROVISIONER_IMAGE)) return ok(undefined);
    log.info(`Pulling the package provisioner image ${PROVISIONER_IMAGE} …`);
    const code = await inherit(rt, ["pull", PROVISIONER_IMAGE]);
    return code === 0
        ? ok(undefined)
        : err({
              type: "pull_failed",
              message: `\`${rt.bin} pull ${PROVISIONER_IMAGE}\` exited ${code}. Check your network and that GitHub Packages (ghcr.io) is reachable.`,
          });
}

// --- status ------------------------------------------------------------------

/** Print one image's local presence and digest under `rt`, or the command that obtains it. */
async function reportImage(rt: ContainerRuntime, label: string, image: string, remedy: string): Promise<void> {
    // `--format {{.Id}}` prints the local image digest; a non-zero exit means absent.
    const inspect = await capture(rt, ["image", "inspect", "--format", "{{.Id}}", image]);
    console.log(`  ${label}`);
    console.log(`    Image    ${image}`);
    if (inspect.code === 0) {
        console.log(`    Present  yes`);
        console.log(`    Digest   ${inspect.stdout.trim()}`);
    } else {
        console.log(`    Present  no`);
        console.log(`    Run \`${remedy}\` to download it.`);
    }
}

// --- removal -----------------------------------------------------------------

/** What the removal did to one image. `absent` is a normal condition, never a refusal. */
export type ImageRemoval = { readonly image: string; readonly outcome: "removed" | "absent" | "failed"; readonly detail?: string };

/**
 * Remove one image, reporting an absent one rather than refusing it. `image rm` exits non-zero for a
 * reference the engine does not hold, and the presence probe separates that normal case from a real
 * fault, for example an image a running container still holds.
 */
async function removeImage(rt: ContainerRuntime, image: string): Promise<ImageRemoval> {
    if (!(await imagePresent(rt, image))) return { image, outcome: "absent" };
    const result = await capture(rt, ["image", "rm", image]);
    if (result.code === 0) return { image, outcome: "removed" };
    const detail = result.stderr.trim() === "" ? result.stdout.trim() : result.stderr.trim();
    return { image, outcome: "failed", ...(detail === "" ? {} : { detail }) };
}

/**
 * `inflexa sandbox remove` — remove the two pulled images, and report what it removed.
 *
 * It touches NO store and NO farm. The two images and the package catalog are separate artifacts, and
 * the `inflexa store` family owns the catalog surface. A later `inflexa sandbox pull` obtains the runtime
 * image again, thus the removal is complete rather than partial.
 *
 * An absent image refuses nothing. The command reports the absence and continues with the image that is
 * on the machine.
 */
export async function sandboxRemove(): Promise<Result<readonly ImageRemoval[], PullError>> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });
    const rt = rtResult.value;
    // The CONFIGURED runtime image, which is the reference every sandbox starts from and the one a pull
    // put on the machine. The provisioner has no configuration value and rides its constant.
    return ok([await removeImage(rt, configuredSandboxImage()), await removeImage(rt, PROVISIONER_IMAGE)]);
}

/** `inflexa sandbox remove` — the command action: remove the two images and name what happened to each. */
export async function runSandboxRemove(): Promise<void> {
    const result = await sandboxRemove();
    result.match(
        (removals) => {
            for (const removal of removals) {
                if (removal.outcome === "removed") console.log(`  Removed  ${removal.image}`);
                else if (removal.outcome === "absent") console.log(`  Absent   ${removal.image} — nothing to remove`);
                else console.log(`  Kept     ${removal.image} — the engine refused the removal: ${removal.detail ?? "no detail"}`);
            }
            console.log("\n  The package store and its farms are unchanged. Run `inflexa sandbox pull` to obtain the runtime image again.\n");
        },
        (error) => {
            console.error(`\n  Sandbox image removal failed: ${error.message}\n`);
            process.exitCode = 1;
        },
    );
}

/**
 * `inflexa sandbox status` — the GHCR reference, the local presence, and the local
 * digest of both images. The provisioner rides along because a store the sandbox
 * can mount needs both: the runtime image runs the analysis, and the provisioner
 * is what extends the store it mounts.
 */
export async function sandboxStatus(): Promise<void> {
    const image = configuredSandboxImage();

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
        console.log(`  Sandbox image      ${image}`);
        console.log(`  Provisioner image  ${PROVISIONER_IMAGE}`);
        console.log("  Present  unknown — no container runtime available (start Docker or Podman)");
        return;
    }

    await reportImage(rt, "Sandbox", image, "inflexa sandbox pull");
    await reportImage(rt, "Provisioner", PROVISIONER_IMAGE, "inflexa setup");
}
