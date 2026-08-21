/**
 * The sandbox images at the command surface: `inflexa sandbox pull`, `inflexa
 * sandbox status`, `inflexa sandbox remove`, and the pre-flight gate of the dev
 * commands.
 *
 * NO foreground image pull exists anywhere. `sandbox pull` starts the two
 * detached image transfers — the runtime image and the provisioner image — and
 * returns at once with the status pointer. A moving `:latest` refreshes through
 * the same transfers, thus the command doubles as the upgrade path. The
 * transfer children live in `modules/libs/transfers.ts`.
 *
 * The pre-flight of a dev-channel command REFUSES an absent image with the
 * pull hint, and it starts nothing: the transfer lifecycle is the one download
 * mechanism, and a gate that downloaded would hide a multi-GB transfer behind
 * a command that promised something else.
 */

import { err, ok, type Result } from "neverthrow";

import { fail } from "../../lib/cli.ts";
import { ensureRuntime, readConfig, selectedRuntime } from "../../lib/config.ts";
import { capture, firstReadyRuntime, runtimeIds, runtimes, type ContainerRuntime } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { isPublishedSandboxImage, provisionerImageFor, SANDBOX_IMAGE } from "./images.ts";
import { inspectStoreContent } from "./store_download.ts";
import { readTransferReports, startImageTransfer, type TransferReport } from "./transfers.ts";

/**
 * The configured sandbox image from the raw config's opaque `harness` block,
 * defaulting to {@link SANDBOX_IMAGE}. Reads the raw config (not
 * `resolveHarnessConfig`) so this module does not import modules/harness —
 * keeping the dependency one-directional (harness config → this module for the
 * default).
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

/** Whether `rt` already has `image` locally. */
async function imagePresent(rt: ContainerRuntime, image: string): Promise<boolean> {
    try {
        return (await capture(rt, ["image", "inspect", image])).code === 0;
    } catch {
        return false;
    }
}

/** An image the engine does not hold, with the one message that names the remedy. */
export type ImageAbsentError = { readonly type: "image_absent"; readonly image: string; readonly message: string };

/**
 * Whether the engine holds `image`, as a Result the store and check runs gate
 * on. An absent PUBLISHED image names `inflexa sandbox pull` as the remedy. An
 * absent CUSTOM image cannot be pulled, so the message names the build instead.
 * Nothing here pulls: the transfer lifecycle is the one download mechanism.
 */
export async function ensureImagePresent(rt: ContainerRuntime, image: string): Promise<Result<void, ImageAbsentError>> {
    if (await imagePresent(rt, image)) return ok(undefined);
    if (isPublishedSandboxImage(image) || image === provisionerImageFor(configuredSandboxImage())) {
        return err({
            type: "image_absent",
            image,
            message: `The image "${image}" is not installed. Run \`inflexa sandbox pull\` to download it, and \`inflexa sandbox status\` to watch it.`,
        });
    }
    return err({
        type: "image_absent",
        image,
        message: `The image "${image}" is not installed, and it is not a published image, thus no registry can supply it. Build it locally, or set \`harness.sandboxImage\` to a published \`ghcr.io/inflexa-ai/sandbox-base\` tag.`,
    });
}

/**
 * Pre-flight gate of the dev-channel commands: the configured sandbox image
 * must be present before a command stages anything, because after staging it is
 * too late to find out. The gate REFUSES an absent image with the pull hint and
 * starts no transfer.
 *
 * This is the one function here that exits the process through `fail` instead
 * of giving a `Result`. Every caller is a CLI entry point at a pre-flight gate
 * with nothing to recover to: with no sandbox image the command cannot run at
 * all, so a `Result` would buy each caller one `match` that ends in this same
 * exit.
 */
export async function ensureSandboxImage(image: string): Promise<void> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) fail(rtResult.error.message);
    const present = await ensureImagePresent(rtResult.value, image);
    if (present.isErr()) fail(present.error.message);
}

/** `inflexa sandbox pull` — start the two detached image transfers and return at once. */
export async function sandboxPull(): Promise<void> {
    const kinds = ["runtime_image", "provisioner_image"] as const;
    for (const kind of kinds) {
        const label = kind === "runtime_image" ? "runtime image" : "provisioner image";
        startImageTransfer(kind).match(
            (start) => {
                if (start.type === "started") console.log(`The ${label} transfer runs in the background (pid ${start.pid}).`);
                else console.log(`A ${label} transfer is already running (pid ${start.report.holderPid ?? "unknown"}).`);
            },
            (error) => {
                console.error(`  ${error.message}`);
                process.exitCode = 1;
            },
        );
    }
    console.log("Run `inflexa sandbox status` to watch the transfers.");
}

