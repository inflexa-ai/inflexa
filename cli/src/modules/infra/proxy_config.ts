import { type Stats } from "node:fs";
import { lstat, mkdir, readdir, rmdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type Result, ok, err } from "neverthrow";
import { env } from "../../lib/env.ts";

// The CLIProxyAPI proxy config (`config.yaml`) and the provider-credential dir are host-side state we
// own; the compose stack bind-mounts them into the proxy container. This module provisions the config
// file and is imported by BOTH setup.ts (the interactive flow) and compose.ts (the mount-source
// integrity guard baked into the compose-up seam) — the multi-caller threshold that earns it a file of
// its own. It sits BELOW compose.ts in the import graph (compose imports it, never the reverse): the
// provisioner cannot live in setup.ts, because setup.ts already imports compose.ts, so a provisioner
// there would force a compose→setup back-edge the seam design exists to avoid.

/**
 * In-container path of the provider-credential dir, mounted from {@link env.cliproxyAuthDir}. Embedded
 * verbatim in the generated config so the proxy reads credentials from the mount. It is a Linux path
 * (the container filesystem), OS-independent of the host.
 */
const CONTAINER_AUTH_DIR = "/root/.cli-proxy-api";

/**
 * What kind of entry occupies a path a file belongs at. Carried on {@link InfraStateError} so the
 * diagnosis names the actual occupant instead of assuming a directory: a `non_empty_directory` is the
 * engine-manufactured-then-populated case, a `symlink` is never followed or deleted, and `other` covers a
 * socket/device/FIFO — anything neither our regular file nor a healable empty directory.
 */
export type OccupantKind = "non_empty_directory" | "symlink" | "other";

/**
 * Diagnosable filesystem faults from provisioning a mount source, carried on the `Result` channel so raw
 * errno text (`EISDIR`, `EACCES`) never reaches the user from a known-cause state.
 *
 * - `path_occupied` — the inviolable case: an entry we did NOT just create sits where a file belongs. It
 *   carries {@link OccupantKind} so the rendered message describes what is actually there. The CLI refuses
 *   to delete it.
 * - `io_failed` — an unexpected throw from the fs primitive; carries the underlying cause for the
 *   last-resort message.
 */
export type InfraStateError =
    { type: "io_failed"; path: string; cause: unknown } | { type: "path_occupied"; path: string; expected: "file" | "directory"; occupant: OccupantKind };

/**
 * Outcome of {@link writeProxyConfig}: a fresh write yields the minted client key so the caller can show
 * it once; an existing file was left untouched and carries nothing. A discriminated union (not an
 * optional `apiKey`) so the key is only reachable on the branch that produced it.
 */
export type WriteProxyConfigOutcome = { created: false } | { created: true; apiKey: string };

/**
 * Bridge a throwing async fs primitive into the `Result` channel as an `io_failed` naming the path. This
 * is the sanctioned use of `try/catch` (its only job is turning a throw into an `Err`, never swallowing
 * it) — the neverthrow-first policy's boundary wrapper for stdlib calls that throw.
 */
async function tryFs<T>(path: string, op: () => Promise<T>): Promise<Result<T, InfraStateError>> {
    try {
        return ok(await op());
    } catch (cause) {
        return err({ type: "io_failed", path, cause });
    }
}

/**
 * What currently occupies a path. Decided by {@link lstat} so a symlink is never mistaken for our file.
 * `occupied` carries the {@link OccupantKind} so the caller can name what it found, not assume a
 * directory; the other three states carry nothing.
 */
type PathOccupant = { kind: "absent" } | { kind: "file" } | { kind: "empty_dir" } | { kind: "occupied"; occupant: OccupantKind };

/**
 * Classify what sits at `path`. `absent` (ENOENT) is the normal fresh-install case — in-band on the ok
 * channel, not a fault. Only a genuinely empty directory is `empty_dir`, the one healable
 * engine-manufactured artifact. Everything else is `occupied` and inviolable, tagged with what it is: a
 * symlink (checked first, since {@link lstat} does not follow it — so we never touch its target), a
 * non-empty directory, or any other node type (socket/device/FIFO).
 */
async function classifyPath(path: string): Promise<Result<PathOccupant, InfraStateError>> {
    let stats: Stats;
    try {
        stats = await lstat(path);
    } catch (cause) {
        // ENOENT means "nothing here yet" — the ordinary fresh state, so it travels the ok channel; any
        // other throw is a real IO fault. `cause` is unknown, so read the errno discriminant defensively:
        // a throw without a `.code` string simply isn't ENOENT and correctly falls through to io_failed.
        const code = (cause as { code?: unknown } | null)?.code;
        if (code === "ENOENT") return ok({ kind: "absent" });
        return err({ type: "io_failed", path, cause });
    }
    // Symlink first: lstat reports the link itself (isFile/isDirectory both false for it), so classifying
    // it before those checks is what keeps the link unfollowed and names it as a symlink downstream.
    if (stats.isSymbolicLink()) return ok({ kind: "occupied", occupant: "symlink" });
    if (stats.isFile()) return ok({ kind: "file" });
    if (stats.isDirectory()) {
        const entries = await tryFs(path, () => readdir(path));
        return entries.map((names) => (names.length === 0 ? { kind: "empty_dir" } : { kind: "occupied", occupant: "non_empty_directory" }));
    }
    return ok({ kind: "occupied", occupant: "other" });
}

