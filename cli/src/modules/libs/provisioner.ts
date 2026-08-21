/**
 * The two container seams of the store: the provisioner run, and the load check.
 *
 * The provisioner container is the one container with network access and a
 * compiler. It starts ONLY for an operation that installs packages or mutates
 * the pool under the store lock: an acquire, a reclaim. Its egress is an
 * allowlist, never open — the entrypoint of the image installs the rules from
 * `INFLEXA_EGRESS_ALLOW`, and this module NEVER launches an acquire with the
 * variable unset, because an unset variable gives open egress.
 *
 * The load check runs inside the SANDBOX image, never the provisioner: the
 * check proves the image that runs the code, not the image that built it. It
 * mounts the store read-only, it has no network, and it reads the acquire
 * report from the store metadata directory.
 *
 * Both seams are injectable, so a test exercises the argument building and the
 * exit-code classification without a real engine.
 */

import { err, ok, type Result } from "neverthrow";

import { ensureRuntime } from "../../lib/config.ts";
import { stream, type CaptureResult } from "../../lib/container.ts";
import { provisionerImageFor } from "./images.ts";
import { configuredSandboxImage, ensureImagePresent } from "./pull.ts";

/** The path the store is mounted at in the provisioner (read-write) and in the sandbox (read-only). */
export const LIB_MOUNT = "/mnt/libs";

/**
 * The egress classes of an acquisition: the pinned Python index with its file
 * host, and the pak repositories (the P3M snapshot, CRAN, and Bioconductor).
 * The GitHub hosts and `git.bioconductor.org` belong to the catalog build
 * alone — the `github` and `git` tracks are catalog-only, thus an acquisition
 * never reaches them.
 */
export const ACQUIRE_EGRESS_ALLOW = "pypi.org,files.pythonhosted.org,packagemanager.posit.co,cran.r-project.org,bioconductor.org";

/**
 * The message the provisioner prints when a second run finds the store lock
 * held exclusively. Matched so the CLI turns a normal condition — two
 * terminals — into an actionable message instead of a bare non-zero exit.
 */
const STORE_LOCK_PATTERN = /holds the store lock/;

/** Why a provisioner run could not complete. Each variant maps to one actionable user message. */
export type ProvisionerError =
    | { readonly type: "runtime_unavailable"; readonly message: string }
    | { readonly type: "image_unavailable"; readonly message: string }
    | { readonly type: "store_locked"; readonly message: string }
    | { readonly type: "provisioner_failed"; readonly code: number; readonly message: string };

/** What one provisioner container run is asked to do. */
export type ProvisionerInvocation = {
    /** The store root on the host, mounted read-write at {@link LIB_MOUNT}. */
    readonly storeRoot: string;
    /**
     * The egress allowlist of the run, or `null` for a run that touches only
     * local disk (reclaim, remove-farm), which then runs with NO network at all.
     * An online run always carries a list — the type makes an unset-variable
     * launch unrepresentable.
     */
    readonly egressAllow: string | null;
    /** The arguments of the provisioner program (for example `acquire --report ... <specs>`). */
    readonly args: readonly string[];
};

/**
 * How a provisioner container is started. The default resolves and pins a
 * container runtime, then streams the provisioner through `lib/container.ts`.
 */
export type ProvisionerRunner = (
    invocation: ProvisionerInvocation,
    onLine: (line: string) => void,
    signal?: AbortSignal,
) => Promise<Result<CaptureResult, ProvisionerError>>;

/** The default runner: resolve and pin a container runtime, then stream the provisioner. */
export const runProvisioner: ProvisionerRunner = async (invocation, onLine, signal) => {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });
    const rt = rtResult.value;
    const image = provisionerImageFor(configuredSandboxImage());
    const present = await ensureImagePresent(rt, image);
    if (present.isErr()) return err({ type: "image_unavailable", message: present.error.message });
    // The store mounts read-write here — the sandbox mounts the same root read-only — because the
    // provisioner writes packages into it. An online run carries the egress allowlist and the
    // NET_ADMIN capability for the rule install; an offline run carries no network at all.
    const args = [
        "run",
        "--rm",
        ...(invocation.egressAllow === null ? ["--network", "none"] : ["--cap-add", "NET_ADMIN", "-e", `INFLEXA_EGRESS_ALLOW=${invocation.egressAllow}`]),
        "-v",
        rt.mountArg(invocation.storeRoot, LIB_MOUNT),
        image,
        ...invocation.args,
    ];
    try {
        return ok(await stream(rt, args, onLine, signal));
    } catch (cause) {
        // The runtime was ready a moment ago, so a spawn failure now means it became unavailable.
        return err({
            type: "runtime_unavailable",
            message: `Could not start the provisioner with ${rt.label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
    }
};

/** Turn a completed container run into a Result, mapping a store-lock conflict to its own actionable error. */
export function classifyProvisionerRun(res: CaptureResult): Result<void, ProvisionerError> {
    if (res.code === 0) return ok(undefined);
    const combined = `${res.stdout}\n${res.stderr}`;
    if (res.code === 1 && STORE_LOCK_PATTERN.test(combined)) {
        return err({
            type: "store_locked",
            message: "Another provisioning run holds the package-store lock. Wait for it to finish, then run this command again.",
        });
    }
    return err({ type: "provisioner_failed", code: res.code, message: `The provisioner exited with code ${res.code}.\n${outputTail(combined)}` });
}

/** The last few non-empty lines of the provisioner output, for a failure message that names the real cause. */
function outputTail(text: string): string {
    const lines = text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line !== "");
    return lines.slice(-8).join("\n");
}

/** The baked path of the load check inside the runtime image. The image owns the check that proves it. */
const LOAD_CHECK_PATH = "/opt/inflexa/load-check.py";

/**
 * How the load check of an acquire report is run. The default starts the
 * SANDBOX image with the store mounted read-only and no network, and it runs
 * the baked check against the staged nodes of the report.
 */
export type LoadCheckRunner = (params: {
    readonly storeRoot: string;
    /** The path of the acquire report, relative to the store root. */
    readonly reportName: string;
}) => Promise<Result<CaptureResult, ProvisionerError>>;

/** The default load-check runner. */
export const runLoadCheck: LoadCheckRunner = async (params) => {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });
    const rt = rtResult.value;
    const image = configuredSandboxImage();
    const present = await ensureImagePresent(rt, image);
    if (present.isErr()) return err({ type: "image_unavailable", message: present.error.message });
    const args = [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        rt.mountArgRo(params.storeRoot, LIB_MOUNT),
        "--entrypoint",
        "/usr/bin/python3",
        image,
        LOAD_CHECK_PATH,
        "--nodes",
        `${LIB_MOUNT}/${params.reportName}`,
    ];
    try {
        return ok(await stream(rt, args, () => undefined));
    } catch (cause) {
        return err({
            type: "runtime_unavailable",
            message: `Could not start the load check with ${rt.label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
    }
};
