/**
 * Shared filesystem helpers — deduplicated SHA-256 hashing and file existence checks.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * Compute SHA-256 hash of in-memory content.
 * Returns `sha256:<hex>` format.
 */
export function computeSha256(content: Buffer | Uint8Array): string {
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * Compute SHA-256 hash of a file on disk.
 * Returns `sha256:<hex>` format.
 */
export async function computeSha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
        stream.on("error", reject);
    });
}

/**
 * True when `hash` is a well-formed `algorithm:hex` content hash. The storage backend
 * (`ValidateContentHash`) rejects any file row without one — and rolls back the
 * whole activity transaction on the first bad row — so this gates what reaches
 * registration. Inputs arrive hashless from the path-only provenance frame and
 * are filled by `reconcileManifestWithDisk`; an empty hash past that point is
 * an attestation invariant violation, not something to paper over.
 */
export function hasValidContentHash(hash: string | undefined): boolean {
    return !!hash && /^[a-z0-9]+:[0-9a-f]+$/i.test(hash);
}

/**
 * Check whether a file exists (access-based, no stat overhead).
 */
export async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Write a file that MUST land physically inside the analysis workspace tree,
 * refusing every symlink escape a sandbox step could have planted.
 *
 * The harness runs some post-step writes (a step's `output/summary.md`, a run's
 * `synthesis.json`) in the HOST process, into the same `runs/{runId}/{stepId}`
 * subtree the sandbox agent held read-write. A plain `fs.writeFile` follows
 * symlinks, so a compromised agent that replaced the leaf — or an intermediate
 * directory — with a symlink to `~/.ssh/authorized_keys` (or any host path)
 * would have the harness write model-authored bytes straight through it. This
 * relocation made that worse: the tree now lives in the user's own project
 * folder, so a short relative symlink reaches their source.
 *
 * Two independent checks, because an escape can hide in either place:
 *   1. `realpath` the materialized parent directory and require it to stay under
 *      `realpath(workspaceRoot)` — catches a symlinked intermediate dir
 *      (`output -> /elsewhere`).
 *   2. Open the leaf with `O_NOFOLLOW` — a symlinked final component fails with
 *      `ELOOP` instead of being followed. This is atomic, so it is not
 *      TOCTOU-racy the way an `lstat`-then-open would be.
 *
 * Throws on any escape (a security-invariant violation, like `assertSafeId`) and
 * on genuine I/O failure; the caller decides whether that is fatal or best-effort.
 */
export async function writeFileWithinRoot(workspaceRoot: string, absPath: string, data: string | Uint8Array): Promise<void> {
    // Cheap lexical gate first, before any disk touch — rejects a `../` target
    // without paying for the mkdir/realpath below. Both sides stay un-canonicalized
    // so the comparison is consistent (canonicalizing only one would mismatch on a
    // symlinked temp root like macOS's `/var` → `/private/var`).
    const lexicalRoot = resolve(workspaceRoot);
    const target = resolve(absPath);
    if (target !== lexicalRoot && !target.startsWith(lexicalRoot + sep)) {
        throw new Error(`writeFileWithinRoot: refusing to write outside the workspace root: ${absPath}`);
    }

    const dir = dirname(target);
    await mkdir(dir, { recursive: true });
    // Physical gate: canonicalize BOTH sides so a symlinked intermediate dir
    // (`output -> /elsewhere`) is caught regardless of any symlink on the trusted
    // root's own path.
    const realRoot = await realpath(workspaceRoot);
    const realDir = await realpath(dir);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
        throw new Error(`writeFileWithinRoot: parent directory escapes the workspace root via a symlink: ${absPath}`);
    }

    // `O_NOFOLLOW ?? 0`: the flag is defined on Linux/macOS (the harness host
    // platforms); the `?? 0` keeps the open valid on a platform that lacks it
    // rather than NaN-ing the flag mask.
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0);
    const fh = await open(target, flags, 0o644);
    try {
        await fh.writeFile(data);
    } finally {
        await fh.close();
    }
}
