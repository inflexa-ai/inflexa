/**
 * `execute_command` — the single chokepoint through which sandbox commands
 * run.
 *
 * Dependency-bearing factory (see the harness-durable-runtime spec): captures a `SandboxClient`, the
 * live `SandboxRef` for the step, and the per-call execId minter. No other
 * tool, agent, or workflow step is permitted to POST to sandbox-server's
 * `/exec` directly — `SandboxClient` is intentionally injected only here so
 * the durability / idempotency / liveness story `harness-sandbox-exec`
 * owns holds uniformly across all sandbox command execution.
 *
 * `execId` is derived as `${workflowId}:${stepId}:${functionId}` so replays
 * land on the cached DBOS step output rather than re-submitting; the same
 * `execId` is the step name `submitExec` uses (`sandbox.submit-exec.${execId}`).
 *
 * Provenance for files written *inside* the sandbox by the executed command
 * is NOT recorded here — sandbox-server emits provenance frames (see
 * `sandbox-provenance-tracking`), and artifact registration reconciles them.
 * The harness-side mutate tools (`write_file`, `edit_file`) hash and record
 * the writes *they* perform, but `execute_command`'s opaque commands do not.
 *
 * What the tool does own for lineage is *admissibility*: before each exec is
 * submitted it snapshots which steps of the analysis have completed, and hands
 * that set to the frame translation. A read under a producing step's directory
 * becomes an input edge only if that step had finished; everything else the
 * command happened to observe is dropped rather than asserted.
 */

import { posix as posixPath } from "node:path";

import { ok } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { defineTool, type ToolContext } from "../define-tool.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { SandboxRef } from "../../sandbox/types.js";
import { completedStepKey, type CompletedSteps, type ProvenanceCollector } from "../../provenance/collector.js";
import { feedExecFrame } from "../../provenance/exec-frame.js";
import { queryCompletedStepsByAnalysis } from "../../state/index.js";
import { boundExecResult } from "./result-bounds.js";
import { runSandboxExec } from "./run-exec.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";

const ExecuteCommandInputSchema = z.object({
    command: z
        .array(z.string().min(1))
        .min(1)
        .describe(
            "argv array — e.g. ['python', 'scripts/run.py'] or ['head', '-n', '50', 'data/inputs/x.csv']. " +
                "Not passed through a shell; quoting and globbing are not expanded.",
        ),
    cwd: z
        .string()
        .optional()
        .describe(
            "Working directory inside the sandbox. Defaults to your working " +
                "directory; a relative value is resolved against it, an absolute " +
                "'/<analysisId>/...' value is used as-is.",
        ),
    env: z.record(z.string(), z.string()).optional().describe("Extra environment variables for this command."),
    timeoutSeconds: z.number().int().positive().optional().describe("Per-command timeout in seconds; capped by the step deadline."),
});

export interface ExecuteCommandDeps {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly sandboxClient: SandboxClient;
    /** Live sandbox handle for the step. Created once per step at composition root. */
    readonly sandbox: SandboxRef;
    /** Stable across replay. The workflow's DBOS workflow id. */
    readonly workflowId: string;
    /** Stable across replay. The sandbox step's identifier within the workflow. */
    readonly stepId: string;
    /**
     * Mints a stable per-call function id. The composition root closes over a
     * monotonic counter; the agent loop's tool-call order is replay-deterministic
     * (the LLM call wrapping it is a cached DBOS step), so the counter reaches
     * the same value at each call site on replay.
     */
    readonly nextFunctionId: () => string;
    /** Absolute unix-ms deadline for `awaitExec`. Typically derived from `step.timeout`. */
    readonly deadlineMs: () => number;
    /**
     * In-sandbox absolute path of the agent's working directory (e.g.
     * `/{resourceId}/runs/{runId}/{stepId}`). Used as the default `cwd` so a
     * command's relative paths match `write_file`/`read_file` relative paths,
     * and as the base a supplied relative `cwd` resolves against (see the harness-workspace-tools spec).
     */
    readonly defaultCwd: string;
    /** Tag the active-sandbox row with the in-flight execId for the liveness watchdog. */
    readonly markExecActive?: (execId: string) => Promise<void>;
    /**
     * Step-scoped lineage collector. Each exec's `ExecResult.provenance`
     * frame is fed here (reads → inputs, writes → outputs) so post-step
     * registration carries real input/script edges. Omit to skip capture.
     */
    readonly lineageCollector?: ProvenanceCollector;
    /** Analysis resource mount root (`/{resourceId}`) — strips frame paths to relative. */
    readonly mountRoot?: string;
    /**
     * Reads `cortex_step_executions` for the completed-step snapshot that
     * decides which producing steps this exec may claim as inputs. Belongs
     * with `lineageCollector`/`mountRoot`: without it no sibling or prior-run
     * read of this exec is admissible.
     */
    readonly pool?: Pool;
    /**
     * The analysis whose step completions gate this exec's lineage edges. One
     * predicate covers same-run siblings and prior runs alike, so the snapshot
     * is analysis-scoped rather than run-scoped.
     */
    readonly analysisId?: string;
}

