/**
 * The real exec of a sandbox trial: each command runs in a container of the production sandbox image, over the
 * production mounts and environment, with no network.
 *
 * The container is the image of the CLI, the mounts and the environment are `buildMountPlan` of the harness, and the
 * farm is a farm of the package store that the CLI composes and extends. Only the transport differs: `docker exec`
 * in place of sandbox-server, thus a trial needs no lease registry and no port. Each trial gets its own container and
 * its own farm, and both go away when the trial ends.
 */

// The farm composition of the CLI calls the global extensions of the CLI (`JSON.parseWith`), which the CLI installs at its entry point.
import "../../cli/src/extensions/index.ts";

import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ResultAsync } from "neverthrow";

import { buildMountPlan } from "@inflexa-ai/harness/sandbox/mount-plan.js";
import type { ExecRequest, ExecResult, ExtendAnalysisFarm } from "@inflexa-ai/harness/sandbox/types.js";
import { capExecStreams } from "@inflexa-ai/harness/tools/workspace/result-bounds.js";

import { catalogFarmPath, linkPackagesIntoFarm, removeAnalysisFarm, resolveAnalysisFarm } from "../../cli/src/modules/libs/composition.ts";

/** The image of a real trial. A pinned tag, thus two runs of one commit see the same toolchain. */
export const SANDBOX_IMAGE = process.env["EVALS_SANDBOX_IMAGE"] ?? "ghcr.io/inflexa-ai/sandbox-base:20261029-c94d23e";
export const PACKAGE_STORE = process.env["EVALS_PACKAGE_STORE"] ?? join(homedir(), ".local", "share", "inflexa", "package-store");

const FIXTURES_DIR = join(import.meta.dir, "..", "..", "tmp", "evals", "fixtures");

/** The unprivileged user of the image, as sandbox-server runs each command. */
const SANDBOX_USER = "1000:1000";
const DEFAULT_TIMEOUT_SECONDS = 600;

export type RealSandboxPaths = {
    readonly analysisId: string;
    readonly runId: string;
    readonly stepId: string;
    /** The host directory of the analysis tree, mounted read-only. */
    readonly treeRoot: string;
    /** The host directory of the working directory, mounted read-write at `workingDir`. */
    readonly hostWorkingDir: string;
    /** The in-sandbox working directory. */
    readonly workingDir: string;
    /** The host directory of the reference store of the trial. */
    readonly refsRoot: string;
    readonly cpu: number;
    readonly memoryGb: number;
};

export type RealSandbox = {
    readonly farmLockFile: string;
    readonly imagePackagesFile: string;
    readonly extendAnalysisFarm: ExtendAnalysisFarm;
    exec(request: ExecRequest): Promise<ExecResult>;
    dispose(): Promise<void>;
};

async function docker(args: readonly string[], timeoutMs?: number): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (timer !== undefined) clearTimeout(timer);
    return { exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut };
}

