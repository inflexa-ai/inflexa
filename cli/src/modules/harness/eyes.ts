// The eyes of a report session, realized as one container for one look.
//
// The harness seam asks one question: where does a browser come from. A managed deployment answers with a
// standing sidecar over one shared volume. The cli cannot, because an anchor puts each workspace root in a
// different user folder and no fixed mount set covers them. Thus each look starts a browser with that one
// root mounted, and ends it after the look.
//
// The browser navigates a `file://` URL of the host tree, and the container has its own filesystem. Thus the
// mount target repeats the host path exactly. A container path that differed would resolve nothing.
import { createServer } from "node:net";

import type { AcquireEyes, EyesLease, EyesScope } from "@inflexa-ai/harness";

import { capture, type CaptureResult, type ContainerRuntime } from "../../lib/container.ts";
import { harnessLogger } from "../../lib/log.ts";

/**
 * The pinned browser image, by digest.
 *
 * `chromedp/headless-shell` serves the plain devtools endpoint that `puppeteer.connect({ browserURL })`
 * expects, with no wrapper API and no token. The digest pin matches the infrastructure images, thus a moved
 * tag never changes what a look runs against.
 */
export const EYES_IMAGE = "chromedp/headless-shell@sha256:2fc473f3f926ccae8dbfedf60897937dece94ff7bbdfab20457ebfc732c2b162";

/**
 * The devtools port inside the container. The entrypoint of the image relays this port onto the port that
 * the browser listens on, thus the published port is this one and never the inner one.
 */
const CONTAINER_DEVTOOLS_PORT = 9222;

/**
 * The entrypoint that bounds the life of the container, and the command that it wraps.
 *
 * The seam demands that a lease which no release ends still ends. A process can die between the acquire and
 * the finally, thus no release of a caller is the guarantee. `timeout` is in the image, and it kills the
 * browser from inside. Thus the bound holds when this process is already gone.
 *
 * The two paths belong to the pinned image. A digest pin fixes the contents, thus the coupling is safe.
 */
const LIFETIME_ENTRYPOINT = "/usr/bin/timeout";
const IMAGE_RUN_SCRIPT = "/headless-shell/run.sh";

/** How long one container is permitted to run. A look is one navigation and one screenshot, and it is not interactive. */
const DEFAULT_LIFETIME_SECONDS = 180;

/**
 * How much shared memory one container gets.
 *
 * Chrome composes a full-page capture bitmap in `/dev/shm`. The podman default of 64 MiB is smaller than that
 * bitmap for a tall report page, thus the capture fails with a protocol error although the page itself is
 * sound. One gigabyte holds a page an order of magnitude taller than the observed 11,189 px case, and the
 * memory is only committed while a look runs.
 */
const SHM_SIZE = "1g";

/**
 * How many browsers run at one time.
 *
 * The page gate of the harness bounds one endpoint, and each look here names a new endpoint. Thus the count
 * bound sits here, and nothing upstream applies one. A look is rare beside the model turns around it, thus a
 * small number costs no throughput and it caps a runaway.
 */
const DEFAULT_MAX_BROWSERS = 2;

/** How long the readiness probe waits for the devtools endpoint of a cold container. */
const READY_TIMEOUT_MS = 30_000;
const READY_INTERVAL_MS = 200;

/** The effectful edges of the realization, injectable so a test drives every branch with no container runtime. */
export type EphemeralEyesDeps = {
    /** The pinned container runtime of the boot. The realization spawns no other binary. */
    readonly runtime: ContainerRuntime;
    /** Runs one container command. The real one spawns the runtime binary. */
    readonly run?: (rt: ContainerRuntime, args: string[]) => Promise<CaptureResult>;
    /** Gives a free loopback port. The real one asks the kernel for an ephemeral port. */
    readonly freePort?: () => Promise<number>;
    /** True when the devtools endpoint answers. The real one reads `/json/version`. */
    readonly ready?: (browserUrl: string) => Promise<boolean>;
    /** Sleeps between two readiness attempts. Injectable so a test spends no real time. */
    readonly wait?: (ms: number) => Promise<void>;
    /** Reads the clock for the readiness deadline. Injectable for the same reason. */
    readonly now?: () => number;
    readonly image?: string;
    readonly lifetimeSeconds?: number;
    readonly maxBrowsers?: number;
};

/**
 * A free loopback port, taken from the kernel and released at once.
 *
 * The container publishes on a fixed host port, because podman rejects port 0 and only docker maps it. A
 * window sits between the release here and the bind of the container, thus a racing process can take the
 * port. The start then fails, and the acquire reports it. That is rare and it is loud, and it beats a
 * published port that a user must configure.
 */
