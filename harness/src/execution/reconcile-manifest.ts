/**
 * Reconcile a step's artifact manifest against the on-disk session directory.
 *
 * Runs after the sandbox is destroyed and before any artifact is synced to
 * permanent storage. Two responsibilities:
 *
 *   1. Drop phantom entries — `ProvenanceCollector` records writes but not
 *      deletions, so an agent that writes-then-deletes (or a sandbox-side
 *      `rm`/`mv`) leaves entries pointing at files that no longer exist.
 *      Phantoms are dropped from the manifest and removed from the
 *      collector so the structured registration payload agrees.
 *
 *   2. Hash + size every surviving entry from disk. The frame-time hash
 *      captured by `processProvenanceFrame` is racy with respect to what
 *      the file becomes by the time it's registered (long-running scripts
 *      flush after the frame fires; atomic-rename patterns swap content
 *      under a stable byte count). Hashing here makes
 *      `study.artifacts.hash` equal `sha256sum` of the bytes the sync target
 *      will receive at upload time — the equivalence `SyncConfirm` checks.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import type { ProvenanceCollector } from "../provenance/collector.js";
import { computeSha256File, hasValidContentHash } from "../lib/fs-helpers.js";
import { artifactReconcileDropped } from "../lib/metrics.js";

export interface ReconcileManifestInput {
    /** Absolute filesystem root for analysis sessions (`sessionsBasePath()`). */
    sessionPath: string;
    /** Analysis (resource) ID. */
    resourceId: string;
    /** Run ID owning this step. */
    runId: string;
    /** Step ID — the writable mount segment for this step's artifacts. */
    stepId: string;
    /** Agent ID — used for metric tagging only. */
    agentId: string;
    /** Draft manifest from `buildManifestFromCollector`. */
    manifest: ArtifactManifestEntry[];
    /** Collector backing the manifest; mutated to reflect drops/rehashes. */
    collector: ProvenanceCollector;
}

export interface ReconcileManifestResult {
    /** Reconciled manifest — phantoms removed, every entry rehashed from disk. */
    manifest: ArtifactManifestEntry[];
    /** Number of entries dropped because their file was missing. */
    droppedCount: number;
}

export async function reconcileManifestWithDisk(input: ReconcileManifestInput): Promise<ReconcileManifestResult> {
    const { sessionPath, resourceId, runId, stepId, agentId, manifest, collector } = input;
    const stepRoot = path.join(sessionPath, resourceId, "runs", runId, stepId);

    const reconciled: ArtifactManifestEntry[] = [];
    let droppedCount = 0;

    for (const entry of manifest) {
        const absPath = path.join(stepRoot, entry.path);
        // Bounds check: an entry.path containing `..` segments resolves
        // outside stepRoot (e.g. `../../etc/passwd` → `/etc/passwd`). Without
        // this guard a stat outside the step's writable mount could either
        // ENOENT and silently drop a real artifact, or — worse — succeed
        // against a host file the step never produced.
        if (!absPath.startsWith(stepRoot + path.sep) && absPath !== stepRoot) {
            console.warn(`[reconcile-manifest] skipping out-of-bounds path=${entry.path} stepId=${stepId} runId=${runId}`);
            continue;
        }
        let info;
        try {
            info = await stat(absPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                console.debug(`[reconcile-manifest] dropping phantom path=${entry.path} stepId=${stepId} runId=${runId}`);
                collector.removeRecord(entry.path);
                droppedCount++;
                artifactReconcileDropped.add(1, { agent_id: agentId, step_id: stepId });
                continue;
            }
            throw err;
        }

        // Drop directories — they can slip in via tracer frames that don't
        // distinguish file vs directory writes (e.g. `mkdir`). `computeSha256File`
        // uses `createReadStream`, which throws `EISDIR` on directories and would
        // fail the whole step's reconciliation.
        if (!info.isFile()) {
            console.debug(`[reconcile-manifest] dropping non-file path=${entry.path} stepId=${stepId} runId=${runId}`);
            collector.removeRecord(entry.path);
            droppedCount++;
            artifactReconcileDropped.add(1, { agent_id: agentId, step_id: stepId });
            continue;
        }

        // The registration payload reads output hashes from `entries` (this
        // returned manifest), not from the collector — the managed registration
        // adapter builds the structured payload from it. So we
        // don't need to mirror the rehash back into the collector; the
        // collector's outputHash for an output path goes unread after this.
        const hash = await computeSha256File(absPath);
        reconciled.push({ ...entry, hash, size: info.size });
    }

    await fillInputHashesFromDisk(collector, sessionPath, resourceId, runId, stepId);

    return { manifest: reconciled, droppedCount };
}

/**
 * Content-attest the step's inputs (see the artifact-manifest spec). The path-only provenance frame
 * gives every input ref an empty hash; inputs are immutable for the step (the
 * analysis tree is mounted read-only, the step writes only under its own
 * `runs/{runId}/{stepId}`), so a hash from disk now equals the bytes the script
 * read. Mutates the live refs in place — they are shared with the records the
 * registration payload reads.
 *
 * `artifacts`-source reads are the step's OWN files (mutating, dropped by the
 * registration translator), so they are not attested and not hashed here.
 * Lineage attestation is fail-fast: an input we cannot hash (gone, or resolving
 * outside the analysis tree) throws rather than registering a hashless edge.
 */
async function fillInputHashesFromDisk(collector: ProvenanceCollector, sessionPath: string, resourceId: string, runId: string, stepId: string): Promise<void> {
    const resourceRoot = path.join(sessionPath, resourceId);

    for (const ref of collector.getTrackedInputs()) {
        if (ref.source === "artifacts") continue;
        if (hasValidContentHash(ref.hash)) continue;

        // `ref.path` is the absolute container path `/{resourceId}/...`; map it onto
        // the host session tree. `path.join` normalizes any `..`, and the bound
        // confines the read to the analysis tree.
        const hostPath = path.join(sessionPath, ref.path);
        if (hostPath !== resourceRoot && !hostPath.startsWith(resourceRoot + path.sep)) {
            throw new Error(`[reconcile-manifest] input read resolves outside the analysis tree: path=${ref.path} stepId=${stepId} runId=${runId}`);
        }

        let info;
        try {
            info = await stat(hostPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new Error(`[reconcile-manifest] cannot attest input ${ref.path}: not present at reconcile (stepId=${stepId} runId=${runId})`);
            }
            throw err;
        }
        if (!info.isFile()) {
            // A directory read (e.g. `ls` / `list.files` of a mount) is tracked by
            // the inotify frame but is not a content-attestable file artifact. Drop
            // it from lineage rather than failing the step — mirrors the output-side
            // non-file drop above. A genuinely missing FILE (ENOENT) still fails fast
            // as drift; a directory is not drift.
            collector.dropInput(ref);
            continue;
        }

        ref.hash = await computeSha256File(hostPath);
    }
}
