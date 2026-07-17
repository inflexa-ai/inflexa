/**
 * Reconcile a step's artifact manifest against the on-disk workspace tree.
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
 *   2. Hash + size every surviving entry from disk. The exec frame that
 *      `feedExecFrame` folds in reports write paths without a content hash,
 *      and any hash taken at frame time would be racy with respect to what
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
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { computeSha256File, hasValidContentHash } from "../lib/fs-helpers.js";
import { artifactReconcileDropped, lineageInputDropped } from "../lib/metrics.js";

export interface ReconcileManifestInput {
    /** Absolute host root of the analysis's workspace tree. */
    workspaceRoot: string;
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
    /**
     * Operational logging seam; omitted falls back to no-op. What this records
     * — which entry or input was dropped, which input could not be hashed — is
     * the sole account of why lineage changed or a step died.
     */
    logger?: Logger;
}

export interface ReconcileManifestResult {
    /** Reconciled manifest — phantoms removed, every entry rehashed from disk. */
    manifest: ArtifactManifestEntry[];
    /** Number of entries dropped because their file was missing. */
    droppedCount: number;
}

export async function reconcileManifestWithDisk(input: ReconcileManifestInput): Promise<ReconcileManifestResult> {
    const { workspaceRoot, resourceId, runId, stepId, agentId, manifest, collector } = input;
    const logger = (input.logger ?? createNoopLogger()).named("reconcile-manifest").with({ runId, stepId, agentId });
    const stepRoot = path.join(workspaceRoot, "runs", runId, stepId);

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
            logger.warn("skipping out-of-bounds entry", { path: entry.path });
            continue;
        }
        let info;
        try {
            info = await stat(absPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                logger.debug("dropping phantom entry", { path: entry.path });
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
            logger.debug("dropping non-file entry", { path: entry.path });
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

    await fillInputHashesFromDisk(collector, workspaceRoot, resourceId, runId, stepId, agentId, logger);

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
 * Lineage attestation is fail-fast for drift: an input that should be on disk
 * and is not (ENOENT) throws rather than registering a hashless edge. A read
 * that resolves OUTSIDE the analysis tree is dropped from lineage instead —
 * the sandbox can legitimately open paths above its mount (`/{resourceId}/..`
 * is the container root) and a capture layer may report them; that is out of
 * scope, not drift, and failing the step over it killed real analyses in the
 * field. Dropping still registers no hashless edge, which is the invariant.
 */
async function fillInputHashesFromDisk(
    collector: ProvenanceCollector,
    workspaceRoot: string,
    resourceId: string,
    runId: string,
    stepId: string,
    agentId: string,
    logger: Logger,
): Promise<void> {
    const resourceRoot = path.resolve(workspaceRoot);

    for (const ref of collector.getTrackedInputs()) {
        if (ref.source === "artifacts") continue;
        if (hasValidContentHash(ref.hash)) continue;

        // Every throw below is logged before it is raised, and every drop is
        // logged as it happens. The thrown message reaches `failStep` as one
        // opaque string and everything downstream of that is scrubbed, so naming
        // the site and the offending ref HERE is the only account of why a step
        // died — the read's `source` in particular says whether the step declared
        // this input at all.
        const attestation = { path: ref.path, source: ref.source, refRunId: ref.runId, refStepId: ref.stepId };

        // `ref.path` is the absolute container path `/{resourceId}/...`; strip the
        // mount segment and map the tail onto the host workspace root. `path.join`
        // normalizes any `..`, and the bound confines the read to the analysis tree.
        // An out-of-tree resolution is dropped, not thrown: it is not an attestable
        // lineage edge, but it is also not drift — mirrors the out-of-bounds output
        // skip in `reconcileManifestWithDisk` and the directory drop below.
        const containerPrefix = `/${resourceId}`;
        if (ref.path !== containerPrefix && !ref.path.startsWith(containerPrefix + "/")) {
            logger.warn("dropping out-of-tree input from lineage", { ...attestation, boundSite: "container-prefix" });
            lineageInputDropped.add(1, { agent_id: agentId, step_id: stepId, reason: "container-prefix" });
            collector.dropInput(ref);
            continue;
        }
        const hostPath = path.join(resourceRoot, ref.path.slice(containerPrefix.length + 1));
        if (hostPath !== resourceRoot && !hostPath.startsWith(resourceRoot + path.sep)) {
            logger.warn("dropping out-of-tree input from lineage", { ...attestation, hostPath, boundSite: "workspace-root" });
            lineageInputDropped.add(1, { agent_id: agentId, step_id: stepId, reason: "workspace-root" });
            collector.dropInput(ref);
            continue;
        }

        let info;
        try {
            info = await stat(hostPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                logger.error("cannot attest input — not present at reconcile", { ...attestation, hostPath, throwSite: "input-enoent" });
                throw new Error(`[reconcile-manifest] cannot attest input ${ref.path}: not present at reconcile (stepId=${stepId} runId=${runId})`, {
                    cause: err,
                });
            }
            logger.error("cannot attest input — stat failed", { ...attestation, hostPath, throwSite: "input-stat", ...logger.errorFields(err) });
            throw err;
        }
        if (!info.isFile()) {
            // A directory read (e.g. `ls` / `list.files` of a mount) is tracked by
            // the inotify frame but is not a content-attestable file artifact. Drop
            // it from lineage rather than failing the step — mirrors the output-side
            // non-file drop above. A genuinely missing FILE (ENOENT) still fails fast
            // as drift; a directory is not drift.
            logger.debug("dropping non-file input from lineage", attestation);
            lineageInputDropped.add(1, { agent_id: agentId, step_id: stepId, reason: "directory" });
            collector.dropInput(ref);
            continue;
        }

        ref.hash = await computeSha256File(hostPath);
    }
}
