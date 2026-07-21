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
 * A read naming a same-run sibling this step never declared is refused here,
 * before it reaches the collector: a ref the collector never holds cannot
 * become an attestation target, so the edge is unrepresentable rather than
 * merely filtered downstream. Each refused path is logged once per step — an
 * edge asserted over a step that was still writing is invisible by nature, so a
 * silent drop would rebuild exactly the blind spot the refusal exists to close,
 * while re-narrating a path already reported adds no fact and buries the rest.
 *
 * Degrades safely: a disabled or absent frame records the command with no
 * inputs and no writes (its outputs fall back to leaves at registration), and a
 * frame whose every read is refused still records its command. It never throws —
 * provenance is best-effort and must not fail an exec.
 */

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import type { ProvenanceFrame } from "../sandbox/types.js";
import { classifyReadPath, type ProvenanceCollector, type ObservedWrite } from "./collector.js";
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
    /** Diagnostics seam. Left unwired, refusals still happen but go unnarrated. */
    readonly logger?: Logger;
}

/**
 * Translate one exec's frame into a collector record. Per-command input
 * scoping: only the reads observed for THIS exec are attached to its
 * outputs (not the step's global read accumulator), so one command's
 * inputs don't collapse onto another's outputs.
 */
export function feedExecFrame(args: FeedExecFrameArgs): void {
    const { collector, mountRoot, command, exitCode, durationMs, provenance } = args;
    const cmd = command[0] ?? "";
    const cmdArgs = command.slice(1);
    const code = exitCode ?? -1;
    const duration = durationMs ?? 0;

    if (!provenance || provenance.disabled) {
        collector.recordCommandExecution(cmd, [...cmdArgs], code, duration, [], undefined, []);
        return;
    }

    // Resolved once so the read loop logs unconditionally instead of threading
    // `?.` through every diagnostic.
    const logger = (args.logger ?? createNoopLogger()).named("exec-frame");

    const commandReads: InputRef[] = [];
    for (const read of provenance.reads) {
        const rel = stripMountPrefix(mountRoot, read.path);
        const classification = classifyReadPath(rel, collector.stepId, collector.runId, collector.dependsOn);
        if (!classification.admissible) {
            if (collector.claimRefusalNarration(rel)) {
                logger.warn("refusing lineage edge to an undeclared same-run path", {
                    path: rel,
                    refRunId: classification.refRunId,
                    refStepId: classification.refStepId,
                });
            }
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
