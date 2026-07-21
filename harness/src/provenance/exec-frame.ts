/**
 * Feed a sandbox-server exec provenance frame into the step's
 * `ProvenanceCollector`.
 *
 * Frame paths are absolute container paths under the analysis resource
 * mount (`/{resourceId}/...`). This helper strips the mount prefix to
 * analysis-relative (`data/...`, `runs/{runId}/{stepId}/...`,
 * `runs/{priorRunId}/...`) so `classifyReadPath` and the collector's
 * `stepPrefix` normalization see the shapes they expect.
 *
 * A read naming a producing step that was not observed `completed` when this
 * exec was submitted is refused here, before it reaches the collector: a ref
 * the collector never holds cannot become an attestation target, so the edge is
 * unrepresentable rather than merely filtered downstream. Every refusal is
 * logged and counted: an edge asserted over a step that was still writing is
 * invisible by nature, so a silent drop would rebuild exactly the blind spot
 * the gate exists to close.
 *
 * Degrades safely: a disabled or absent frame records the command with no
 * inputs and no writes (its outputs fall back to leaves at registration), and a
 * frame whose every read is refused still records its command. It never throws —
 * provenance is best-effort and must not fail an exec.
 */

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { recordLineageEdgeRejected, type LineageEdgeRejectionReason } from "../lib/metrics.js";
import type { ProvenanceFrame } from "../sandbox/types.js";
import { classifyReadPath, type CompletedSteps, type ProvenanceCollector, type ObservedWrite } from "./collector.js";
import type { InputRef } from "./types.js";

/**
 * Strip the `/{resourceId}/` mount prefix from an absolute frame path.
 * Separators doubled at the boundary collapse (`/{rid}//a` → `a`) so an
 * in-mount name lands on its canonical relative form. A path not under the
 * mount comes back unchanged — still absolute — and the collector carries it
 * verbatim (see `trackInputAccess`).
 */
export function stripMountPrefix(mountRoot: string, absPath: string): string {
    const prefix = mountRoot.endsWith("/") ? mountRoot : `${mountRoot}/`;
    return absPath.startsWith(prefix) ? absPath.slice(prefix.length).replace(/^\/+/, "") : absPath;
}

export interface FeedExecFrameArgs {
    readonly collector: ProvenanceCollector;
    /** Analysis resource mount root, e.g. `/{resourceId}`. */
    readonly mountRoot: string;
    /** The argv the harness submitted in `SubmitExecBody`. */
    readonly command: readonly string[];
    readonly exitCode: number | null;
    readonly durationMs: number | null;
    /** The frame surfaced on `ExecResult.provenance` (may be absent). */
    readonly provenance?: ProvenanceFrame;
    /**
     * Producing steps observed `completed` at the moment this exec was
     * submitted, passed to `classifyReadPath` unmodified.
     *
     * Absent means the observation itself failed, which is not the same as an
     * empty one and is not a licence to admit: with no set to test membership
     * against, no producing step can be shown to have finished, so every read
     * naming one is refused and counted under its own reason.
     */
    readonly completedSteps?: CompletedSteps;
    /** Diagnostics seam. Left unwired, refusals are still counted but unnarrated. */
    readonly logger?: Logger;
    /** The reading step's agent, carried as the `agent_id` metric dimension. */
    readonly agentId?: string;
}

/**
 * Translate one exec's frame into a collector record. Per-command input
 * scoping: only the reads observed for THIS exec are attached to its
 * outputs (not the step's global read accumulator), so one command's
 * inputs don't collapse onto another's outputs.
 */
export function feedExecFrame(args: FeedExecFrameArgs): void {
    const { collector, mountRoot, command, exitCode, durationMs, provenance, completedSteps, agentId } = args;
    const cmd = command[0] ?? "";
    const cmdArgs = command.slice(1);
    const code = exitCode ?? -1;
    const duration = durationMs ?? 0;

    if (!provenance || provenance.disabled) {
        collector.recordCommandExecution(cmd, [...cmdArgs], code, duration, [], undefined, []);
        return;
    }

    // Resolved once so the read loop logs unconditionally instead of threading
    // `?.` through every diagnostic (see the Logger seam's fallback rule).
    const logger = (args.logger ?? createNoopLogger()).named("exec-frame");

    // Whether the snapshot exists is a property of the exec, not of a read, so
    // the reason is fixed for the whole frame. The two are counted apart because
    // "the gate asked and the answer was no" and "the gate never got to ask" call
    // for different responses: the first is the rule working, the second is an
    // observation that failed and should be chased.
    const reason: LineageEdgeRejectionReason = completedSteps === undefined ? "snapshot-unavailable" : "producing-step-not-completed";

    const commandReads: InputRef[] = [];
    for (const read of provenance.reads) {
        const rel = stripMountPrefix(mountRoot, read.path);
        const classification = classifyReadPath(rel, collector.stepId, collector.runId, collector.dependsOn, completedSteps);
        if (!classification.admissible) {
            logger.warn("refusing lineage edge to a step not observed completed", {
                path: rel,
                refRunId: classification.refRunId,
                refStepId: classification.refStepId,
                reason,
            });
            recordLineageEdgeRejected({ agentId, stepId: collector.stepId, reason });
            continue;
        }
        commandReads.push(collector.trackInputAccess(mountRoot, rel, null, classification.context));
    }

    const writes: ObservedWrite[] = provenance.writes.map((w) => ({
        path: stripMountPrefix(mountRoot, w.path),
        hash: "",
        size: 0,
    }));

    collector.recordCommandExecution(cmd, [...cmdArgs], code, duration, writes, undefined, commandReads);
}
