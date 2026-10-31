/**
 * `execute_command` — the single chokepoint through which sandbox commands
 * run.
 *
 * Dependency-bearing factory (see the harness-durable-runtime spec): captures the
 * lease of the step. The sandbox module gives the machine of the lease, or a new
 * one when the machine went away, thus the durability, idempotency, and liveness
 * story of `harness-sandbox-exec` holds for each command. A command with no lease
 * gives an error result that names `acquire_sandbox`.
 *
 * The loop runs each call as one durable step, and the exec runs inside it,
 * thus the exec id is the id of that step and a replay returns the cached
 * result with no submit.
 *
 * Provenance for files written *inside* the sandbox by the executed command
 * is NOT recorded here — sandbox-server emits provenance frames (see
 * `sandbox-provenance-tracking`), and artifact registration reconciles them.
 * The frame of each exec rides the call record, and the fold feeds it to the
 * lineage collector of the step.
 *
 * A script the command names that carries a decision record is compared
 * with the digest the record expects before it runs. A difference is a
 * change that no file tool recorded, and the record gets it with the digest
 * of the bytes that run, thus the record connects the cited decision to the
 * code that ran.
 */

import { posix as posixPath } from "node:path";

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, withToolCallRecord, type Tool, type ToolError, type WithToolCallRecord } from "../define-tool.js";
import type { BoundLease } from "../../sandbox/leases.js";
import type { ProvenanceFrame } from "../../sandbox/types.js";
import type { ProvenanceCollector } from "../../provenance/collector.js";
import { feedExecFrame } from "../../provenance/exec-frame.js";
import { reconcileScriptRecord } from "./decision-record.js";
import type { WorkspaceMutator, WriteRecord } from "./mutator.js";
import { EXEC_STREAM_BYTE_CAP, boundExecResult, type BoundedExecResult } from "./result-bounds.js";
import { runSandboxExec } from "./run-exec.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";

const ExecuteCommandInputSchema = z.object({
    command: z
        .array(z.string().min(1))
        .min(1)
        .describe(
            "argv array — e.g. ['python', 'scripts/run.py'] or ['head', '-n', '50', 'data/inputs/x.csv']. " +
                "A one-element array runs through `sh -c`, so pipes, `&&`, quoting, and globbing work, and a path that holds a space " +
                "needs double quotes there; an array of two or more elements runs directly, with no shell, and nothing is expanded.",
        ),
    cwd: z
        .string()
        .optional()
        .describe(
            "Working directory inside the sandbox. Defaults to your working " +
                "directory; a relative value is resolved against it, an absolute " +
                "'/<analysisId>/...' value is used as-is. Each call starts here: a `cd` in an earlier call " +
                "does not carry over, thus pass `cwd` or chain the commands with `&&` in one call.",
        ),
    env: z.record(z.string(), z.string()).optional().describe("Extra environment variables for this command."),
    timeoutSeconds: z.number().int().positive().optional().describe("Per-command timeout in seconds. Default 3600."),
});

/** Extensions that mark an argv token as the thing being run, not a flag or a data path. */
const SCRIPT_EXTENSIONS = [".py", ".R", ".r", ".sh", ".js", ".ts", ".ipynb"];

/** The first script-like token in an argv, or `undefined` when none looks like one. */
function scriptToken(command: readonly string[]): string | undefined {
    return command.find((arg) => SCRIPT_EXTENSIONS.some((extension) => arg.endsWith(extension)));
}

/** What one exec leaves for the lineage collector of the step. */
type ExecCallRecord = {
    readonly command: readonly string[];
    readonly exitCode: number | null;
    readonly durationMs: number | null;
    provenance?: ProvenanceFrame;
    /** The decision-record writes of the script check before the exec, for the mutator. */
    recordWrites?: readonly WriteRecord[];
};

type ExecuteCommandResult = { readonly status: "ok" } & BoundedExecResult;

export type ExecuteCommandDeps = {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    /** The lease of the step: `acquire_sandbox` takes it, and each command runs on its machine. */
    readonly lease: BoundLease;
    /**
     * In-sandbox absolute path of the agent's working directory (e.g.
     * `/{resourceId}/runs/{runId}/{stepId}`). Used as the default `cwd` so a
     * command's relative paths match `write_file`/`read_file` relative paths,
     * and as the base a supplied relative `cwd` resolves against (see the harness-workspace-tools spec).
     */
    readonly defaultCwd: string;
    /**
     * Step-scoped lineage collector. Each exec's `ExecResult.provenance`
     * frame is fed here (reads → inputs, writes → outputs) so post-step
     * registration carries real input/script edges. Omit to skip capture.
     */
    readonly lineageCollector?: ProvenanceCollector;
    /** Analysis resource mount root (`/{resourceId}`) — strips frame paths to relative. */
    readonly mountRoot?: string;
    /**
     * The workspace filesystem and the mutator of the step, for the record check of a
     * script the command runs. Both absent (a read-only agent), no record is
     * read or written.
     */
    readonly workspaceFilesystem?: WorkspaceFilesystem;
    readonly mutator?: WorkspaceMutator;
};