/**
 * `inflexa sandbox remove` — remove the two images from the engine, and touch
 * no store and no farm. The agent policy of the command is `blocked`, because
 * an agent must not delete multi-GB assets of the user.
 */
export async function sandboxRemove(): Promise<void> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) fail(rtResult.error.message);
    const rt = rtResult.value;
    const sandboxImage = configuredSandboxImage();
    for (const image of [sandboxImage, provisionerImageFor(sandboxImage)]) {
        if (!(await imagePresent(rt, image))) {
            console.log(`  ${image} is not installed. Nothing to remove.`);
            continue;
        }
        const removed = await capture(rt, ["rmi", image]).catch(() => ({ code: 1, stdout: "", stderr: "spawn failed" }));
        if (removed.code === 0) console.log(`  Removed ${image}.`);
        else {
            console.error(`  Could not remove ${image} (\`${rt.bin} rmi\` exited ${removed.code}). A container can still use it.`);
            process.exitCode = 1;
        }
    }
    console.log("The package store is untouched. Run `inflexa sandbox pull` to download the images again.");
}

/** One line of the transfer block of the status, or `null` for a kind with nothing to report. */
function describeTransferLine(report: TransferReport): string | null {
    const label = report.kind === "runtime_image" ? "runtime image" : report.kind === "provisioner_image" ? "provisioner image" : "catalog";
    switch (report.state) {
        case null:
            return null;
        case "pending":
            return `  Transfer ${label}: starting`;
        case "running": {
            const row = report.row;
            const meter = row !== null && row.totalBytes !== null ? ` — ${formatBytes(row.bytesTransferred)} of ${formatBytes(row.totalBytes)}` : "";
            return `  Transfer ${label}: running${meter}`;
        }
        case "installed":
            return report.row?.message === null || report.row?.message === undefined ? null : `  Transfer ${label}: ${report.row.message}`;
        case "failed":
            return `  Transfer ${label}: failed${report.row?.message ? ` — ${report.row.message}` : ""}`;
        case "declined":
            return `  Transfer ${label}: declined — run \`inflexa ${report.kind === "catalog" ? "store download" : "sandbox pull"}\` to start it`;
        case "canceled":
            return `  Transfer ${label}: canceled — run \`inflexa ${report.kind === "catalog" ? "store download" : "sandbox pull"}\` to start again`;
        default: {
            const unreachable: never = report.state;
            throw new Error(`unhandled transfer state: ${JSON.stringify(unreachable)}`);
        }
    }
}

/** Render a byte count in the largest unit that keeps it readable. */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * `inflexa sandbox status` — the two images (the reference, the presence, the
 * local digest of each), the live transfer states, and the store summary.
 */
export async function sandboxStatus(): Promise<void> {
    const sandboxImage = configuredSandboxImage();
    const provisionerImage = provisionerImageFor(sandboxImage);

    // Status is a read-only diagnostic: use the selected runtime, or detect a ready
    // one WITHOUT pinning it — a passive inspection must not write config (that is
    // ensureRuntime's job, reserved for commands that create runtime-bound state).
    const rt =
        selectedRuntime() ??
        (await firstReadyRuntime(runtimeIds.map((id) => runtimes[id]))).match(
            (detected) => detected,
            () => null,
        );

    for (const [label, image] of [
        ["Runtime", sandboxImage],
        ["Provisioner", provisionerImage],
    ] as const) {
        console.log(`  ${label}  ${image}`);
        if (rt === null) {
            console.log("    Present  unknown — no container runtime available (start Docker or Podman)");
            continue;
        }
        const inspect = await capture(rt, ["image", "inspect", "--format", "{{.Id}}", image]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
        if (inspect.code === 0) {
            console.log("    Present  yes");
            console.log(`    Digest   ${inspect.stdout.trim()}`);
        } else {
            console.log("    Present  no — run `inflexa sandbox pull` to download it");
        }
    }

    for (const report of readTransferReports()) {
        const line = describeTransferLine(report);
        if (line !== null) console.log(line);
    }

    const content = await inspectStoreContent(env.packageStoreDir);
    console.log(`  Store    ${env.packageStoreDir}`);
    console.log(`    State  ${content}${content === "missing" ? " — run `inflexa store download` to obtain the catalog" : ""}`);
}
