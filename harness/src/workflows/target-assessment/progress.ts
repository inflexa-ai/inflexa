/**
 * Progress emission for the target-assessment DBOS workflow.
 *
 * Emits a typed `data-target-assessment-progress` part via
 * `DBOS.writeStream("progress", part)` and updates `cortex_target_assessments.progress`.
 * Both writes happen inside a `DBOS.runStep` so a recovered workflow does not
 * duplicate the event.
 *
 * Wire shape: `TargetAssessmentProgressEventSchema` in
 * `harness/src/contracts/target-dossier.ts`. The SSE route reads via
 * `DBOS.readStream(workflowId, "progress")` and folds-on-read by `phase`.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";
import type { TargetAssessmentPhase, TargetAssessmentProgressEvent } from "@inflexa-ai/harness/contracts/target-dossier.js";

import { unwrapOrThrow } from "../../lib/result.js";
import { updateProgress } from "../../state/target-assessments.js";

/** DBOS stream key the SSE route reads via `DBOS.readStream(wfId, "progress")`. */
export const TA_PROGRESS_STREAM_KEY = "progress";

export type ProgressPhase = TargetAssessmentPhase;

/**
 * Wire shape of one progress event. Matches the harness's contracts
 * `TargetAssessmentProgressEventSchema`. Wrapped in a typed chat part
 * envelope by the SSE route on the way out.
 */
export interface ProgressPart {
    readonly type: "data-target-assessment-progress";
    readonly payload: TargetAssessmentProgressEvent;
}

export const PROGRESS_PERCENTS: Record<ProgressPhase, number> = {
    resolving: 5,
    collecting: 25,
    deciding: 55,
    fanning_out: 70,
    assembling: 85,
    synthesizing: 90,
    completed: 100,
    failed: 100,
    suspended: 100,
};

export const PROGRESS_MESSAGES: Record<ProgressPhase, string> = {
    resolving: "Resolving target identity",
    collecting: "Collecting evidence from 14 data sources",
    deciding: "Triaging modulators and classifying trials",
    fanning_out: "Building per-modulator and per-trial detail",
    assembling: "Assembling dossier sections",
    synthesizing: "Drafting safety and translational commentary",
    completed: "Completed",
    failed: "Failed",
    suspended: "Suspended — insufficient funds",
};

/**
 * Emit one progress transition. MUST be called from inside the workflow
 * body — the `DBOS.runStep` wrapper makes it replay-safe (DBOS persists
 * the stream-write offset under `(workflowID, function_id)`; replay
 * returns cached without re-writing the part).
 *
 * Best-effort: a DB or stream failure logs and continues — progress
 * emission MUST NOT block the workflow.
 */
export async function emitProgress(pool: Pool, assessmentId: string, phase: ProgressPhase): Promise<void> {
    const message = PROGRESS_MESSAGES[phase];
    const percent = PROGRESS_PERCENTS[phase];

    await DBOS.runStep(
        async () => {
            const part: ProgressPart = {
                type: "data-target-assessment-progress",
                payload: { phase, message, percent, at: new Date().toISOString() },
            };
            try {
                await DBOS.writeStream(TA_PROGRESS_STREAM_KEY, part);
            } catch (err) {
                console.warn(`[ta-progress] writeStream failed for ${assessmentId} (${phase}): ${err instanceof Error ? err.message : err}`);
            }
            // The "suspended" phase is owned by the terminal handler
            // (`markAssessmentSuspended` already set status + progress text). A
            // row write here would either race or overwrite the suspended status.
            if (phase !== "suspended") {
                try {
                    const rowStatus = phase === "completed" ? ("completed" as const) : phase === "failed" ? ("failed" as const) : ("running" as const);
                    unwrapOrThrow(await updateProgress(pool, assessmentId, message, rowStatus));
                } catch (err) {
                    console.warn(`[ta-progress] updateProgress failed for ${assessmentId} (${phase}): ${err instanceof Error ? err.message : err}`);
                }
            }
        },
        { name: `ta-progress:${phase}` },
    );
}
