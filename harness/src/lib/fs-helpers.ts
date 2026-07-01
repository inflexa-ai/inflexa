/**
 * Shared filesystem helpers — deduplicated SHA-256 hashing and file existence checks.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";

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
