import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { Result, ok, err } from "neverthrow";
import { capture, inherit, type ContainerRuntime } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { CONTAINER_DATA_PATH, CONTAINER_PG_PORT, DEFAULT_IMAGE, type PostgresConnection, type PostgresError } from "./postgres_types.ts";
import { formatInfraStateError, writeProxyConfig, type InfraStateError } from "./proxy_config.ts";

// Docker Compose orchestration for the inflexa infrastructure stack. Generates
// a compose file that places both the CLIProxyAPI proxy and the Postgres
// container on a shared `inflexa` network, so they can reach each other by
// service name (e.g. `inflexa-postgres:5432`) rather than host port mapping.
//
// Compose commands go through lib/container.ts's capture/inherit wrappers,
// which abstract `docker` vs `podman`. The compose subcommand (`docker compose`
// / `podman compose`) is a plugin of the same binary.

// Pinned by version tag AND manifest digest (`<name>:<tag>@sha256:…`): the tag names the semantics a
// reviewer checks release notes against, the digest makes a republished tag inert (the engine resolves by
// digest when both are present). NEVER a floating tag (`latest`): the launch gate's credential
// classifications are calibrated against verified proxy behavior, and an upstream push must not change that
// behavior under an unchanged install. This tag CALIBRATES four launch-gate classification points — the
// `auth_unavailable` 503 body shape, the `/v1/models` empty-until-registration boot window, the
// client-key-only 401 on `/v1/models`, and the `count_tokens` `not_found_error` body — established on
// v7.2.77 and re-verified on v7.2.90. BUMP PROCEDURE: change the tag AND the digest together, then
// re-verify those four calibration points against a live container of the new tag (they degrade to
// warn-and-proceed on mismatch by design, but a silent shape change would erode the gate's precision).
// Exported because the one-shot OAuth-login container (setup.ts) must run the SAME pinned build: the
// login writes the credential file the serving proxy loads, so a version skew between the two could
// mint a shape the pinned server does not expect.
export const PROXY_IMAGE = "eceasy/cli-proxy-api:v7.2.90@sha256:6aa1ffb6616bff0b35d76cff89761ee7d54704d33d0c0c4f5ce7f3bffa9d73d2";
const PROXY_CONFIG_PATH = "/CLIProxyAPI/config.yaml";
const PROXY_AUTH_DIR = "/root/.cli-proxy-api";

// Container and network names are environment-aware: `inflexa-*` in production
// builds, `inflexa-dev-*` in dev runs. This prevents a dev session's containers
// from colliding with (or shadowing) a user's installed binary's containers.
const PREFIX = env.isDevelopment ? "inflexa-dev" : "inflexa";
export const PROXY_CONTAINER_NAME = `${PREFIX}-cliproxy`;
export const POSTGRES_CONTAINER_NAME = `${PREFIX}-postgres`;
const NETWORK_NAME = PREFIX;

