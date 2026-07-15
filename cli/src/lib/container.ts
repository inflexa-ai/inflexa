// Container-runtime registry + execution wrapper. Selecting Docker vs Podman is
// a config key (lib/config.ts), but the runtime descriptors, the spawn core, and
// the readiness probe live here. Kept config-free — mirroring lib/design_system.ts — so
// lib/config.ts can import `runtimeIds` for its zod enum without a cycle. The
// config-reading resolvers (`selectedRuntime` / `ensureRuntime`) therefore live in
// lib/config.ts, not here. The proxy module is today's only caller of the spawn core.

import { type Result, ok, err } from "neverthrow";

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
    /**
     * Build a `-v` bind-mount argument. Podman appends `:z` (shared SELinux
     * relabel) because the proxy and the one-shot login container mount the same
     * host dirs; a private `:Z` would let a re-login lock out the running proxy.
     * Docker uses the bare `host:container` form.
     */
    mountArg(host: string, ctr: string): string;
};

/** The supported runtimes, keyed by id. */
export const runtimes: Record<ContainerRuntimeId, ContainerRuntime> = {
    docker: {
        id: "docker",
        bin: "docker",
        label: "Docker",
        notFoundHint: "Docker is required but was not found.\n  Install Docker Desktop (https://docs.docker.com/get-docker/) and re-run `inflexa setup`.",
        notReadyHint: "Docker is installed but the daemon isn't running.\n  Start Docker (Docker Desktop, or `sudo systemctl start docker`) and re-run.",
        mountArg(host: string, ctr: string): string {
            return `${host}:${ctr}`;
        },
    },
    podman: {
        id: "podman",
        bin: "podman",
        label: "Podman",
        notFoundHint: "Podman is required but was not found.\n  Install Podman (https://podman.io/docs/installation) and re-run `inflexa setup`.",
        notReadyHint:
            "Podman is installed but not ready.\n  On macOS, start the Podman machine (`podman machine start`); on Linux, ensure rootless Podman is configured, then re-run.",
        mountArg(host: string, ctr: string): string {
            return `${host}:${ctr}:z`;
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

/** Run a container command and capture its stdout/stderr/exit code. */
export async function capture(rt: ContainerRuntime, args: string[]): Promise<CaptureResult> {
    const proc = Bun.spawn({ cmd: [rt.bin, ...args], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { code, stdout, stderr };
}

/** Run a container command with inherited stdio (pull progress, interactive login). */
export async function inherit(rt: ContainerRuntime, args: string[]): Promise<number> {
    const proc = Bun.spawn({ cmd: [rt.bin, ...args], stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return proc.exited;
}

/**
 * Verify the runtime is installed and usable before issuing commands. Returns
 * a {@link ContainerRuntimeError} on the error channel with runtime-specific
 * guidance: `notFoundHint` when the binary is absent, `notReadyHint` when
 * `info` fails (daemon down / Podman machine not started).
 */
export async function ensureReady(rt: ContainerRuntime): Promise<Result<void, ContainerRuntimeError>> {
    if (!Bun.which(rt.bin)) return err(new ContainerRuntimeError(rt.notFoundHint));
    // `info` exits non-zero when the runtime is installed but not reachable.
    const { code } = await capture(rt, ["info"]);
    if (code !== 0) return err(new ContainerRuntimeError(rt.notReadyHint));
    return ok(undefined);
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
