import { type Stats } from "node:fs";
import { link, lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { randomUUIDv7 } from "bun";

import { type Result, ok, err } from "neverthrow";

// Classify-and-heal machinery for a FILE-typed host bind-mount source, shared by the stack's file
// provisioners (the CLIProxyAPI config of proxy_config.ts and the SearXNG settings of
// searxng_config.ts). A file-typed mount source has one hazard a directory source does not: a
// container engine left to create the missing source makes a DIRECTORY, which wedges every later
// write with EISDIR. The classify/heal skeleton here is what lets the compose guard promise "the file
// exists as a file before the engine runs" — no provisioner reimplements it. It sits BELOW both
// provisioners in the import graph, and compose.ts imports it too (it renders `InfraStateError` for
// the user).

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
 * Bridge a throwing async fs primitive into the `Result` channel as an `io_failed` naming the path. This
 * is the sanctioned use of `try/catch` (its only job is turning a throw into an `Err`, never swallowing
 * it) — the neverthrow-first policy's boundary wrapper for stdlib calls that throw.
 */
export async function tryFs<T>(path: string, op: () => Promise<T>): Promise<Result<T, InfraStateError>> {
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
export async function classifyPath(path: string): Promise<Result<PathOccupant, InfraStateError>> {
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
 * Converge the path of a file-typed mount source to "a regular file exists there":
 *
 * - absent          → `writeFresh()` runs
 * - existing file   → `onExisting()` runs — the caller owns what an existing file owes it (the proxy
 *   config gains a management key; the SearXNG settings are kept exactly as the user left them)
 * - EMPTY directory → the engine-manufactured artifact (a missing bind-mount source the container engine
 *   created as a directory): `rmdir` it — and `rmdir` CANNOT remove a non-empty directory, so that
 *   inability IS the safety guarantee — then `writeFresh()` runs
 * - anything else   → `path_occupied`; the CLI refuses to delete state it did not just create
 *
 * `writeFresh` is the caller's first write, so it owns the content and the atomicity policy; this
 * function holds only the classify/heal skeleton each provisioner would otherwise copy.
 */
export async function ensureFileMountSource<T>(
    path: string,
    onExisting: () => Promise<Result<T, InfraStateError>>,
    writeFresh: () => Promise<Result<T, InfraStateError>>,
): Promise<Result<T, InfraStateError>> {
    const occupant = await classifyPath(path);
    if (occupant.isErr()) return err(occupant.error);

    switch (occupant.value.kind) {
        case "file":
            return onExisting();
        case "absent":
            return writeFresh();
        case "empty_dir": {
            const healed = await tryFs(path, () => rmdir(path));
            if (healed.isErr()) return err(healed.error);
            return writeFresh();
        }
        case "occupied":
            // Carry what actually occupies the path so the diagnosis fits it — a symlink is not "not empty".
            return err({ type: "path_occupied", path, expected: "file", occupant: occupant.value.occupant });
        default: {
            // Exhaustive: every PathOccupant is handled above; a new member breaks the build here rather
            // than silently falling through (the sanctioned exhaustive-switch bail-out).
            const unreachable: never = occupant.value;
            throw new Error(`unhandled path occupant: ${String(unreachable)}`);
        }
    }
}

/**
 * Publish a first write at `path` through a per-call temp file and an exclusive `link`. `link` refuses
 * an existing target (EEXIST), so when two calls both classified the path absent the first publisher
 * wins and the loser discards only its own temp file, byte-untouched on the winner — a `rename` would
 * let the second call replace the first's one-time key. The temp name is per-call because concurrent
 * calls that share one temp path would clobber each other's bytes before the publish even runs.
 * `writeTmp` owns the content and the mode; the link keeps both, because it adds a name for the temp
 * inode rather than writing a new one.
 */
export async function publishFileExclusively(
    path: string,
    writeTmp: (tmp: string) => Promise<Result<void, InfraStateError>>,
): Promise<Result<void, InfraStateError>> {
    const tmp = `${path}.${randomUUIDv7()}.tmp`;
    const written = await writeTmp(tmp);
    if (written.isErr()) return err(written.error);

    const linked = await tryFs(path, () => link(tmp, path));
    if (linked.isErr()) {
        // The cause is unknown, so read the errno discriminant defensively: a throw without a `.code`
        // string simply isn't EEXIST and correctly falls through as the io_failed it wrapped.
        const cause = linked.error.type === "io_failed" ? linked.error.cause : null;
        const code = (cause as { code?: unknown } | null)?.code;
        if (code !== "EEXIST") return err(linked.error);
    }
    // The winner reaps the temp name the link left behind; a loser reaps the file it never published.
    return (await tryFs(tmp, () => unlink(tmp))).map((): void => undefined);
}

/**
 * Render a known filesystem-state fault as the specific diagnosis plus the exact remediation, naming the
 * offending path. Shared by every consumer (setup's inline call, the compose-up guard) so the same
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