async function kernelFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        // Loopback alone: the browser reads the workspace of the user, and nothing outside this host must
        // reach it.
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
                server.close();
                reject(new Error("the kernel gave no port for the eyes"));
                return;
            }
            const { port } = address;
            server.close(() => resolve(port));
        });
    });
}

/** Whether the devtools endpoint of a container answers yet. Any fault reads as "not yet", because the container is cold. */
async function devtoolsReady(browserUrl: string): Promise<boolean> {
    try {
        const response = await fetch(`${browserUrl}/json/version`);
        return response.ok;
    } catch {
        return false;
    }
}

/** A semaphore over the browsers that run at one time. The acquire waits, thus a look is never refused for a busy runtime. */
function createGate(max: number): { take: () => Promise<() => void> } {
    let active = 0;
    const queue: Array<() => void> = [];
    const give = (): void => {
        active--;
        const next = queue.shift();
        if (next) next();
    };
    return {
        take(): Promise<() => void> {
            return new Promise((resolve) => {
                const grant = (): void => {
                    active++;
                    resolve(give);
                };
                if (active < max) grant();
                else queue.push(grant);
            });
        },
    };
}

/**
 * Make the ephemeral realization of the eyes seam over the pinned container runtime.
 *
 * One acquire takes a slot of the count gate, starts one container with the workspace root mounted, waits for
 * the devtools endpoint, and gives the lease. The release removes the container and gives the slot back.
 *
 * The seam speaks the throw protocol, thus every failure here throws and the tool of the harness maps it onto
 * its typed outcome.
 */
export function createEphemeralEyes(deps: EphemeralEyesDeps): AcquireEyes {
    const logger = harnessLogger("harness").named("eyes");
    const run = deps.run ?? capture;
    const freePort = deps.freePort ?? kernelFreePort;
    const ready = deps.ready ?? devtoolsReady;
    const wait = deps.wait ?? Promise.sleep;
    const now = deps.now ?? Date.now;
    const image = deps.image ?? EYES_IMAGE;
    const lifetime = deps.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
    const gate = createGate(deps.maxBrowsers ?? DEFAULT_MAX_BROWSERS);

    async function remove(containerId: string): Promise<void> {
        const removed = await run(deps.runtime, ["rm", "-f", containerId]);
        // The container carries its own deadline, thus a failed removal costs one idle browser until that
        // deadline and never a leak. The log is the record, and the look already gave its result.
        if (removed.code !== 0) {
            logger.warn("the eyes container did not go", { containerId, detail: removed.stderr.trim() });
        }
    }

    return async function acquire(scope: EyesScope): Promise<EyesLease> {
        const giveSlot = await gate.take();
        let containerId: string | null = null;
        try {
            const port = await freePort();
            const started = await run(deps.runtime, [
                "run",
                "-d",
                "--rm",
                "--shm-size",
                SHM_SIZE,
                "-p",
                `127.0.0.1:${port}:${CONTAINER_DEVTOOLS_PORT}`,
                "-v",
                // The mount argument comes from the runtime descriptor, because podman needs its shared
                // relabel and docker takes the bare form. The two paths are identical, per the seam.
                deps.runtime.mountArg(scope.workspaceRoot, scope.workspaceRoot),
                "--entrypoint",
                LIFETIME_ENTRYPOINT,
                image,
                String(lifetime),
                IMAGE_RUN_SCRIPT,
            ]);
            if (started.code !== 0) {
                throw new Error(`the eyes container did not start: ${started.stderr.trim() || `exit ${started.code}`}`);
            }
            const startedId = started.stdout.trim();
            containerId = startedId;
            const browserUrl = `http://127.0.0.1:${port}`;

            const deadline = now() + READY_TIMEOUT_MS;
            while (!(await ready(browserUrl))) {
                if (now() >= deadline) {
                    throw new Error(`the eyes container did not answer at ${browserUrl} within ${READY_TIMEOUT_MS} ms`);
                }
                await wait(READY_INTERVAL_MS);
            }

            logger.info("the eyes are open", { analysisId: scope.analysisId, containerId, browserUrl });
            return {
                browserUrl,
                release: async (): Promise<void> => {
                    try {
                        await remove(startedId);
                    } finally {
                        giveSlot();
                    }
                },
            } satisfies EyesLease;
        } catch (cause) {
            // A container that started before the fault must not outlive the failed acquire. The slot goes
            // back here alone, because the lease that would give it back was never handed over.
            if (containerId !== null) await remove(containerId);
            giveSlot();
            throw cause;
        }
    };
}
