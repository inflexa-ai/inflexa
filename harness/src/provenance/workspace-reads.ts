/**
 * The lineage of the workspace reads of a step agent.
 *
 * `read_file`, `grep`, and `read_pdf` read on the host, outside each sandbox exec, thus no exec frame names their
 * reads. A tool puts its reads into its call record, and its `foldCallRecord` gives them to the collector of the step.
 * Thus a replay, which runs no `execute`, rebuilds the same inputs.
 */

import { createNoopLogger } from "../lib/console-logger.js";
import { computeSha256 } from "../lib/fs-helpers.js";
import type { Logger } from "../lib/logger.js";
import { resolveWorkspacePath } from "../workspace/paths.js";
import type { ProvenanceCollector } from "./collector.js";

/**
 * One file whose content a read tool gave to the agent. `path` is analysis-relative. `hash` is the SHA-256 of the
 * whole file, or `null` when the tool held only a part of it.
 */
export type WorkspaceRead = { readonly path: string; readonly hash: string | null };

/** The call record of a read tool. */
export type WorkspaceReadRecord = { readonly reads: readonly WorkspaceRead[] };

export type WorkspaceReadLineage = {
    /** The read of `path`, as the tool gave it to the read seam. `wholeFile` is the bytes of the whole file, or `null` for a part. */
    readOf(path: string, wholeFile: Buffer | null): WorkspaceRead | undefined;
    /** Track the reads of one call in the collector of the step. */
    track(reads: readonly WorkspaceRead[]): void;
};

export type WorkspaceReadLineageDeps = {
    readonly collector: ProvenanceCollector;
    readonly workspaceRoot: string;
    readonly analysisId: string;
    /** The host base of a relative path, the same that the read tools give to the read seam. */
    readonly workingDir: string;
    readonly logger?: Logger;
};

export function createWorkspaceReadLineage(deps: WorkspaceReadLineageDeps): WorkspaceReadLineage {
    const { collector, workspaceRoot, analysisId, workingDir } = deps;
    // The mount root of `execute_command`, thus a file that an exec and a read tool read is one input.
    const mountRoot = `/${analysisId}`;
    const logger = (deps.logger ?? createNoopLogger()).named("workspace-reads");
    return {
        readOf(path, wholeFile) {
            const resolved = resolveWorkspacePath({ workspaceRoot, analysisId, path, workingDir });
            if (resolved.kind !== "ok") return undefined;
            // A hash of a part names no version of the file. Reconcile hashes the file from disk instead.
            return { path: resolved.relative.split("\\").join("/"), hash: wholeFile === null ? null : computeSha256(wholeFile) };
        },
        track(reads) {
            for (const read of reads) {
                if (collector.trackInputAccess(mountRoot, read.path, read.hash) !== null) continue;
                if (collector.claimRefusalNarration(read.path)) logger.warn("refusing lineage edge to an undeclared same-run path", { path: read.path });
            }
        },
    };
}
