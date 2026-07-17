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
 * Degrades safely: a disabled or absent frame records the command with no
 * inputs and no writes (its outputs fall back to leaves at registration).
 * It never throws — provenance is best-effort and must not fail an exec.
 */

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

    const commandReads: InputRef[] = [];
    for (const read of provenance.reads) {
        const rel = stripMountPrefix(mountRoot, read.path);
        const context = classifyReadPath(rel, collector.stepId, collector.runId, collector.dependsOn);
        commandReads.push(collector.trackInputAccess(mountRoot, rel, null, context));
    }

    const writes: ObservedWrite[] = provenance.writes.map((w) => ({
        path: stripMountPrefix(mountRoot, w.path),
        hash: "",
        size: 0,
    }));

    collector.recordCommandExecution(cmd, [...cmdArgs], code, duration, writes, undefined, commandReads);
}
