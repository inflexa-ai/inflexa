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
import { stream, type CaptureResult, type ContainerRuntime } from "../../lib/container.ts";
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
 *
 * p3m.dev is the pinned snapshot host that the R resolve of the image reads,
 * and rspm-sync.rstudio.com is the redirect target of its binary GET on a
 * cache miss. Without the pair, an R acquisition blocks at the wall.
 */
export const ACQUIRE_EGRESS_ALLOW = "pypi.org,files.pythonhosted.org,packagemanager.posit.co,p3m.dev,rspm-sync.rstudio.com,cran.r-project.org,bioconductor.org";

/**
 * The egress class of a source build: the hosts the approved plan names, plus
 * the fixed hosts of the class, which the plan cannot widen or drop because the
 * session needs them by construction — the dated Ubuntu snapshot host the apt
 * pin writes to, and the acquisition classes' index and pak entries, which the
 * dependency resolve of the clean run reads. A session never gains a host of
 * the acquisition classes beyond these entries, and an `acquire` run never
 * gains a host of this class.
 */
export const APT_SNAPSHOT_HOST = "snapshot.ubuntu.com";

/** The fixed hosts of the source-build class, in the order the ask shows them. */
export const SESSION_CLASS_HOSTS: readonly string[] = [...new Set([APT_SNAPSHOT_HOST, ...ACQUIRE_EGRESS_ALLOW.split(",")])];

export function sessionEgressAllow(planHosts: readonly string[]): string {
    const hosts = [...planHosts, ...SESSION_CLASS_HOSTS].map((host) => host.trim()).filter((host) => host !== "");
    return [...new Set(hosts)].join(",");
}

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

// --- The source-build run -------------------------------------------------------

/** The pristine source snapshot of a clean run, mounted read-only at a fixed container path. */
export const SOURCE_SNAPSHOT_MOUNT = "/work/src";

/** The approved build script of a clean run, mounted read-only at a fixed container path. */
export const SOURCE_SCRIPT_MOUNT = "/work/build.sh";

/** The output directory the script contract names: exactly one root artifact, and nothing else. */
const BUILD_OUT = "/work/out";

/** What one clean source-build run needs, beside the store it writes into. */
export type SourceBuildRun = {
    readonly storeRoot: string;
    /** The approved session egress list, exactly as the user approved it. */
    readonly egressAllow: string;
    /** The host paths of the pristine snapshot and the approved script. Both mount read-only: the snapshot must stay pristine for a corrected second commit, and the script is the approved bytes. */
    readonly snapshotHost: string;
    readonly scriptHost: string;
    /** The report path, relative to the store root. */
    readonly reportName: string;
    /** The resolved git source, or `null` for a folder source whose hash covers the snapshot. */
    readonly git: { readonly url: string; readonly commit: string } | null;
    readonly aptSnapshotDate: string;
    readonly aptPackages: readonly string[];
    /** The digests the build record copies. A process inside the container cannot read its own image digest, thus the launch names both. */
    readonly imageDigests: { readonly provisioner: string; readonly base: string };
};

/** How one clean source-build run is started. The default resolves the runtime and streams the run, exactly as {@link runProvisioner} does. */
export type SourceBuildRunner = (run: SourceBuildRun, onLine: (line: string) => void, signal?: AbortSignal) => Promise<Result<CaptureResult, ProvisionerError>>;

/** The container arguments of one clean source-build run. Exported so a test pins the launch shape without an engine. */
export function acquireSourceArgs(rt: ContainerRuntime, image: string, run: SourceBuildRun): string[] {
    return [
        "run",
        "--rm",
        "--cap-add",
        "NET_ADMIN",
        "-e",
        `INFLEXA_EGRESS_ALLOW=${run.egressAllow}`,
        "-e",
        `INFLEXA_PROVISIONER_DIGEST=${run.imageDigests.provisioner}`,
        "-e",
        `INFLEXA_BASE_IMAGE_DIGEST=${run.imageDigests.base}`,
        "-v",
        rt.mountArg(run.storeRoot, LIB_MOUNT),
        "-v",
        rt.mountArgRo(run.snapshotHost, SOURCE_SNAPSHOT_MOUNT),
        "-v",
        rt.mountArgRo(run.scriptHost, SOURCE_SCRIPT_MOUNT),
        image,
        "acquire-source",
        "--report",
        `${LIB_MOUNT}/${run.reportName}`,
        "--snapshot",
        SOURCE_SNAPSHOT_MOUNT,
        "--script",
        SOURCE_SCRIPT_MOUNT,
        "--output",
        BUILD_OUT,
        ...(run.git === null ? [] : ["--git-url", run.git.url, "--commit", run.git.commit]),
        "--apt-snapshot-date",
        run.aptSnapshotDate,
        ...run.aptPackages.flatMap((name) => ["--apt-package", name]),
    ];
}

/** The default clean-run runner: one one-shot provisioner container over the pristine snapshot. */
export const runSourceBuild: SourceBuildRunner = async (run, onLine, signal) => {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });
    const rt = rtResult.value;
    const image = provisionerImageFor(configuredSandboxImage());
    const present = await ensureImagePresent(rt, image);
    if (present.isErr()) return err({ type: "image_unavailable", message: present.error.message });
    try {
        return ok(await stream(rt, acquireSourceArgs(rt, image, run), onLine, signal));
    } catch (cause) {
        return err({
            type: "runtime_unavailable",
            message: `Could not start the source build with ${rt.label}: ${cause instanceof Error ? cause.message : String(cause)}`,
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
