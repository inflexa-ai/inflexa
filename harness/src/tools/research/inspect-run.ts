/**
 * inspectRun — inspect workflow runs for the current analysis.
 *
 * Results are pull-only: workflows never append completion messages to a
 * conversation. List mode puts the running runs first and is paged. Targeted mode makes
 * readiness explicit and can perform one bounded, abort-aware wait.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { ok, type Result } from "neverthrow";
import type { QueryConfig } from "pg";
import { z } from "zod";

import { scopeResource } from "../../auth/types.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { queryRun, queryRunsForInspection, queryStepsByRun } from "../../state/index.js";
import type { PauseRecord } from "../../state/paused-work.js";
import { queryPausesOfWork } from "../../state/paused-work.js";
import type { PauseCause } from "../../contracts/chat-parts.js";
import type { CortexRunRow, StepExecutionRow } from "../../state/schema.js";
import { SYNTHESIS_STEP_ID } from "../../workspace/paths.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";

const DEFAULT_PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 1_000;

type FormattedRun = {
    runId: string;
    workflowName: string;
    status: CortexRunRow["status"];
    startedAt: string;
    completedAt: string | null;
    planId: string | null;
    synthesisPath: string | null;
    synthesisStatus: CortexRunRow["synthesisStatus"];
    error: string | null | undefined;
    synthesisReason?: string;
};

type FormattedStep = {
    stepId: string;
    agentId: string;
    wave: number;
    status: string;
    summaryPath?: string;
    durationMs?: number | null;
    error?: string | null;
    attempts?: number | null;
    lastErrorClass?: string | null;
    finishReason?: string | null;
    hitMaxSteps?: boolean | null;
};

type WaitMetadata = {
    readonly requestedSeconds: number;
    readonly cutoffReached: boolean;
};

type InspectRunOutput =
    | { runs: FormattedRun[]; total: number; page: number; pageSize: number; hasMore: boolean }
    | { inspectionState: "not_found"; message: string; wait?: WaitMetadata }
    | {
          inspectionState: "paused";
          message: string;
          run: FormattedRun;
          steps: FormattedStep[];
          /** Each workflow of the run that waits: a step, or the synthesis. */
          pauses: { state: "retrying" | "paused"; cause: PauseCause; attempt: number; retryAt?: string }[];
          wait?: WaitMetadata;
      }
    | {
          inspectionState: "in_progress" | "terminal";
          message: string;
          run: FormattedRun;
          steps: FormattedStep[];
          elapsedMs?: number;
          wait?: WaitMetadata;
      };

type InspectRunClock = {
    now(): number;
    wait(ms: number, signal: AbortSignal): Promise<void>;
};

const systemClock: InspectRunClock = {
    now: Date.now,
    wait: (ms, signal) => sleep(ms, undefined, { signal }),
};

function isTerminal(status: CortexRunRow["status"]): boolean {
    return status === "completed" || status === "partial" || status === "failed" || status === "canceled";
}

function formatRun(r: CortexRunRow, verbose: boolean, exposePaths = isTerminal(r.status)): FormattedRun {
    const run = {
        runId: r.runId,
        workflowName: r.workflowName,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        planId: r.planId,
        synthesisPath: exposePaths && r.synthesisStatus === "produced" ? `runs/${r.runId}/synthesis.json` : null,
        synthesisStatus: r.synthesisStatus,
        error: verbose ? (r.error ?? null) : undefined,
    };
    if (r.synthesisReason !== null) return { ...run, synthesisReason: r.synthesisReason };
    return run;
}

function formatSteps(runId: string, stepRows: StepExecutionRow[], verbose: boolean, exposePaths: boolean): FormattedStep[] {
    return stepRows.map((s) => {
        const step: { -readonly [K in keyof FormattedStep]: FormattedStep[K] } = {
            stepId: s.stepId,
            agentId: s.agentId,
            wave: s.wave,
            status: s.status,
        };
        if (exposePaths && s.status !== "pending" && s.status !== "skipped" && s.stepId !== SYNTHESIS_STEP_ID) {
            step.summaryPath = `runs/${runId}/${s.stepId}/output/summary.md`;
        }
        if (verbose) {
            step.durationMs = s.durationMs;
            step.error = s.error;
            step.attempts = s.attempts;
            step.lastErrorClass = s.lastErrorClass;
            step.finishReason = s.finishReason;
            step.hitMaxSteps = s.hitMaxSteps;
        }
        return step;
    });
}

const inputSchema = z
    .object({
        runId: z.string().optional().describe("Specific run to inspect. Omit to list runs."),
        page: z.number().int().min(1).optional().describe("List page, starting at 1. Valid only without runId."),
        pageSize: z.number().int().min(1).max(100).optional().describe("Rows per list page (1-100). Valid only without runId."),
        waitForTerminalSeconds: z
            .number()
            .int()
            .min(1)
            .max(30)
            .optional()
            .describe("Wait up to this many seconds for a targeted running run to leave running state."),
        includeDiagnostics: z
            .boolean()
            .optional()
            .describe(
                "Include failure/retry telemetry: run.error and step.{durationMs,error,attempts,lastErrorClass,finishReason,hitMaxSteps}. Default false.",
            ),
    })
    .superRefine((input, refinement) => {
        if (input.runId && (input.page !== undefined || input.pageSize !== undefined)) {
            refinement.addIssue({
                code: "custom",
                message: "page and pageSize are valid only when runId is omitted",
                path: input.page !== undefined ? ["page"] : ["pageSize"],
            });
        }
        if (!input.runId && input.waitForTerminalSeconds !== undefined) {
            refinement.addIssue({
                code: "custom",
                message: "waitForTerminalSeconds requires runId",
                path: ["waitForTerminalSeconds"],
            });
        }
    });