/**
 * What the durable snapshot step resolves to, before it becomes a membership
 * set.
 *
 * The durable shape is an array of pairs, not the `Set` the classifier wants,
 * because DBOS checkpoints a step's return value as JSON and a `Set` replays
 * as `{}`. The failure arm is a value rather than a throw for two reasons: a
 * thrown step would fail the exec, and provenance must never do that; and it
 * would leave the degradation itself un-checkpointed, so a replay could re-run
 * the query, succeed where the original failed, and assert edges the first
 * execution refused.
 */
type CompletedStepsSnapshot = { readonly ok: true; readonly pairs: readonly { readonly runId: string; readonly stepId: string }[] } | { readonly ok: false };

/**
 * Observe which producing steps of this analysis have finished, as of now.
 *
 * `undefined` means "no snapshot" and is not the same as an empty set: the
 * classifier fails closed on it, so every read naming a producing step becomes
 * inadmissible rather than silently admitted.
 */
async function snapshotCompletedSteps(args: {
    readonly ctx: ToolContext;
    readonly pool: Pool;
    readonly analysisId: string;
    readonly execId: string;
    readonly logger: Logger;
}): Promise<CompletedSteps | undefined> {
    const { ctx, pool, analysisId, execId, logger } = args;

    // `execute_command` is `executionMode: "workflow"`, so this body runs
    // unwrapped in the DBOS workflow body: an unwrapped query would re-execute
    // on replay and return a strictly larger completed-set, giving the same run
    // different lineage on recovery. The step wrapper is what pins the answer.
    // A DBOS control-flow throw (workflow cancellation) is deliberately not
    // caught around it — that is not a provenance failure and must reach the
    // loop's fatal predicate.
    const snapshot = await ctx.runStep(`lineage.completed-steps.${execId}`, async (): Promise<CompletedStepsSnapshot> => {
        const queried = await queryCompletedStepsByAnalysis(pool, analysisId);
        return queried.match<CompletedStepsSnapshot>(
            (pairs) => ({ ok: true, pairs }),
            (error) => {
                logger.error("completed-step snapshot unavailable — no producing-step read of this exec is admissible", {
                    execId,
                    analysisId,
                    ...logger.errorFields(error),
                });
                return { ok: false };
            },
        );
    });

    if (!snapshot.ok) return undefined;
    return new Set(snapshot.pairs.map((pair) => completedStepKey(pair.runId, pair.stepId)));
}

