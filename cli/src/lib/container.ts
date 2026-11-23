// Container-runtime registry + execution wrapper. Selecting Docker vs Podman is
// a config key (lib/config.ts), but the runtime descriptors, the spawn core, and
// the readiness probe live here. Kept config-free — mirroring lib/design_system.ts — so
// lib/config.ts can import `runtimeIds` for its zod enum without a cycle. The
// config-reading resolvers (`selectedRuntime` / `ensureRuntime`) therefore live in
// lib/config.ts, not here. The proxy module is today's only caller of the spawn core.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Result, ok, err } from "neverthrow";
import { z } from "zod";
import type { ExecutorUser, SandboxExecutor } from "@inflexa-ai/harness";

import { env } from "./env.ts";
import { messageOf } from "./cause.ts";
import { runAfter } from "./timer.ts";

/**
 * Ordered id list — single source of truth for the picker order, the
 * `ContainerRuntimeId` union, and the config zod enum. Docker is first: it is the
 * default and the first option in the settings list.
 */
export const runtimeIds = ["docker", "podman"] as const;

/** A supported container backing system. */
export type ContainerRuntimeId = (typeof runtimeIds)[number];

/**
 * Everything that differs between runtimes. The common command surface (`run`,
 * `ps`, `pull`, …) is identical, so callers pass raw arg arrays to {@link capture}
 * / {@link inherit}; only the genuinely divergent pieces are fields here.
 */
export type ContainerRuntime = {
    /** The runtime id, also the config value. */
    id: ContainerRuntimeId;
    /** Executable name spawned for every command (`docker` / `podman`). */
    bin: string;
    /** Human-facing name for UI rows and error text. */
    label: string;
    /** Actionable message when {@link bin} is not on `PATH`. */
    notFoundHint: string;
    /** Actionable message when the runtime is installed but not usable. */
    notReadyHint: string;
    /** Actionable message when the runtime refuses this user access to its socket ("permission denied"). */
    deniedHint: string;
    /**
     * Build a `-v` bind-mount argument. Podman appends `:z` (shared SELinux
     * relabel) because the proxy and the one-shot login container mount the same
     * host dirs; a private `:Z` would let a re-login lock out the running proxy.
     * Docker uses the bare `host:container` form.
     */
    mountArg(host: string, ctr: string): string;
    /** A read-only bind of a host directory. The store mounts through this in the sandbox-image runs, because a check must not write the store. */
    mountArgRo(host: string, ctr: string): string;
};

/** The supported runtimes, keyed by id. */
export const runtimes: Record<ContainerRuntimeId, ContainerRuntime> = {
    docker: {
        id: "docker",
        bin: "docker",
        label: "Docker",
        notFoundHint: "Docker is required but was not found.\n  Install Docker Desktop (https://docs.docker.com/get-docker/) and re-run `inflexa setup`.",
        notReadyHint: "Docker is installed but the daemon isn't running.\n  Start Docker (Docker Desktop, or `sudo systemctl start docker`) and re-run.",
        deniedHint:
            "Docker runs, but this user may not use its socket (permission denied).\n" +
            "  Add the user to the `docker` group (`sudo usermod -aG docker $USER`), then sign out and in again, and re-run.",
        mountArg(host: string, ctr: string): string {
            return `${host}:${ctr}`;
        },
        mountArgRo(host: string, ctr: string): string {
            return `${host}:${ctr}:ro`;
        },
    },
    podman: {
        id: "podman",
        bin: "podman",
        label: "Podman",
        notFoundHint: "Podman is required but was not found.\n  Install Podman (https://podman.io/docs/installation) and re-run `inflexa setup`.",
        notReadyHint:
            "Podman is installed but not ready.\n  On macOS, start the Podman machine (`podman machine start`); on Linux, ensure rootless Podman is configured, then re-run.",
        deniedHint:
            "Podman refused this user access to its socket (permission denied).\n  Run Podman rootless as this user, or ask the administrator for access to the socket, then re-run.",
        mountArg(host: string, ctr: string): string {
            return `${host}:${ctr}:z`;
        },
        mountArgRo(host: string, ctr: string): string {
            return `${host}:${ctr}:ro,z`;
        },
    },
};

