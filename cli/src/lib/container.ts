// Container-runtime registry + execution wrapper. Selecting Docker vs Podman is
// a config key (lib/config.ts), but the runtime descriptors, the spawn core, and
// the readiness probe live here. Kept config-free — mirroring lib/design_system.ts — so
// lib/config.ts can import `runtimeIds` for its zod enum without a cycle. The
// config-reading resolvers (`selectedRuntime` / `ensureRuntime`) therefore live in
// lib/config.ts, not here. The proxy module is today's only caller of the spawn core.

import { existsSync } from "node:fs";
import { type Result, ok, err } from "neverthrow";
import { z } from "zod";

import { env } from "./env.ts";

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

/** The options of {@link capture}. */
export type CaptureOpts = {
    /** An aborted signal kills the child, and the capture then reports the exit code that the kill produced. */
    readonly signal?: AbortSignal;
    /** The most bytes that each stream keeps: the first half and the last half of the budget. The stream is still read to its end. */
    readonly maxBytesPerStream?: number;
};

/**
 * Read a piped stream to its end, and keep at most `maxBytes` of it: the first half of the budget, the last
 * half, and a marker that names the dropped bytes between them. The pump never stops reading, because a child
 * that blocks on a full pipe would never exit. The memory is bounded by the budget plus one chunk.
 */
async function pumpBounded(readable: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
    const headMax = Math.floor(maxBytes / 2);
    const tailMax = maxBytes - headMax;
    const head: Uint8Array[] = [];
    let headLength = 0;
    const tail: Uint8Array[] = [];
    let tailLength = 0;
    let total = 0;
    const reader = readable.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        let rest = value;
        if (headLength < headMax) {
            const take = Math.min(headMax - headLength, rest.length);
            head.push(rest.slice(0, take));
            headLength += take;
            rest = rest.subarray(take);
        }
        if (rest.length === 0) continue;
        tail.push(rest.slice());
        tailLength += rest.length;
        // A leading chunk leaves once the chunks behind it already hold the whole tail budget.
        while (tail.length > 1 && tailLength - (tail[0]?.length ?? 0) >= tailMax) tailLength -= tail.shift()?.length ?? 0;
    }
    // The first kept chunk can overshoot the budget by part of one chunk; cut its front.
    const overshoot = tailLength - tailMax;
    if (overshoot > 0 && tail[0] !== undefined) {
        tail[0] = tail[0].subarray(overshoot);
        tailLength -= overshoot;
    }
    const decoder = new TextDecoder();
    const text = (chunks: Uint8Array[]): string => chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
    const dropped = total - headLength - tailLength;
    if (dropped <= 0) return text([...head, ...tail]);
    return `${text(head)}\n[... ${dropped} bytes not captured ...]\n${text(tail)}`;
}

/**
 * Run a container command and capture its stdout/stderr/exit code.
 *
 * `opts.maxBytesPerStream` bounds what the capture holds for each stream (the head and the tail, with a marker
 * between them), so a command with an unbounded output costs a bounded amount of memory. `opts.signal` kills the
 * child when it aborts, as {@link stream} does.
 */
export async function capture(rt: ContainerRuntime, args: string[], opts: CaptureOpts = {}): Promise<CaptureResult> {
    const proc = Bun.spawn({ cmd: [rt.bin, ...args], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    // A signal that was already aborted kills the child at once, because `addEventListener` fires for a
    // later abort only.
    const onAbort = (): void => proc.kill();
    if (opts.signal?.aborted === true) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const limit = opts.maxBytesPerStream;
        const [stdout, stderr] =
            limit === undefined
                ? await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
                : await Promise.all([pumpBounded(proc.stdout, limit), pumpBounded(proc.stderr, limit)]);
        const code = await proc.exited;
        return { code, stdout, stderr };
    } finally {
        opts.signal?.removeEventListener("abort", onAbort);
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
};

/**
 * Resolve the Docker-API socket the embedded harness dials to create sandbox
 * containers on the pinned runtime, per platform. This keeps the per-runtime
 * divergence on the descriptor surface (the `mountArg` `:z` precedent) rather than
 * as a conditional in the harness composition root.
 *
 * - **Docker** resolves to `undefined` — no explicit socket, so the harness's
 *   dockerode client keeps its default resolution and any `DOCKER_HOST` the user
 *   already relies on.
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
    probes: EngineSocketProbes = { platform: process.platform, capture, exists: existsSync },
): Promise<Result<string | undefined, ContainerRuntimeError>> {
    switch (rt.id) {
        case "docker":
            return ok(undefined);
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

/** The {@link EngineSocketProbes}, plus the `DOCKER_HOST` that the user set. */
export type EngineApiSocketProbes = EngineSocketProbes & { readonly dockerHost: string | undefined };

/** The path of a `unix://` daemon address, or `undefined` for each other scheme (`tcp://`, `ssh://`, `npipe://`). */
function unixSocketPath(address: string): string | undefined {
    return address.startsWith("unix://") ? address.slice("unix://".length) : undefined;
}

/**
 * Resolve the Docker-API socket that the image pull dials for its byte progress, or `undefined` when the pull
 * must go through the CLI. Only the pull reads this: the harness keeps {@link resolveEngineSocket}, which leaves
 * the Docker resolution of dockerode as it is.
 *
 * - **Docker** obeys the order of the Docker CLI: a `DOCKER_HOST` wins over the current context. A
 *   `DOCKER_HOST` that is not a unix socket gives `undefined` without a look at the context, because the CLI
 *   does not use the context either. With no `DOCKER_HOST`, `docker context inspect` gives the endpoint of the
 *   current context, which covers Docker Desktop, colima, and `/var/run/docker.sock`. The path counts only
 *   when it exists on disk.
 * - **Podman** gives the socket of {@link resolveEngineSocket}, and `undefined` when the engine is not ready.
 *
 * It never fails: a socket that is absent costs only the byte readout.
 */
export async function resolveEngineApiSocket(
    rt: ContainerRuntime,
    probes: EngineApiSocketProbes = { platform: process.platform, capture, exists: existsSync, dockerHost: env.dockerHost },
): Promise<string | undefined> {
    switch (rt.id) {
        case "docker": {
            const fromHost = probes.dockerHost === undefined || probes.dockerHost === "" ? null : unixSocketPath(probes.dockerHost);
            if (fromHost !== null) return fromHost !== undefined && probes.exists(fromHost) ? fromHost : undefined;
            const { code, stdout } = await probes.capture(rt, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
            if (code !== 0) return undefined;
            const socket = unixSocketPath(stdout.trim());
            return socket !== undefined && probes.exists(socket) ? socket : undefined;
        }
        case "podman":
            return (await resolveEngineSocket(rt, probes)).unwrapOr(undefined);
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
const manifestSchema = z
    .object({
        layers: z.array(z.object({ size: z.number() }).passthrough()).optional(),
        manifests: z
            .array(z.object({ digest: z.string(), platform: z.object({ architecture: z.string() }).passthrough().optional() }).passthrough())
            .optional(),
    })
    .passthrough();

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
const pullEventSchema = z
    .object({
        id: z.string().optional(),
        status: z.string().optional(),
        error: z.string().optional(),
        progressDetail: z.object({ current: z.number().optional(), total: z.number().optional() }).optional(),
    })
    .passthrough();

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
    let failure: string | null = null;
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
        return { kind: "failed", message: `The pull stream of the engine broke: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    if (buffer.trim() !== "") consume(buffer.trim());
    report();
    if (failure !== null) return { kind: "failed", message: failure };
    return { kind: "completed" };
}
