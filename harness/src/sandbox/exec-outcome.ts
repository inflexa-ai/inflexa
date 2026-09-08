/**
 * What one settled exec is worth to an operator: the bounded outcome that
 * `cortex.sandbox.execs` counts, and the summary that the `step failure`
 * record of `workflows/sandbox-step.ts` carries.
 *
 * No stream text crosses this module. Sandbox output is generated code and the
 * output of that code, thus it is untrusted, and the sandbox-exec-logging spec
 * keeps that text on the sandbox side of the boundary. A summary gives the
 * SIZE of stderr and never a byte of it.
 *
 * The summary of the last exec of a sandbox lives in one process-local cell,
 * keyed by sandbox id. A sandbox belongs to one step (see the teardown of
 * `create-sandbox.ts`), thus the cell is step-scoped in effect and the step
 * body reads it without a new dependency through the agent factory. A replay
 * re-runs the await loop and writes the cell again, thus a recovered body
 * reads the summary of the same exec. The map is capped, so a sandbox whose
 * step never reaches the read site cannot hold memory.
 */

import type { SandboxExecOutcome } from "../lib/metrics.js";
import type { SyntheticFailureReason } from "./liveness.js";
import type { ExecResult } from "./types.js";

/** The reason that names a machine the kernel killed for its memory limit. */
const OOM_KILLED: SyntheticFailureReason = "sandbox-oom-killed";

/**
 * The outcome one result carries. A synthetic failure names a dead machine and
 * not a command, thus it wins over every other field. A timeout wins over the
 * exit code that the kill produced. `ok` is exit code 0 and nothing else, thus
 * a result with no code counts as `nonzero`.
 */
export function sandboxExecOutcomeOf(result: ExecResult): SandboxExecOutcome {
    if (result.syntheticFailure) return result.syntheticFailure.reason === OOM_KILLED ? "synthetic-oom" : "synthetic-dead";
    if (result.timedOut) return "timeout";
    return result.exitCode === 0 ? "ok" : "nonzero";
}

/** The account of one exec that a failure record can hold. Text-free by construction. */
export interface ExecOutcomeSummary {
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    /**
     * What the command wrote to stderr, in bytes. The sandbox reports the total
     * when it dropped output past its retention budget; without that total the
     * retained slice IS the whole stream, so its length is the total.
     */
    readonly stderrTotalBytes: number;
    readonly syntheticFailureReason?: string;
}

/** Reduce a result to its summary. */
export function summarizeExec(result: ExecResult): ExecOutcomeSummary {
    return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stderrTotalBytes: result.stderrTotalBytes ?? Buffer.byteLength(result.stderr, "utf8"),
        ...(result.syntheticFailure ? { syntheticFailureReason: result.syntheticFailure.reason } : {}),
    };
}

/**
 * How many sandboxes keep a summary. A host runs far fewer sandboxes at once
 * than this, thus the cap only drops the summary of a step that ended long ago.
 */
const MAX_TRACKED_SANDBOXES = 256;

const lastExecBySandbox = new Map<string, ExecOutcomeSummary>();

/** Keep `summary` as the last known exec of `sandboxId`. */
export function noteExecOutcome(sandboxId: string, summary: ExecOutcomeSummary): void {
    // Delete before set so the key moves to the end of the insertion order and
    // the eviction below drops the least recently written sandbox.
    lastExecBySandbox.delete(sandboxId);
    lastExecBySandbox.set(sandboxId, summary);
    while (lastExecBySandbox.size > MAX_TRACKED_SANDBOXES) {
        const oldest = lastExecBySandbox.keys().next();
        if (oldest.done) break;
        lastExecBySandbox.delete(oldest.value);
    }
}

/** The last known exec of `sandboxId`, or `undefined` when it ran none. */
export function lastExecOutcome(sandboxId: string): ExecOutcomeSummary | undefined {
    return lastExecBySandbox.get(sandboxId);
}