/**
 * The pool surface this tool reads: one query whose rows the state row parsers type. A computed test fake
 * satisfies this shape directly, where the row-generic of `Querier` cannot be implemented by a fake that
 * computes its rows.
 */
export type InspectRunQuerier = {
    query(queryTextOrConfig: string | QueryConfig, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

/**
 * Build the run-inspection tool. The optional clock is an internal testing
 * seam for deterministic cutoff and transition coverage.
 */
export function createInspectRunTool(pool: InspectRunQuerier, clock: InspectRunClock = systemClock): Tool<z.infer<typeof inputSchema>, InspectRunOutput> {
    return defineTool({
        id: "inspect_run",
        description:
            "Inspect workflow runs for this analysis. A run never posts its completion into the conversation; this tool is how you read it. " +
            "Without a runId, returns a paged list (running runs first, then each other run) with total and hasMore. " +
            "With a runId, returns the run, its steps, and an inspectionState: not_found; in_progress; paused (a step waits until the user resumes or stops the run, and pauses gives each cause); " +
            "or terminal (run.status completed, partial, failed, or canceled). " +
            "Output paths appear only on a terminal run: run.synthesisPath when synthesisStatus is produced, and the summaryPath of each step that ran. " +
            "For a user-directed check, waitForTerminalSeconds can wait once for 1-30 seconds; if the cutoff returns in_progress, stop polling for that turn and tell the user that the run still runs. " +
            "Default response is lightweight — pass includeDiagnostics:true to add error/duration/retry telemetry.",
        inputSchema,
        // The two calls do different work: one inspects a named run, the other
        // pages the list. Naming the run id is what separates repeated polls of
        // the same run from polls of different ones.
        describeCall: (input) => (input.runId === undefined ? `run list (page ${input.page ?? 1})` : input.runId),
        execute: async (input, ctx): Promise<Result<InspectRunOutput, ToolError>> => {
            const resourceId = scopeResource(ctx.session.scope).resourceId;
            const verbose = input.includeDiagnostics === true;

            if (!input.runId) {
                const page = input.page ?? 1;
                const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
                const offset = (page - 1) * pageSize;
                const result = unwrapOrThrow(await queryRunsForInspection(pool, resourceId, { limit: pageSize, offset }));
                return ok({
                    runs: result.runs.map((run) => formatRun(run, verbose)),
                    total: result.total,
                    page,
                    pageSize,
                    hasMore: offset + result.runs.length < result.total,
                });
            }

            const waitSeconds = input.waitForTerminalSeconds;
            let run = unwrapOrThrow(await queryRun(pool, input.runId));
            if (!run || run.analysisId !== resourceId) {
                return ok({
                    inspectionState: "not_found",
                    message: `Run ${input.runId} was not found in this analysis.`,
                    wait: waitSeconds === undefined ? undefined : { requestedSeconds: waitSeconds, cutoffReached: false },
                });
            }

            const runId = input.runId;
            const pausesOf = async (status: CortexRunRow["status"]): Promise<PauseRecord[]> =>
                status === "running" ? unwrapOrThrow(await queryPausesOfWork(pool, resourceId, runId)) : [];
            let pauses = await pausesOf(run.status);
            let cutoffReached = false;
            if (waitSeconds !== undefined && run.status === "running" && pauses.length === 0) {
                const deadline = clock.now() + waitSeconds * 1_000;
                while (run.status === "running" && pauses.length === 0) {
                    const remaining = deadline - clock.now();
                    if (remaining <= 0) {
                        cutoffReached = true;
                        break;
                    }
                    await clock.wait(Math.min(POLL_INTERVAL_MS, remaining), ctx.signal);
                    run = unwrapOrThrow(await queryRun(pool, input.runId));
                    if (!run || run.analysisId !== resourceId) {
                        return ok({
                            inspectionState: "not_found",
                            message: `Run ${input.runId} was not found in this analysis.`,
                            wait: { requestedSeconds: waitSeconds, cutoffReached: false },
                        });
                    }
                    pauses = await pausesOf(run.status);
                }
            }

            const terminal = isTerminal(run.status);
            const stepRows = unwrapOrThrow(await queryStepsByRun(pool, input.runId));
            const steps = formatSteps(input.runId, stepRows, verbose, terminal);
            const wait = waitSeconds === undefined ? {} : { wait: { requestedSeconds: waitSeconds, cutoffReached } };

            if (run.status === "running" && pauses.length > 0) {
                return ok({
                    inspectionState: "paused",
                    message:
                        "This run waits in a pause, and results are not ready. Tell the user the cause of each pause. " +
                        "The user can resume the run or stop it. A pause in the state retrying also sends its request again at retryAt.",
                    run: formatRun(run, verbose, false),
                    steps,
                    pauses: pauses.map((pause) => ({ state: pause.state, cause: pause.cause, attempt: pause.attempt, retryAt: pause.retryAt })),
                    ...wait,
                });
            }

            if (run.status === "running") {
                const message = cutoffReached
                    ? "This run is still in progress after the requested wait cutoff. Results are not ready; stop polling for this turn."
                    : "This run is in progress. Results are not ready.";
                return ok({
                    inspectionState: "in_progress",
                    message,
                    run: formatRun(run, verbose, false),
                    steps,
                    elapsedMs: Math.max(0, clock.now() - Date.parse(run.startedAt)),
                    ...wait,
                });
            }

            return ok({
                inspectionState: "terminal",
                message: `This run is terminal with status ${run.status}.`,
                run: formatRun(run, verbose, true),
                steps,
                ...wait,
            });
        },
    });
}