export function createExecuteCommandTool(
    deps: ExecuteCommandDeps,
): Tool<z.infer<typeof ExecuteCommandInputSchema>, ExecuteCommandResult | WithToolCallRecord<ExecuteCommandResult, ExecCallRecord>> {
    const { lease, defaultCwd, lineageCollector, mountRoot } = deps;

    return defineTool({
        id: "execute_command",
        ownStep: true,
        description:
            "Run a command in the sandbox and return its stdout/stderr/exit code. " +
            "Use for scripts, CLI tools, shell pipes, and anything the workspace " +
            `tools don't express. stdout and stderr are each capped at ${EXEC_STREAM_BYTE_CAP / (1024 * 1024)} MiB; the end ` +
            "of a longer stream is dropped, and the result carries its truncation flag. A long result comes back as an " +
            "excerpt of its start and its end, with a reference to read the rest when the harness keeps it. " +
            "Failures are returned as data, not thrown: `status` is `ok` whenever the call completed, so read " +
            "`exitCode` for the outcome of the command. `timedOut: true` means the timeout stopped the command. A " +
            "`syntheticFailure` with `exitCode: null` means the sandbox ended under the command: `sandbox-oom-killed` " +
            "(the command passed `memoryLimitGb`), `sandbox-dead`, or `sandbox-replaced`. The command may have left " +
            "partial files, and nothing runs it again. The next command runs on a new sandbox of the same size; call " +
            "`acquire_sandbox` with a larger size for more memory. stdout and stderr are not a deliverable: they are ephemeral, " +
            "so use them to confirm that a command ran. A result that you compute with 'python -c' or an inline " +
            "one-liner and read from stdout is lost. Write a script and persist its outputs to output/.",
        inputSchema: ExecuteCommandInputSchema,
        view: "none",
        // The script is what a reader recognises, and it survives a long
        // invocation whose flags would otherwise push it past the length cap.
        // When nothing in the argv looks like a script, the joined argv is the
        // best account of the call there is.
        //
        // `env` never rides along. It is the channel this tool documents for
        // secrets, so it is the one field guaranteed to hold them. An argv can
        // hold one too (`--password …` is a real habit), and the emit-site
        // redaction removes only the secret forms that it lists, so the join
        // is a deliberate trade, not a claim of safety. The view is `"none"` for
        // the same reason: the argv, the env, and the output of a command show
        // no value.
        //
        // Know what the trade costs. This tool is sandbox-gated, so the only
        // surface that reads its detail is a workflow's live-activity line — and
        // that line goes to the run-event stream through `DBOS.writeStream`. The
        // detail is therefore DURABLE, and every history read replays it. It
        // stays inside the session's own analysis and never reaches the model,
        // but display-only does not mean transient. A secret typed into an argv
        // outlives the turn that ran it.
        describeCall: ({ command }) => scriptToken(command) ?? command.join(" "),
        execute: async (
            { command, cwd, env, timeoutSeconds },
            ctx,
        ): Promise<Result<ExecuteCommandResult | WithToolCallRecord<ExecuteCommandResult, ExecCallRecord>, ToolError>> => {
            const effectiveCwd = cwd === undefined ? defaultCwd : cwd.startsWith("/") ? cwd : posixPath.join(defaultCwd, cwd);

            // Each script the argv names, as the sandbox resolves it. A relative token resolves against the cwd of the
            // command, which is a `/{analysisId}/...` path, thus the workspace filesystem resolves it the same way.
            const recordWrites: WriteRecord[] = [];
            if (deps.workspaceFilesystem && deps.mutator) {
                for (const token of command.filter((arg) => SCRIPT_EXTENSIONS.some((extension) => arg.endsWith(extension)))) {
                    const noted = await reconcileScriptRecord({
                        filesystem: deps.workspaceFilesystem,
                        mutator: deps.mutator,
                        session: ctx.session,
                        invocationId: ctx.invocationId,
                        toolName: "execute_command",
                        scriptPath: token.startsWith("/") ? token : posixPath.join(effectiveCwd, token),
                    });
                    if (noted.status === "noted") recordWrites.push(noted.write);
                }
            }

            const ran = await runSandboxExec({
                lease,
                command,
                cwd: effectiveCwd,
                env,
                timeoutSeconds,
                emit: ctx.emit,
            });
            if (ran.isErr()) return err(ran.error);
            const result = ran.value;

            const bounded = { status: "ok" as const, ...boundExecResult(result) };
            if ((!lineageCollector || !mountRoot) && recordWrites.length === 0) return ok(bounded);
            const record: ExecCallRecord = {
                command,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
            };
            if (result.provenance) record.provenance = result.provenance;
            if (recordWrites.length > 0) record.recordWrites = recordWrites;
            return ok(withToolCallRecord(bounded, record));
        },
        // Best-effort: a collector failure must never fail the exec.
        foldCallRecord: (record) => {
            for (const write of record.recordWrites ?? []) deps.mutator?.recordWrite(write);
            if (!lineageCollector || !mountRoot) return;
            try {
                feedExecFrame({
                    collector: lineageCollector,
                    mountRoot,
                    command: record.command,
                    exitCode: record.exitCode,
                    durationMs: record.durationMs,
                    logger: deps.logger,
                    provenance: record.provenance,
                });
            } catch (err) {
                const logger = (deps.logger ?? createNoopLogger()).named("execute_command");
                logger.warn("provenance frame handling failed (non-fatal)", logger.errorFields(err));
            }
        },
    });
}