export function createExecuteCommandTool(deps: ExecuteCommandDeps) {
    const {
        sandboxClient,
        sandbox,
        workflowId,
        stepId,
        nextFunctionId,
        deadlineMs,
        defaultCwd,
        markExecActive,
        lineageCollector,
        mountRoot,
        pool,
        analysisId,
    } = deps;
    const logger = (deps.logger ?? createNoopLogger()).named("execute_command");

    /** The snapshot this exec classifies against, or `undefined` for none. */
    const snapshotForExec = (ctx: ToolContext, execId: string): Promise<CompletedSteps | undefined> => {
        if (!lineageCollector || !mountRoot) return Promise.resolve(undefined);
        if (!pool || !analysisId) {
            logger.error("no completed-step snapshot source wired alongside the lineage collector — no producing-step read of this exec is admissible", {
                execId,
            });
            return Promise.resolve(undefined);
        }
        return snapshotCompletedSteps({ ctx, pool, analysisId, execId, logger });
    };

    return defineTool({
        id: "execute_command",
        // `awaitExec`-recv is body-only (`DBOS.recv`), so this runs unwrapped in
        // the workflow body; durability is self-owned (submit step + body recv). See the harness-tools spec.
        executionMode: "workflow",
        description:
            "Run a command in the sandbox and return its stdout/stderr/exit code. " +
            "Use for scripts, CLI tools, shell pipes, and anything the workspace " +
            "tools don't express. stdout and stderr are each capped at 8 KiB; oversize " +
            "streams come back with truncation markers. Failures are returned as data, " +
            "not thrown. stdout/stderr are EPHEMERAL and are NOT a deliverable — use " +
            "this to confirm a command ran, not to produce results. Do NOT compute " +
            "analysis results via 'python -c' / inline one-liners and read them from " +
            "stdout; that work is lost. Write a script and persist its outputs to output/.",
        inputSchema: ExecuteCommandInputSchema,
        execute: async ({ command, cwd, env, timeoutSeconds }, ctx) => {
            const execId = `${workflowId}:${stepId}:${nextFunctionId()}`;

            const effectiveCwd = cwd === undefined ? defaultCwd : cwd.startsWith("/") ? cwd : posixPath.join(defaultCwd, cwd);

            // Submit time is the normative predicate for admissibility, so the
            // snapshot is taken here rather than after the exec: completion is
            // monotonic, so a step observed `completed` now was necessarily
            // completed before any read this command can perform. Observed
            // afterwards it would also cover siblings that finished *while* the
            // command ran, and there is no way to tell whether the read landed
            // before or after such a sibling's final write.
            const completedSteps = await snapshotForExec(ctx, execId);

            const result = await runSandboxExec({
                sandboxClient,
                sandbox,
                execId,
                command,
                cwd: effectiveCwd,
                ...(env === undefined ? {} : { env }),
                ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
                deadlineMs: deadlineMs(),
                emit: ctx.emit,
                ...(markExecActive ? { markExecActive } : {}),
            });

            // Capture degradation the container cannot report any other way: the
            // watcher's own warning stays in the sandbox's log, so without this
            // the frame silently omits whatever lived under the directories the
            // walk could not watch. Logged whether or not lineage is collected —
            // the degradation is a fact about the exec, not about this wiring.
            const watchBudget = result.provenance?.watchBudget;
            if (watchBudget) {
                logger.warn("sandbox inotify watch coverage was incomplete — file operations under unwatched directories were not observed", {
                    execId,
                    stepId,
                    ...(ctx.session.runFrame ? { runId: ctx.session.runFrame.runId } : {}),
                    watchLimit: watchBudget.limit,
                    watchedDirs: watchBudget.watched,
                    // The two shortfalls stay separate fields because they name
                    // different limits: `unwatchedDirs` is the sandbox's own cap
                    // declining to descend (raise PROVENANCE_MAX_INOTIFY_WATCHES),
                    // `failedWatches` is the host's per-uid ceiling refusing the
                    // registration (raise fs.inotify.max_user_watches on the node).
                    unwatchedDirs: watchBudget.unwatchedDirs,
                    failedWatches: watchBudget.failedWatches ?? 0,
                });
            }

            // Thread the runtime file-I/O frame into the step's lineage collector.
            // Best-effort: a collector failure must never fail the exec.
            if (lineageCollector && mountRoot) {
                try {
                    feedExecFrame({
                        collector: lineageCollector,
                        mountRoot,
                        command,
                        exitCode: result.exitCode,
                        durationMs: result.durationMs,
                        ...(result.provenance ? { provenance: result.provenance } : {}),
                        // Passed through even when absent: the classifier reads a
                        // missing snapshot as "nothing can be shown to have
                        // completed" and refuses every producing-step read, which
                        // is the degraded posture this exec must run under.
                        completedSteps,
                        logger,
                        agentId: ctx.session.provenance.agentId,
                    });
                } catch (err) {
                    logger.warn("provenance frame handling failed (non-fatal)", { execId, ...logger.errorFields(err) });
                }
            }

            return ok({ status: "ok" as const, ...boundExecResult(result) });
        },
    });
}
