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
 */

import { posix as posixPath } from "node:path";

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { SandboxRef } from "../../sandbox/types.js";
import type { ProvenanceCollector } from "../../provenance/collector.js";
import { feedExecFrame } from "../../provenance/exec-frame.js";
import { boundExecResult } from "./result-bounds.js";
import { runSandboxExec } from "./run-exec.js";

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
}

export function createExecuteCommandTool(deps: ExecuteCommandDeps) {
    const { sandboxClient, sandbox, workflowId, stepId, nextFunctionId, deadlineMs, defaultCwd, markExecActive, lineageCollector, mountRoot } = deps;

    return defineTool({
        id: "execute_command",
        // `awaitExec`-recv is body-only (`DBOS.recv`), so this runs unwrapped in
        // the workflow body; durability is self-owned (submit step + body recv). See the harness-tools spec.
        bodyContext: true,
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
                    });
                } catch (err) {
                    console.warn(`[execute_command] provenance frame handling failed (non-fatal) for ${execId}: ${err instanceof Error ? err.message : err}`);
                }
            }

            return ok({ status: "ok" as const, ...boundExecResult(result) });
        },
    });
}