/** The farm of a trial, a full farm of the store under an id of its own, and the container that mounts it. */
export async function openRealSandbox(paths: RealSandboxPaths): Promise<RealSandbox> {
    const farmId = `eval-${randomUUID()}`;
    const resolution = await resolveAnalysisFarm(PACKAGE_STORE, farmId);
    if (resolution.kind === "unavailable") throw new Error(`the eval farm is unavailable: ${resolution.reason}`);
    const { farmPath, cachePath } = resolution.location;
    if (cachePath !== undefined) mkdirSync(cachePath, { recursive: true });

    const plan = buildMountPlan(
        { analysisId: paths.analysisId, runId: paths.runId, stepId: paths.stepId, recordTail: "exec-records" },
        { libs: true, refs: true, toolchainSource: "image", cache: cachePath !== undefined },
    );
    const env: Record<string, string> = { ...plan.env, HOME: "/tmp" };
    // The host makes the subdirectories of the step before the sandbox starts, as `precreateStepTree` of the harness.
    for (const sub of plan.stepSubdirs) mkdirSync(join(paths.hostWorkingDir, sub), { recursive: true });
    const name = `inflexa-eval-${farmId.slice(5, 17)}`;
    let started: Promise<void> | undefined;
    const start = (): Promise<void> => {
        started ??= (async () => {
            const binds = [
                `${paths.treeRoot}:/${paths.analysisId}:ro`,
                `${paths.hostWorkingDir}:${paths.workingDir}:rw`,
                `${paths.refsRoot}:${plan.refsPath ?? "/mnt/refs"}:ro`,
                `${PACKAGE_STORE}:${plan.libsPath ?? "/mnt/libs"}:ro`,
                `${farmPath}:${plan.farmPath ?? "/mnt/libs/farm"}:ro`,
                ...(cachePath === undefined || plan.cachePath === undefined ? [] : [`${cachePath}:${plan.cachePath}:rw`]),
            ];
            const run = await docker([
                "run",
                "-d",
                "--name",
                name,
                "--network",
                "none",
                "--cpus",
                String(paths.cpu),
                "--memory",
                `${paths.memoryGb}g`,
                "--user",
                SANDBOX_USER,
                "--entrypoint",
                "sleep",
                ...binds.flatMap((bind) => ["-v", bind]),
                ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
                "-w",
                paths.workingDir,
                SANDBOX_IMAGE,
                "infinity",
            ]);
            if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr.trim()}`);
        })();
        return started;
    };

    let count = 0;
    return {
        farmLockFile: join(farmPath, "inflexa.lock"),
        imagePackagesFile: join(PACKAGE_STORE, "image-packages.json"),
        extendAnalysisFarm: (_analysisId, queries) => ResultAsync.fromSafePromise(linkPackagesIntoFarm(PACKAGE_STORE, farmId, queries)),
        exec: async (request) => {
            await start();
            count += 1;
            const timeoutSeconds = request.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
            // sandbox-server runs a one-element command through `sh -c`, and an argv as it is.
            const command = request.command.length === 1 ? ["sh", "-c", request.command[0] ?? ""] : [...request.command];
            const began = Date.now();
            const result = await docker(
                [
                    "exec",
                    "--user",
                    SANDBOX_USER,
                    "-w",
                    request.cwd ?? paths.workingDir,
                    ...Object.entries(request.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
                    name,
                    ...command,
                ],
                timeoutSeconds * 1000,
            );
            // A killed `docker exec` leaves its command running in the container. The next command must not share the
            // CPU with it, thus a timeout kills each process of the sandbox user. PID 1 of the container survives.
            if (result.timedOut) await docker(["exec", "--user", SANDBOX_USER, name, "sh", "-c", "kill -9 -1 2>/dev/null; true"]);
            return capExecStreams({
                execId: `eval:${count}`,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                durationMs: Date.now() - began,
                timedOut: result.timedOut,
            });
        },
        dispose: async () => {
            if (started !== undefined) await docker(["rm", "-f", name]);
            await removeAnalysisFarm({ storeRoot: PACKAGE_STORE, analysisId: farmId });
        },
    };
}

/**
 * Write the binary inputs that `program` makes into `root`. The program runs once for each image and text, in the
 * image over the catalog farm, and the files that it writes are kept for the next trial. Thus each trial of a case
 * reads the same bytes.
 */
export async function generateInputs(program: string, root: string): Promise<void> {
    const key = createHash("sha256").update(SANDBOX_IMAGE).update(program).digest("hex").slice(0, 16);
    const out = join(FIXTURES_DIR, key);
    const done = join(FIXTURES_DIR, `${key}.done`);
    if (!existsSync(done)) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(FIXTURES_DIR, `${key}.py`), program);
        const plan = buildMountPlan(
            { analysisId: "fixtures", runId: "run", stepId: "step", recordTail: "exec-records" },
            { libs: true, refs: false, toolchainSource: "image" },
        );
        const env: Record<string, string> = { ...plan.env, HOME: "/tmp", MPLCONFIGDIR: "/tmp/mpl", NUMBA_CACHE_DIR: "/tmp/numba" };
        const run = await docker(
            [
                "run",
                "--rm",
                "--network",
                "none",
                "--user",
                SANDBOX_USER,
                "-v",
                `${PACKAGE_STORE}:/mnt/libs:ro`,
                "-v",
                `${catalogFarmPath(PACKAGE_STORE)}:${plan.farmPath ?? "/mnt/libs/farm"}:ro`,
                "-v",
                `${out}:/out:rw`,
                "-v",
                `${join(FIXTURES_DIR, `${key}.py`)}:/generate.py:ro`,
                ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
                "-w",
                "/out",
                "--entrypoint",
                "python",
                SANDBOX_IMAGE,
                "/generate.py",
            ],
            600_000,
        );
        if (run.exitCode !== 0) throw new Error(`the input generator failed: ${run.stderr.trim().slice(-2000)}`);
        writeFileSync(done, "");
    }
    cpSync(out, root, { recursive: true });
}

/** The image is present, thus a run fails fast and does not pull mid-trial. */
export async function assertSandboxImage(): Promise<void> {
    if (!existsSync(PACKAGE_STORE)) throw new Error(`no package store at ${PACKAGE_STORE} (set EVALS_PACKAGE_STORE)`);
    const inspect = await docker(["image", "inspect", SANDBOX_IMAGE, "--format", "{{.Id}}"], 30_000);
    if (inspect.exitCode !== 0) throw new Error(`the sandbox image ${SANDBOX_IMAGE} is not present: docker pull it first`);
}