/**
 * Expected, user-actionable runtime failures (binary missing, runtime not ready).
 * Owned here rather than reusing the proxy's `ProxyError` because `lib/` must
 * never import a module. Callers print `.message` and exit instead of dumping a
 * stack.
 */
export class ContainerRuntimeError extends Error {}

/** Captured result of a container command. */
export type CaptureResult = { code: number; stdout: string; stderr: string };

/**
 * The deadline of a query of the engine, for example `info` or `image inspect`. Such a query answers in a second,
 * but an engine that hangs, for example Docker Desktop after a sleep of the host, answers never.
 */
export const ENGINE_QUERY_TIMEOUT_MS = 30_000;

/** The exit code of a command that {@link capture} stopped at its deadline. It is the code of `timeout(1)`. */
export const CAPTURE_TIMEOUT_CODE = 124;

/**
 * Run a container command and capture its stdout/stderr/exit code. With `timeoutMs`, a command that has not ended
 * at the deadline is killed and gives {@link CAPTURE_TIMEOUT_CODE}, thus each caller reads it as a failed command.
 * A pull or a compose run takes as long as its bytes, thus only a query sets a deadline.
 */
export async function capture(rt: ContainerRuntime, args: string[], opts: { readonly timeoutMs?: number } = {}): Promise<CaptureResult> {
    const proc = Bun.spawn({ cmd: [rt.bin, ...args], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timeoutMs = opts.timeoutMs;
    const deadline = { passed: false };
    const stop =
        timeoutMs === undefined
            ? () => {}
            : runAfter(timeoutMs, () => {
                  deadline.passed = true;
                  proc.kill("SIGKILL");
              });
    try {
        const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const code = await proc.exited;
        if (!deadline.passed) return { code, stdout, stderr };
        return { code: CAPTURE_TIMEOUT_CODE, stdout, stderr: `${stderr}${rt.bin} ${args.join(" ")} did not end within ${String(timeoutMs)} ms.\n` };
    } finally {
        stop();
    }
}

/**
 * Run a container command, delivering each output line to `onLine` as it lands, and capture both
 * streams whole.
 *
 * `onLine` is a notification, never a control channel. A caller that must not let a failing observer
 * abort a run in flight wraps it before it reaches here (the reference-store installer's `reportProgress`
 * pattern); this function does not guard the callback itself.
 *
 * `signal` is the control channel, and it is the ONLY one: an aborted signal kills the child, both pumps
 * then reach end of stream, and the run reports the exit code that the signal produced. A caller that
 * must stop work in flight — an acquisition flight whose last subscriber cancelled — needs a handle on
 * the process, and only this function holds one.
 */
export async function stream(rt: ContainerRuntime, args: string[], onLine: (line: string) => void, signal?: AbortSignal): Promise<CaptureResult> {
    const proc = Bun.spawn({ cmd: [rt.bin, ...args], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    // A signal that was already aborted kills the child at once, because `addEventListener` fires for a
    // later abort only and the caller asked for no work.
    const onAbort = (): void => proc.kill();
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const captured = { stdout: "", stderr: "" };
    // Read a piped stream to end, splitting on newlines so the observer sees whole lines. `stream: true`
    // decoding keeps a multi-byte character that straddles two chunks intact.
    const pump = async (readable: ReadableStream<Uint8Array>, key: "stdout" | "stderr"): Promise<void> => {
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let newline = pending.indexOf("\n");
            while (newline !== -1) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                captured[key] += `${line}\n`;
                onLine(line);
                newline = pending.indexOf("\n");
            }
        }
        // A final line with no trailing newline still counts.
        if (pending !== "") {
            captured[key] += pending;
            onLine(pending);
        }
    };
    try {
        await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
        const code = await proc.exited;
        return { code, stdout: captured.stdout, stderr: captured.stderr };
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }
}

/** Run a container command with inherited stdio (pull progress, interactive login). */
export async function inherit(rt: ContainerRuntime, args: string[]): Promise<number> {
    const proc = Bun.spawn({ cmd: [rt.bin, ...args], stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return proc.exited;
}

/**
 * Verify the runtime is installed and usable before issuing commands. Returns
 * a {@link ContainerRuntimeError} on the error channel with runtime-specific
 * guidance: `notFoundHint` when the binary is absent, `deniedHint` when `info` fails with "permission denied"
 * on the socket, and `notReadyHint` when `info` fails otherwise (daemon down / Podman machine not started).
 */
export async function ensureReady(rt: ContainerRuntime): Promise<Result<void, ContainerRuntimeError>> {
    if (!Bun.which(rt.bin)) return err(new ContainerRuntimeError(rt.notFoundHint));
    // `info` exits non-zero when the runtime is installed but not reachable. A socket that refuses this user
    // (EACCES) also exits non-zero, and a "start the daemon" hint then sends the person to a daemon that runs.
    const { code, stderr } = await capture(rt, ["info"], { timeoutMs: ENGINE_QUERY_TIMEOUT_MS });
    if (code !== 0) return err(new ContainerRuntimeError(stderr.toLowerCase().includes("permission denied") ? rt.deniedHint : rt.notReadyHint));
    return ok(undefined);
}

/** What the engine can give its containers: its cores, and its memory in whole GB. */
export type EngineCapacity = { readonly cpu: number; readonly memoryGb: number };

/**
 * Read the cores and the memory of the engine. A podman machine or a Docker Desktop VM can be smaller than the host,
 * and a container can never use more than its engine has. `undefined` when the engine gives no answer that parses:
 * the caller then keeps the figures of the host.
 */
export async function engineCapacity(rt: ContainerRuntime, run: typeof capture = capture): Promise<EngineCapacity | undefined> {
    const format = rt.id === "podman" ? "{{.Host.CPUs}},{{.Host.MemTotal}}" : "{{.NCPU}},{{.MemTotal}}";
    const { code, stdout } = await run(rt, ["info", "--format", format], { timeoutMs: ENGINE_QUERY_TIMEOUT_MS });
    if (code !== 0) return undefined;
    const [cpu, memoryBytes] = stdout.trim().split(",").map(Number);
    if (cpu === undefined || memoryBytes === undefined || !Number.isInteger(cpu) || cpu < 1 || !Number.isFinite(memoryBytes) || memoryBytes <= 0) {
        return undefined;
    }
    return { cpu, memoryGb: Math.max(1, Math.floor(memoryBytes / 1024 ** 3)) };
}

/**
 * Probe `candidates` in preference order and return the first usable runtime.
 * Probing stops at the first success — a ready first choice never spawns the
 * others' binaries. When none is ready, the error aggregates every candidate's
 * specific guidance so the user sees each runtime's remediation, not just the
 * preferred one's. The setup flow uses this to fall back even from an explicit
 * but dead selection ("Docker configured but stopped, Podman running" proceeds
 * with Podman); `ensureRuntime` (lib/config.ts) uses it to detect a runtime when
 * none is selected yet.
 *
 * `probe` is injectable for tests only — the real check spawns the runtime
 * binary, so unit tests substitute a fake to exercise the ordering and
 * aggregation logic.
 */
export async function firstReadyRuntime(
    candidates: readonly ContainerRuntime[],
    probe: (rt: ContainerRuntime) => Promise<Result<void, ContainerRuntimeError>> = ensureReady,
): Promise<Result<ContainerRuntime, ContainerRuntimeError>> {
    const failures: string[] = [];
    for (const rt of candidates) {
        const ready = await probe(rt);
        if (ready.isOk()) return ok(rt);
        failures.push(ready.error.message);
    }
    const needs = candidates.map((rt) => rt.label).join(", ");
    return err(new ContainerRuntimeError([`No usable container runtime found — inflexa needs one of ${needs}.`, ...failures].join("\n\n")));
}

/**
 * The effectful probes {@link resolveEngineSocket} uses, injectable so tests can
 * exercise every runtime/platform branch without spawning a real binary or
 * touching the filesystem — the same test seam {@link firstReadyRuntime}'s `probe`
 * parameter provides.
 */
export type EngineSocketProbes = {
    /** Host platform: selects the podman resolution path (`podman machine inspect` on darwin, `podman info` elsewhere). */
    readonly platform: NodeJS.Platform;
    /** Runs a runtime command and captures its output; the real one spawns the binary. */
    readonly capture: (rt: ContainerRuntime, args: string[]) => Promise<CaptureResult>;
    /**
     * True when `path` exists on disk. Gates BOTH podman socket paths: the Linux REST
     * socket (a reachable CLI does not imply a listening socket) and the macOS compat
     * socket (the gvproxy forward backing it exists only while the machine runs, so a
     * missing file detects a stopped machine that `machine inspect` still reports a
     * path for).
     */
    readonly exists: (path: string) => boolean;
    /** The `DOCKER_HOST` that the user set. It wins over the current Docker context, as in the Docker CLI. */
    readonly dockerHost: string | undefined;
};

/** The path of a `unix://` daemon address, or `undefined` for each other scheme (`tcp://`, `ssh://`, `npipe://`). */
function unixSocketPath(address: string): string | undefined {
    return address.startsWith("unix://") ? address.slice("unix://".length) : undefined;
}

/**
 * Resolve the Docker-API socket the embedded harness dials to create sandbox
 * containers on the pinned runtime, per platform. This keeps the per-runtime
 * divergence on the descriptor surface (the `mountArg` `:z` precedent) rather than
 * as a conditional in the harness composition root.
 *
 * - **Docker** obeys the order of the Docker CLI: a `DOCKER_HOST` wins over the
 *   current context. A `DOCKER_HOST` that is not a unix socket gives `undefined`
 *   without a look at the context, because dockerode reads that `DOCKER_HOST`
 *   itself. With no `DOCKER_HOST`, `docker context inspect` gives the endpoint of
 *   the current context, which covers Docker Desktop, Colima, and rootless Docker.
 *   The path counts only when it exists on disk. Each other case gives `undefined`,
 *   and dockerode then dials `/var/run/docker.sock`.
 * - **Podman/macOS** resolves the running machine's host-forwarded compat socket
 *   (`podman machine inspect`), gated on that socket EXISTING on disk. Inspect
 *   reports the persisted socket path on a zero exit even for a stopped machine, so
 *   the reported path is NOT proof of a live machine; the gvproxy forward backing
 *   the socket is torn down when the machine stops, so the socket file exists only
 *   while the machine runs — which is what makes the stat a real stopped-machine
 *   detector. A missing path, empty path, or non-zero exit is an actionable error
 *   hinting `podman machine start`.
 * - **Podman/Linux** (and any other non-darwin host) resolves `podman info`'s
 *   reported REST socket, gated on that path EXISTING on disk: the podman CLI talks
 *   to the engine directly, so a reachable CLI does NOT imply a listening REST
 *   socket (it exists only when `podman.socket` is enabled or `podman system
 *   service` runs). A missing path or non-zero exit hints
 *   `systemctl --user enable --now podman.socket`.
 *
 * The result rides the ok channel as `string | undefined` — absence is in-band,
 * not an error. It is per-boot state and MUST NOT be persisted: the macOS compat
 * socket lives under `$TMPDIR` and moves across machine restarts, so a saved path
 * is a future ECONNREFUSED. `probes` is injectable for tests only.
 */
export async function resolveEngineSocket(
    rt: ContainerRuntime,
    probes: EngineSocketProbes = {
        platform: process.platform,
        capture: (runtime, args) => capture(runtime, args, { timeoutMs: ENGINE_QUERY_TIMEOUT_MS }),
        exists: existsSync,
        dockerHost: env.dockerHost,
    },
): Promise<Result<string | undefined, ContainerRuntimeError>> {
    switch (rt.id) {
        case "docker": {
            const fromHost = probes.dockerHost === undefined || probes.dockerHost === "" ? null : unixSocketPath(probes.dockerHost);
            if (fromHost !== null) return ok(fromHost !== undefined && probes.exists(fromHost) ? fromHost : undefined);
            const { code, stdout } = await probes.capture(rt, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
            if (code !== 0) return ok(undefined);
            const socket = unixSocketPath(stdout.trim());
            return ok(socket !== undefined && probes.exists(socket) ? socket : undefined);
        }
        case "podman": {
            if (probes.platform === "darwin") {
                const { code, stdout } = await probes.capture(rt, ["machine", "inspect", "--format", "{{.ConnectionInfo.PodmanSocket.Path}}"]);
                const socket = stdout.trim();
                // `podman machine inspect` reports the persisted socket path on a zero exit
                // even when the machine is stopped, so the path alone cannot tell running from
                // stopped. The gvproxy forward backing that socket exists only while the machine
                // runs, so statting it on disk is the real liveness gate (mirrors the Linux
                // REST-socket check below).
                if (code !== 0 || socket === "" || !probes.exists(socket)) {
                    return err(
                        new ContainerRuntimeError(
                            "Could not resolve the Podman sandbox-engine socket — the Podman machine is not running.\n  Start it with `podman machine start`, then re-run.",
                        ),
                    );
                }
                return ok(socket);
            }
            const { code, stdout } = await probes.capture(rt, ["info", "--format", "{{.Host.RemoteSocket.Path}}"]);
            const socket = stdout.trim();
            // `podman info` succeeding does not imply the REST API is listening, so the
            // reported path only counts when it is actually present on disk.
            if (code !== 0 || socket === "" || !probes.exists(socket)) {
                return err(
                    new ContainerRuntimeError(
                        "Could not resolve the Podman sandbox-engine socket — the Podman API service is not listening.\n  Enable it with `systemctl --user enable --now podman.socket`, then re-run.",
                    ),
                );
            }
            return ok(socket);
        }
        default: {
            const exhaustive: never = rt.id;
            throw new Error(`unhandled runtime: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * The socket of {@link resolveEngineSocket} for the image pull, which dials it for its byte progress, or
 * `undefined` when the pull must go through the CLI. It never fails: a socket that is absent costs only the byte
 * readout.
 */
export async function resolveEngineApiSocket(rt: ContainerRuntime, probes?: EngineSocketProbes): Promise<string | undefined> {
    return (await resolveEngineSocket(rt, probes)).unwrapOr(undefined);
}

/** The user ids of this process, or `undefined` on a platform with no POSIX ids. */
function processUser(): ExecutorUser | undefined {
    if (process.getuid === undefined || process.getgid === undefined || process.getgroups === undefined) return undefined;
    return { uid: process.getuid(), gid: process.getgid(), groups: [...new Set(process.getgroups())] };
}

/** The effectful probes of {@link resolveSandboxExecutor}, injectable so tests spawn no engine. */
export type SandboxExecutorProbes = {
    readonly platform: NodeJS.Platform;
    readonly capture: (rt: ContainerRuntime, args: string[]) => Promise<CaptureResult>;
    /** The `DOCKER_HOST` that the user set. dockerode in the harness dials it, else its default socket. */
    readonly dockerHost: string | undefined;
    /** True when `path` exists on disk. It selects the default socket of dockerode. */
    readonly exists: (path: string) => boolean;
    readonly homeDir: string;
    /** The user that the sandbox acts for. The engine runs on this machine, thus its user is the user of this process. */
    readonly user: () => ExecutorUser | undefined;
};

/** The executor fact, and the OCI runtime that Podman reports. */
export type DetectedExecutor = {
    readonly executor: SandboxExecutor;
    /** The OCI runtime of a Linux Podman engine. Only crun keeps the groups of the user for rootless Podman. */
    readonly ociRuntime: string | undefined;
};

/** Why no executor fact comes from the engine. */
export type SandboxExecutorError = { type: "rootless_docker"; message: string } | { type: "engine_info_failed"; message: string };

/**
 * The socket that dockerode (docker-modem) dials when no `DOCKER_HOST` names one: the socket of a
 * Docker Desktop install in the home directory when it exists, else the system socket.
 */
function dockerodeDefaultSocket(probes: SandboxExecutorProbes): string {
    const desktop = join(probes.homeDir, ".docker", "run", "docker.sock");
    return probes.exists(desktop) ? desktop : "/var/run/docker.sock";
}

const dockerInfoSchema = z.looseObject({
    OperatingSystem: z.string().optional(),
    SecurityOptions: z.array(z.string()).nullish(),
});

const podmanInfoSchema = z.looseObject({
    host: z.looseObject({
        security: z.looseObject({ rootless: z.boolean().optional(), selinuxEnabled: z.boolean().optional() }).optional(),
        ociRuntime: z.looseObject({ name: z.string().optional() }).optional(),
    }),
});

/** True when a `SecurityOptions` entry of the Docker info is `name=<name>`, with or without its settings. */
function hasSecurityOption(options: readonly string[], name: string): boolean {
    return options.some((option) => option.split(",")[0] === `name=${name}`);
}

/**
 * Detect how the engine that runs the sandbox maps container ids onto the host files: the
 * executor fact that the harness selects the workload user from.
 *
 * - **macOS and Windows** run the engine in a VM. Docker Desktop and OrbStack mask the owner
 *   of a shared file. A Podman machine shows the true owner.
 * - **Docker on Linux** reads the info of the daemon that the harness dials: the `DOCKER_HOST`
 *   of the user, else the default socket of dockerode, not the current context of the CLI.
 *   `Docker Desktop` is a VM. `name=rootless` is refused: there the container root is the user,
 *   and each other container uid is a subordinate uid, thus no drop reaches the files of the
 *   user. Each other daemon is rootful.
 * - **Podman on Linux** reads `podman info`, the engine of the user that serves the socket of
 *   the harness.
 *
 * `probes` is injectable for tests only.
 */
export async function resolveSandboxExecutor(
    rt: ContainerRuntime,
    probes: SandboxExecutorProbes = {
        platform: process.platform,
        capture,
        dockerHost: env.dockerHost,
        exists: existsSync,
        homeDir: homedir(),
        user: processUser,
    },
): Promise<Result<DetectedExecutor, SandboxExecutorError>> {
    if (probes.platform !== "linux") {
        return ok({ executor: { kind: "vm", bindOwnership: rt.id === "podman" ? "host-preserved" : "masked" }, ociRuntime: undefined });
    }
    const hostUser = (): Result<ExecutorUser, SandboxExecutorError> => {
        const user = probes.user();
        return user === undefined ? err({ type: "engine_info_failed", message: "Could not read the uid and the gids of this user." }) : ok(user);
    };
    switch (rt.id) {
        case "docker": {
            // dockerode reads an empty DOCKER_HOST, and a `unix://` with no path, as unset.
            const dockerHost = probes.dockerHost === "" || probes.dockerHost === "unix://" ? undefined : probes.dockerHost;
            const where = dockerHost !== undefined ? `DOCKER_HOST (${dockerHost})` : `unix://${dockerodeDefaultSocket(probes)}`;
            const args = dockerHost !== undefined ? ["info", "--format", "{{json .}}"] : ["-H", where, "info", "--format", "{{json .}}"];
            const { code, stdout, stderr } = await probes.capture(rt, args);
            const info = code === 0 ? JSON.parseWith(stdout, dockerInfoSchema) : null;
            if (info === null) {
                return err({
                    type: "engine_info_failed",
                    message: `Could not read the Docker engine info at ${where}, the engine that the sandbox uses.\n  ${stderr.trim() || "The engine gave no readable info."}`,
                });
            }
            if (info.OperatingSystem === "Docker Desktop") return ok({ executor: { kind: "vm", bindOwnership: "masked" }, ociRuntime: undefined });
            const options = info.SecurityOptions ?? [];
            if (hasSecurityOption(options, "rootless")) {
                return err({
                    type: "rootless_docker",
                    message: `Rootless Docker at ${where} cannot run the sandbox: each container uid other than root is a subordinate uid, thus the sandbox cannot read your files.\n  Use rootful Docker, Docker Desktop, or Podman, then re-run.`,
                });
            }
            return hostUser().map((user) => ({ executor: { kind: "rootful", user, selinux: hasSecurityOption(options, "selinux") }, ociRuntime: undefined }));
        }
        case "podman": {
            const { code, stdout, stderr } = await probes.capture(rt, ["info", "--format", "json"]);
            const info = code === 0 ? JSON.parseWith(stdout, podmanInfoSchema) : null;
            if (info === null) {
                return err({
                    type: "engine_info_failed",
                    message: `Could not read the Podman engine info.\n  ${stderr.trim() || "Podman gave no readable info."}`,
                });
            }
            const selinux = info.host.security?.selinuxEnabled === true;
            const ociRuntime = info.host.ociRuntime?.name;
            if (info.host.security?.rootless === true) return ok({ executor: { kind: "rootless-podman", selinux }, ociRuntime });
            return hostUser().map((user) => ({ executor: { kind: "rootful", user, selinux }, ociRuntime }));
        }
        default: {
            const exhaustive: never = rt.id;
            throw new Error(`unhandled runtime: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** The docker-API architecture name of this host, for the manifest-index pick. */
function hostArchitecture(): string {
    return process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
}

/**
 * An image reference split for the docker-compat pull API: the repository, and the reference that the pull
 * sends as `tag`. A `name:tag@sha256:…` or `name@sha256:…` reference gives the digest, because the digest is
 * what the registry resolves. Else the reference is the tag, or `latest` when the image names none.
 */
export function splitImageRef(image: string): { repo: string; reference: string } {
    const at = image.indexOf("@");
    const named = at < 0 ? image : image.slice(0, at);
    const slash = named.lastIndexOf("/");
    const name = named.slice(slash + 1);
    const colon = name.indexOf(":");
    const repo = colon < 0 ? named : named.slice(0, slash + 1) + name.slice(0, colon);
    if (at >= 0) return { repo, reference: image.slice(at + 1) };
    return { repo, reference: colon < 0 ? "latest" : name.slice(colon + 1) };
}

/** One registry manifest, leniently: an image manifest carries `layers`, and an index carries `manifests`. */
const manifestSchema = z.looseObject({
    layers: z.array(z.looseObject({ size: z.number() })).optional(),
    manifests: z.array(z.looseObject({ digest: z.string(), platform: z.looseObject({ architecture: z.string() }).optional() })).optional(),
});

/**
 * The total bytes of an image, summed over the layer sizes of its registry
 * manifest — resolved BEFORE the pull, thus the meter has its total from the
 * first byte. A reference that pins a digest reads the manifest of that
 * digest. An index resolves through the entry of this host architecture.
 * `null` when the manifest cannot answer, and the caller then renders the
 * moved bytes alone.
 */
export async function resolveImageTotalBytes(rt: ContainerRuntime, image: string): Promise<number | null> {
    const probe = async (ref: string): Promise<{ code: number; stdout: string } | null> => {
        try {
            return await capture(rt, ["manifest", "inspect", ref]);
        } catch {
            return null;
        }
    };
    const sumLayers = (raw: string): number | null => {
        const parsed = JSON.parseWith(raw, manifestSchema);
        if (parsed?.layers === undefined || parsed.layers.length === 0) return null;
        return parsed.layers.reduce((n, layer) => n + layer.size, 0);
    };
    const { repo, reference } = splitImageRef(image);
    // A tag cannot hold a colon, thus a reference with one is a digest.
    const first = await probe(reference.includes(":") ? `${repo}@${reference}` : image);
    if (first === null || first.code !== 0) return null;
    const direct = sumLayers(first.stdout);
    if (direct !== null) return direct;
    const parsed = JSON.parseWith(first.stdout, manifestSchema);
    const entry = parsed?.manifests?.find((candidate) => candidate.platform?.architecture === hostArchitecture());
    if (entry === undefined) return null;
    const arch = await probe(`${repo}@${entry.digest}`);
    if (arch === null || arch.code !== 0) return null;
    return sumLayers(arch.stdout);
}

/** One progress event of the docker-compat pull stream. An `error` event ends the pull with that reason. */
const pullEventSchema = z.looseObject({
    id: z.string().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
    progressDetail: z.object({ current: z.number().optional(), total: z.number().optional() }).optional(),
});

/** The moved bytes of one engine pull, and the layers that completed. */
export type EnginePullProgress = { doneBytes: number; layersCompleted: number };

/** How one engine pull ended. `unavailable` sends the caller to the CLI pull, and it is not a failure. */
export type EnginePullOutcome = { kind: "completed" } | { kind: "failed"; message: string } | { kind: "unavailable" };

/**
 * Pull through the docker-compat API of the engine, and report the per-layer
 * byte progress. The engine serves `POST /images/create` as a line stream of
 * JSON events, and each `progressDetail.current` is the bytes of one layer so
 * far — the sum is what a meter renders. The CLI `pull` reports no byte figure
 * at all, which is the reason this path exists.
 *
 * `onProgress` runs after each chunk of the stream, and one time at the end.
 * It is a notification: this function does not guard it, as {@link stream} does
 * not guard `onLine`.
 *
 * It never rejects. A socket that does not answer, and a response that is not
 * OK or has no body, read as `unavailable`: the caller then pulls through the
 * CLI, and only the byte readout is lost. An `error` event, and a stream that
 * breaks before its end, read as `failed`.
 */
export async function pullImageThroughEngine(socket: string, image: string, onProgress: (progress: EnginePullProgress) => void): Promise<EnginePullOutcome> {
    const { repo, reference } = splitImageRef(image);
    let response: Response;
    try {
        // `unix` is the Bun fetch extension that dials a unix socket; the host
        // name of the URL is decoration the engine never reads.
        response = await fetch(`http://engine/v1.41/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(reference)}`, {
            method: "POST",
            unix: socket,
        });
    } catch {
        return { kind: "unavailable" };
    }
    if (!response.ok || response.body === null) return { kind: "unavailable" };

    const layerBytes = new Map<string, number>();
    const layersDone = new Set<string>();
    let failure: string | undefined;
    let buffer = "";
    const decoder = new TextDecoder();
    const report = (): void => onProgress({ doneBytes: [...layerBytes.values()].reduce((n, b) => n + b, 0), layersCompleted: layersDone.size });
    const consume = (line: string): void => {
        const event = JSON.parseWith(line, pullEventSchema);
        if (event === null) return;
        if (event.error !== undefined) failure = event.error;
        if (event.id === undefined) return;
        const current = event.progressDetail?.current;
        // The stream repeats each layer with a growing `current`; the map keeps
        // the newest figure, and the sum over the map is the moved total.
        if (current !== undefined) layerBytes.set(event.id, Math.max(current, layerBytes.get(event.id) ?? 0));
        if (event.status === "Pull complete" || event.status === "Already exists") layersDone.add(event.id);
    };
    try {
        for await (const chunk of response.body) {
            buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
            for (;;) {
                const newline = buffer.indexOf("\n");
                if (newline < 0) break;
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line !== "") consume(line);
            }
            report();
        }
    } catch (cause) {
        return { kind: "failed", message: `The pull stream of the engine broke: ${messageOf(cause)}` };
    }
    if (buffer.trim() !== "") consume(buffer.trim());
    report();
    if (failure !== undefined) return { kind: "failed", message: failure };
    return { kind: "completed" };
}
