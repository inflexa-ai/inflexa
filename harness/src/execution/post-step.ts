/**
 * Post-step helper — disk-walk of a step's writable artifact directory.
 *
 * The step's runtime input/script lineage rides on the step-scoped
 * `ProvenanceCollector` the sandbox-step body threads through
 * `PostStepContext` (fed per-exec during the agent loop). This module only
 * owns the manifest source: walking the step directory (the work directory of
 * the agent and the summary of the host) and hashing each file from disk.
 */

import { readdir, stat as fsStat } from "node:fs/promises";
import { join, relative } from "node:path";

import { inferArtifactType, type ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import { computeSha256File } from "../lib/fs-helpers.js";
import { IGNORED_DIRS } from "../sandbox/ignored-dirs.js";
import { errnoOf } from "../lib/fs-result.js";
import { STEP_SUMMARY_FILE } from "../workspace/paths.js";

/**
 * Walk a step directory and produce a fully-hashed `ArtifactManifestEntry[]`.
 * Skips IGNORED_DIRS, and the summary of the host: the summary is written after
 * the walk, and the registration adds it with its own role. Paths are relative
 * to `stepDir`.
 */
export async function walkStepArtifacts(args: { readonly stepDir: string; readonly stepId: string; readonly runId: string }): Promise<ArtifactManifestEntry[]> {
    const { stepDir, stepId, runId } = args;
    const out: ArtifactManifestEntry[] = [];

    async function walk(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
            if (errnoOf(err) === "ENOENT") return;
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
            const relPath = relative(stepDir, full);
            if (relPath === STEP_SUMMARY_FILE) continue;
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

    await walk(stepDir);
    return out;
}