/**
 * Provision the proxy config file, converging any partial or damaged state to a correct file:
 *
 * - absent          → write the config with a freshly minted client key (`created: true`)
 * - existing file   → left untouched (`created: false`); idempotent, never rewritten
 * - EMPTY directory → the engine-manufactured artifact (a missing bind-mount source the container engine
 *   created as a directory): `rmdir` it — and `rmdir` CANNOT remove a non-empty directory, so that
 *   inability IS the safety guarantee — then write the file
 * - anything else   → `path_occupied`; the CLI refuses to delete state it did not just create
 *
 * The parent config dir and the credential dir are ensured (0700) first; the file is written 0600. Every
 * failure travels the `Result` channel — this function never throws, so callers translate known causes
 * into remediation instead of a raw errno reaching them through a backstop.
 */
export async function writeProxyConfig(): Promise<Result<WriteProxyConfigOutcome, InfraStateError>> {
    const configPath = env.cliproxyConfigPath;
    const configDir = dirname(configPath);

    const parent = await tryFs(configDir, () => mkdir(configDir, { recursive: true, mode: 0o700 }));
    if (parent.isErr()) return err(parent.error);
    const auth = await tryFs(env.cliproxyAuthDir, () => mkdir(env.cliproxyAuthDir, { recursive: true, mode: 0o700 }));
    if (auth.isErr()) return err(auth.error);

    const occupant = await classifyPath(configPath);
    if (occupant.isErr()) return err(occupant.error);

    switch (occupant.value.kind) {
        case "file":
            return ok({ created: false });
        case "absent":
            return writeFreshConfig(configPath);
        case "empty_dir": {
            const healed = await tryFs(configPath, () => rmdir(configPath));
            if (healed.isErr()) return err(healed.error);
            return writeFreshConfig(configPath);
        }
        case "occupied":
            // Carry what actually occupies the path so the diagnosis fits it — a symlink is not "not empty".
            return err({ type: "path_occupied", path: configPath, expected: "file", occupant: occupant.value.occupant });
        default: {
            // Exhaustive: every PathOccupant is handled above; a new member breaks the build here rather
            // than silently falling through (the sanctioned exhaustive-switch bail-out).
            const unreachable: never = occupant.value;
            throw new Error(`unhandled path occupant: ${String(unreachable)}`);
        }
    }
}

/** Mint a client key and write the config 0600. Shared by the absent and healed paths. */
async function writeFreshConfig(path: string): Promise<Result<WriteProxyConfigOutcome, InfraStateError>> {
    const apiKey = generateApiKey();
    const written = await tryFs(path, () => writeFile(path, proxyConfig(apiKey), { mode: 0o600 }));
    return written.map(() => ({ created: true, apiKey }));
}

/**
 * Render a known filesystem-state fault as the specific diagnosis plus the exact remediation, naming the
 * offending path. Shared by every consumer (setup's inline call, the compose-seam guard) so the same
 * remediation reaches the user wherever provisioning failed — never a raw errno string.
 */
export function formatInfraStateError(e: InfraStateError): string {
    switch (e.type) {
        case "path_occupied":
            return `${e.path} already exists but is not the ${e.expected} inflexa expects there. ${occupantSentence(e.occupant)} Move or remove it, then re-run.`;
        case "io_failed":
            return `Could not provision ${e.path}: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`;
        default: {
            const unreachable: never = e;
            throw new Error(`unhandled infra-state error: ${String(unreachable)}`);
        }
    }
}

/**
 * The occupant-specific middle sentence of a {@link formatInfraStateError} `path_occupied` message. Kept
 * separate so the "not empty" phrasing is reachable ONLY for a non-empty directory — a symlink or a
 * socket/device must never be described with prose that only fits a directory. Every branch states that
 * inflexa will not delete the occupant (it refuses to remove state it did not create).
 */
function occupantSentence(occupant: OccupantKind): string {
    switch (occupant) {
        case "non_empty_directory":
            // A container engine manufactures a directory when left to create a missing file-typed mount
            // source; a non-empty one already holds state inflexa did not create, so it is inviolable.
            return "It is a directory and is not empty, so inflexa will not touch it.";
        case "symlink":
            return "It is a symlink, which inflexa will not follow or delete.";
        case "other":
            return "It is not a regular file (e.g. a socket or device), so inflexa will not touch it.";
        default: {
            const unreachable: never = occupant;
            throw new Error(`unhandled occupant kind: ${String(unreachable)}`);
        }
    }
}

/**
 * auth-dir is the in-container Linux path (mounted from env.cliproxyAuthDir), so
 * it is OS-safe regardless of the host.
 */
export function proxyConfig(apiKey: string): string {
    return `host: ""
port: ${env.cliproxyPort}
auth-dir: "${CONTAINER_AUTH_DIR}"
api-keys:
  - "${apiKey}"
debug: false
`;
}

/**
 * Client-facing key for calling the proxy — distinct from the provider
 * credentials the login flows write under auth-dir.
 */
export function generateApiKey(): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const rand = new Uint8Array(45);
    crypto.getRandomValues(rand);
    let key = "sk-";
    for (const b of rand) key += chars[b % chars.length];
    return key;
}
