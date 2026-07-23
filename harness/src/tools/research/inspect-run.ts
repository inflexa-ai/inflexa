/**
 * inspectRun — inspect workflow runs for the current analysis.
 *
 * Dependency-bearing: the database `Pool` is captured by the factory
 * (see the harness-durable-runtime spec). The analysis id is read from the request-scoped `Session`,
 * not an ambient request context.
 *
 * Results are pull-only via this tool — the workflow does NOT write to the
 * conversation thread on completion. The retired `run-result-writer` push
 * payload (run status, step summaries, run synthesis, artifact paths) is
 * surfaced here on demand: the run row + step `summaryPath` references +
 * the `synthesisPath` for runs whose synthesis was produced let the
 * conversation agent `read_file` the artefacts it needs.
 */

import { ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import type { CortexRunRow } from "../../state/schema.js";
import { queryRun, queryRunsByAnalysis, queryStepsByRun } from "../../state/index.js";
import { scopeResource } from "../../auth/types.js";
import { SYNTHESIS_STEP_ID } from "../../workspace/paths.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { defineTool, type ToolError } from "../define-tool.js";

type FormattedRun = ReturnType<typeof formatRun>;

interface FormattedStep {
    stepId: string;
    agentId: string;
    wave: number;
    status: string;
    /** Absent for steps that never ran (`pending`/`skipped`) — no output tree exists to point at. */
    summaryPath?: string;
    durationMs?: number | null;
    error?: string | null;
    attempts?: number | null;
    lastErrorClass?: string | null;
    finishReason?: string | null;
    hitMaxSteps?: boolean | null;
}

type InspectRunOutput = { message: string } | { runs: FormattedRun[] } | { run: FormattedRun; steps: FormattedStep[] };

function formatRun(r: CortexRunRow, verbose: boolean) {
    return {
        runId: r.runId,
        workflowName: r.workflowName,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        planId: r.planId,
        // synthesis.json is written only when synthesis actually produced a
        // result; a skipped/failed synthesis leaves no file, so pointing at a
        // path would send the agent to a stale or absent artifact. The recorded
        // outcome — surfaced as synthesisStatus (and synthesisReason when set) —
        // lets a consumer tell "produced" from "skipped/failed/unknown" without
        // reading a file.
        synthesisPath: r.synthesisStatus === "produced" ? `runs/${r.runId}/synthesis.json` : null,
        synthesisStatus: r.synthesisStatus,
        ...(r.synthesisReason !== null ? { synthesisReason: r.synthesisReason } : {}),
        ...(verbose ? { error: r.error } : {}),
    };
}

export function createInspectRunTool(pool: Pool) {
    return defineTool({
        id: "inspect_run",
        description:
            "Inspect workflow runs for this analysis. " +
            "Without a runId: lists all runs. " +
            "With a runId: returns step-level details with paths to summary.md, plus each run's synthesisStatus and a synthesisPath to synthesis.json only when synthesis was produced. " +
            "Default response is lightweight — pass includeDiagnostics:true to add error/duration/retry telemetry. " +
            "Read summary.md or synthesis.json for findings, or use workspace search with type:summary or type:synthesis.",
        inputSchema: z.object({
            runId: z.string().optional().describe("Specific run to inspect. Omit to list all runs."),
            includeDiagnostics: z
                .boolean()
                .optional()
                .describe(
                    "Include failure/retry telemetry: run.error and step.{durationMs,error,attempts,lastErrorClass,finishReason,hitMaxSteps}. Default false.",
                ),
        }),
        execute: async (input, ctx): Promise<Result<InspectRunOutput, ToolError>> => {
            const resourceId = scopeResource(ctx.session.scope).resourceId;
            const verbose = input.includeDiagnostics === true;

            if (!input.runId) {
                const runs = unwrapOrThrow(await queryRunsByAnalysis(pool, resourceId));
                if (runs.length === 0) {
                    return ok({ message: "No runs found for this analysis." });
                }
                return ok({ runs: runs.map((r) => formatRun(r, verbose)) });
            }

            const run = unwrapOrThrow(await queryRun(pool, input.runId));
            if (!run || run.analysisId !== resourceId) {
                return ok({ message: `Run ${input.runId} not found.` });
            }

            const stepRows = unwrapOrThrow(await queryStepsByRun(pool, input.runId));
            const steps = stepRows.map((s) => ({
                stepId: s.stepId,
                agentId: s.agentId,
                wave: s.wave,
                status: s.status,
                // No per-step `summaryPath` when the file cannot exist: a seeded row
                // (`pending`/`skipped`) never produced output, and the reserved
                // `synthesis` phase is not a sandbox step — it writes the run-level
                // `synthesis.json`, surfaced as the run's `synthesisPath`, not a
                // `{stepId}/output/summary.md`. Emitting the per-step path for it would
                // point the agent at a file that never exists.
                ...(s.status === "pending" || s.status === "skipped" || s.stepId === SYNTHESIS_STEP_ID
                    ? {}
                    : { summaryPath: `runs/${input.runId}/${s.stepId}/output/summary.md` }),
                ...(verbose
                    ? {
                          durationMs: s.durationMs,
                          error: s.error,
                          attempts: s.attempts,
                          lastErrorClass: s.lastErrorClass,
                          finishReason: s.finishReason,
                          hitMaxSteps: s.hitMaxSteps,
                      }
                    : {}),
            }));

            return ok({ run: formatRun(run, verbose), steps });
        },
    });
}
