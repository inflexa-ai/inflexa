/**
 * Post-step helper — disk-walk of a step's writable artifact directory.
 *
 * The step's runtime input/script lineage rides on the step-scoped
 * `ProvenanceCollector` the sandbox-step body threads through
 * `PostStepContext` (fed per-exec during the agent loop). This module only
 * owns the manifest source: walking the writable step dir and hashing each
 * file from disk.
 */

import { readdir, stat as fsStat } from "node:fs/promises";
import { join, relative } from "node:path";

import { inferArtifactType, type ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import { computeSha256File } from "../lib/fs-helpers.js";
import { IGNORED_DIRS } from "../sandbox/ignored-dirs.js";

/**
 * Walk a step's writable artifact directory and produce a fully-hashed
 * `ArtifactManifestEntry[]`. Skips IGNORED_DIRS. Paths are relative to
 * `writePrefix`.
 */
export async function walkStepArtifacts(args: {
    readonly writePrefix: string;
    readonly stepId: string;
    readonly runId: string;
}): Promise<ArtifactManifestEntry[]> {
    const { writePrefix, stepId, runId } = args;
    const out: ArtifactManifestEntry[] = [];

    async function walk(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return;
            throw err;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name)) continue;
                await walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            const relPath = relative(writePrefix, full);
            let info;
            try {
                info = await fsStat(full);
            } catch {
                continue;
            }
            const hash = await computeSha256File(full);
            out.push({
                stepId,
                runId,
                path: relPath,
                size: info.size,
                type: inferArtifactType(relPath),
                hash,
            });
        }
    }

    await walk(writePrefix);
    return out;
}