/** Escape a value for use inside a YAML double-quoted string (`"…"`). */
function escapeYaml(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** The chat-backend connection modes that shape which services the compose file defines. */
export type ConnectionMode = "cliproxy" | "direct";

/**
 * Generate a Docker Compose file for the infra stack. The compose file is YAML; we template it as a
 * string to avoid a YAML dep.
 *
 * Connection-aware: `cliproxy` mode defines BOTH the CLIProxyAPI proxy and Postgres; `direct` mode
 * defines Postgres ONLY — a direct connection reaches the user's own endpoint with
 * `INFLEXA_MODEL_API_KEY`, so the managed proxy is never provisioned. Postgres is mode-independent.
 *
 * Regeneration contract: every compose entry point (`inflexa setup`, the TUI-launch gate
 * `ensureProxyReady`, `inflexa up`, and the Postgres readiness gate `ensurePostgresReady`) rewrites the
 * file from the current configuration via {@link writeComposeFile} before invoking the engine — there is
 * no write-if-missing path. So the file the engine executes and the mount-source manifest the guard
 * provisions ({@link mountManifest}) always derive from the SAME mode in the SAME invocation: a compose
 * file left on disk under an earlier mode can never out-drift the guard, and switching modes rewrites the
 * file coherently — proxy service dropped for direct, present again for cliproxy. `inflexa down` only
 * stops what is running and never rewrites the file.
 */
export function generateComposeFile(conn: PostgresConnection, mode: ConnectionMode): string {
    const proxyService =
        mode === "cliproxy"
            ? `  ${PROXY_CONTAINER_NAME}:
    image: ${PROXY_IMAGE}
    container_name: ${PROXY_CONTAINER_NAME}
    restart: unless-stopped
    ports:
      # Loopback-only: the proxy holds provider credentials, so publish it where only this host can reach it, never the LAN.
      - "127.0.0.1:${env.cliproxyPort}:${env.cliproxyPort}"
    volumes:
      - "${env.cliproxyConfigPath}:${PROXY_CONFIG_PATH}"
      - "${env.cliproxyAuthDir}:${PROXY_AUTH_DIR}"
    networks:
      - ${NETWORK_NAME}

`
            : "";
    return `# Generated by inflexa setup — do not edit by hand.
# Regenerated on every setup run; manual changes will be overwritten.

name: ${PREFIX}
services:
${proxyService}  ${POSTGRES_CONTAINER_NAME}:
    image: ${DEFAULT_IMAGE}
    container_name: ${POSTGRES_CONTAINER_NAME}
    restart: unless-stopped
    ports:
      # Loopback-only: bind to this host alone so the DB (well-known constant creds) is never reachable from the LAN.
      - "127.0.0.1:${conn.port}:${CONTAINER_PG_PORT}"
    environment:
      POSTGRES_DB: "${escapeYaml(conn.database)}"
      POSTGRES_USER: "${escapeYaml(conn.user)}"
      POSTGRES_PASSWORD: "${escapeYaml(conn.password)}"
    volumes:
      - "${env.postgresDataDir}:${CONTAINER_DATA_PATH}"
    networks:
      - ${NETWORK_NAME}

networks:
  ${NETWORK_NAME}:
    driver: bridge
`;
}

/**
 * Write the compose file to `env.composeFilePath` for the given connection mode (see
 * {@link generateComposeFile} for the service set each mode defines). Creates parent dirs. Returns a
 * typed error so the caller can surface it without a try/catch. Always overwrites — this is an
 * authoritative regeneration point, so callers switching modes rewrite the file coherently.
 */
export function writeComposeFile(conn: PostgresConnection, mode: ConnectionMode): Result<void, PostgresError> {
    return Result.fromThrowable(
        () => {
            mkdirSync(dirname(env.composeFilePath), { recursive: true });
            writeFileSync(env.composeFilePath, generateComposeFile(conn, mode));
        },
        (cause): PostgresError => ({
            type: "compose_file_write_failed",
            message: `Failed to write compose file: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    )();
}

function composeArgs(subcommand: string[]): string[] {
    return ["compose", "-f", env.composeFilePath, ...subcommand];
}

// --- mount-source integrity ------------------------------------------------

/**
 * A host-side bind-mount source the compose stack requires, tagged with how to provision it. `file`
 * sources carry a provisioner because their content matters (the proxy config must exist with its
 * canonical bytes); `directory` sources are `mkdir -p`-ed, since an engine-manufactured directory there
 * is indistinguishable from a correctly-provisioned one.
 */
type MountSource = { kind: "file"; path: string; provision: () => Promise<Result<void, InfraStateError>> } | { kind: "directory"; path: string };

/**
 * The bind-mount sources for `mode`, mirroring the volumes {@link generateComposeFile} emits from the
 * SAME mode/connection facts — so the manifest and the compose template cannot drift (a mount added to
 * one without the other is caught by the manifest-coverage test). cliproxy mode adds the proxy config
 * file (provisioned by {@link writeProxyConfig}) and the credential dir; both modes mount the Postgres
 * data dir. Direct mode has no proxy service, so it lists no proxy sources.
 */
export function mountManifest(mode: ConnectionMode): MountSource[] {
    const sources: MountSource[] = [];
    if (mode === "cliproxy") {
        // The guard needs only writeProxyConfig's side-effect (heal/write); discard its created/apiKey
        // outcome to a uniform void Result so every file source has one provisioner shape.
        sources.push({ kind: "file", path: env.cliproxyConfigPath, provision: async () => (await writeProxyConfig()).map((): void => undefined) });
        sources.push({ kind: "directory", path: env.cliproxyAuthDir });
    }
    sources.push({ kind: "directory", path: env.postgresDataDir });
    return sources;
}

/**
 * The mount-source integrity guard — the single seam every compose-up path funnels through (it runs at
 * the top of {@link composeUp}, and `composeUp` requiring `mode` is what makes it impossible for any
 * caller to reach the engine without it). Walks the manifest for `mode` BEFORE the engine is invoked:
 * directory sources are `mkdir -p`-ed; file sources run their provisioner, which heals an empty
 * engine-manufactured directory and refuses a non-empty occupant. This guarantees the engine is never
 * the creator of a mount source — a role in which it would create a directory, wedging the file-typed
 * proxy config with EISDIR on every later write.
 */
export async function ensureMountSources(mode: ConnectionMode): Promise<Result<void, InfraStateError>> {
    for (const source of mountManifest(mode)) {
        if (source.kind === "directory") {
            try {
                await mkdir(source.path, { recursive: true });
            } catch (cause) {
                // Bridge mkdir's throw into the Result channel (neverthrow-first boundary wrapper).
                return err({ type: "io_failed", path: source.path, cause });
            }
        } else {
            const provisioned = await source.provision();
            if (provisioned.isErr()) return err(provisioned.error);
        }
    }
    return ok(undefined);
}

/**
 * Start all services in the compose file (idempotent — already-running services are untouched). Requires
 * the connection `mode` so the mount-source integrity guard runs first: `compose up -d` is the ONE step
 * that manufactures a missing bind-mount source, and the engine always creates it as a DIRECTORY —
 * fatal for the file-typed proxy config. Threading `mode` through this seam (rather than a per-caller
 * guard) is what makes the guard impossible to bypass.
 */
export async function composeUp(rt: ContainerRuntime, mode: ConnectionMode): Promise<Result<void, PostgresError>> {
    const guard = await ensureMountSources(mode);
    if (guard.isErr()) return err({ type: "mount_source_unavailable", message: formatInfraStateError(guard.error) });

    // --remove-orphans: the compose file is regenerated from config at every entry point, so a service
    // dropped by a mode switch (e.g. the proxy vanishing when the connection flips to direct) would
    // otherwise leave its old container running unmanaged — the flag makes the engine reap it.
    const { code, stderr } = await capture(rt, composeArgs(["up", "-d", "--remove-orphans"]));
    if (code !== 0) {
        return err({
            type: "container_start_failed",
            message: `Failed to start containers via compose.${stderr ? `\n  ${stderr.trim()}` : ""}\n  Check that ${rt.label} Compose is installed.`,
        });
    }
    return ok(undefined);
}

/**
 * Restart the proxy service in place. Exists for the launch-time credential probe: after a
 * probe-triggered re-login rewrites the credential file, the RUNNING proxy must observe it before the
 * re-probe — whether the vendor binary hot-reloads its auth dir is fork behavior we cannot verify, so
 * an explicit restart removes the assumption. No mount guard: callers reach this only after a
 * successful `composeUp`, and a restart re-executes the same compose file without recreating sources.
 */
export async function composeRestartProxy(rt: ContainerRuntime): Promise<Result<void, PostgresError>> {
    const { code, stderr } = await capture(rt, composeArgs(["restart", PROXY_CONTAINER_NAME]));
    if (code !== 0) {
        return err({
            type: "container_start_failed",
            message: `Failed to restart the proxy container.${stderr ? `\n  ${stderr.trim()}` : ""}`,
        });
    }
    return ok(undefined);
}

/**
 * Whether the proxy container is currently running. Asks the ENGINE directly (`ps`, not compose):
 * callers need this answer in states where the compose file may not exist yet — setup's auth step
 * runs before this invocation regenerates the file — and `ps` is compose-file-free. The engine's
 * `name=` filter is a substring match, so the verdict requires an exact line match on the reported
 * names. Exists for the fresh-login flows: a running proxy loads credentials only at boot (host
 * writes to the mounted auth dir never reach its file watcher), so a login that lands while one is
 * serving must know whether there is a container to bounce.
 */
export async function composeProxyRunning(rt: ContainerRuntime): Promise<Result<boolean, PostgresError>> {
    const { code, stdout, stderr } = await capture(rt, [
        "ps",
        "--filter",
        `name=${PROXY_CONTAINER_NAME}`,
        "--filter",
        "status=running",
        "--format",
        "{{.Names}}",
    ]);
    if (code !== 0) {
        return err({
            type: "runtime_not_ready",
            message: `Could not read the proxy container state.${stderr ? `\n  ${stderr.trim()}` : ""}`,
        });
    }
    return ok(stdout.split("\n").some((line) => line.trim() === PROXY_CONTAINER_NAME));
}

/** Pull all images in the compose file. */
export async function composePull(rt: ContainerRuntime): Promise<Result<void, PostgresError>> {
    const { code, stderr } = await capture(rt, composeArgs(["pull"]));
    if (code !== 0) {
        return err({
            type: "image_pull_failed",
            image: `${PROXY_IMAGE}, ${DEFAULT_IMAGE}`,
            message: `Failed to pull images via compose.${stderr ? `\n  ${stderr.trim()}` : ""}`,
        });
    }
    return ok(undefined);
}

/**
 * Pull all images in the compose file with inherited stdio so the user sees progress.
 * Used on the TUI launch path where silent buffering would make the app appear to hang.
 */
export async function composePullInteractive(rt: ContainerRuntime): Promise<Result<void, PostgresError>> {
    const code = await inherit(rt, composeArgs(["pull"]));
    if (code !== 0) {
        return err({
            type: "image_pull_failed",
            image: `${PROXY_IMAGE}, ${DEFAULT_IMAGE}`,
            message: `Failed to pull images via compose. Run \`${rt.bin} compose -f ${env.composeFilePath} pull\` manually.`,
        });
    }
    return ok(undefined);
}

/**
 * Pull any compose images that are not already present locally, streaming progress
 * to the terminal. Skips the network round-trip entirely when every image is cached.
 */
export async function composePullIfMissing(rt: ContainerRuntime, mode: ConnectionMode): Promise<Result<void, PostgresError>> {
    // Only the images the compose file for this mode actually defines: direct mode omits the proxy.
    const images = mode === "cliproxy" ? [PROXY_IMAGE, DEFAULT_IMAGE] : [DEFAULT_IMAGE];
    const missing = await Promise.all(
        images.map(async (image) => {
            const { code } = await capture(rt, ["image", "inspect", image]);
            return code !== 0;
        }),
    );
    if (!missing.some(Boolean)) return ok(undefined);

    console.log("  Pulling container images (this may take a moment)…");
    return composePullInteractive(rt);
}

/** Stop and remove all compose-managed containers and the shared network. */
export async function composeDown(rt: ContainerRuntime): Promise<Result<void, PostgresError>> {
    const { code, stderr } = await capture(rt, composeArgs(["down"]));
    if (code !== 0) {
        return err({
            type: "container_stop_failed",
            message: `Failed to stop containers via compose.${stderr ? `\n  ${stderr.trim()}` : ""}`,
        });
    }
    return ok(undefined);
}

/** Check whether the compose subcommand is available for this runtime. */
export async function composeAvailable(rt: ContainerRuntime): Promise<boolean> {
    const { code } = await capture(rt, ["compose", "version"]);
    return code === 0;
}
