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
import { feedExecFrame, stripMountPrefix } from "../../provenance/exec-frame.js";
import { decisionRecordPathFor, reconcileScriptRecord, type DecisionRecordStore } from "./decision-record.js";
import type { WorkspaceMutator, WriteRecord } from "./mutator.js";
import { EXEC_STREAM_BYTE_CAP, boundExecResult, type BoundedExecResult } from "./result-bounds.js";
import { runSandboxExec } from "./run-exec.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { collapseWhitespace } from "../../lib/text.js";
import type { Logger } from "../../lib/logger.js";

const ExecuteCommandInputSchema = z.object({
    command: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
        .describe(
            "A shell line, or an argv array — e.g. 'Rscript scripts/de.R' or ['python', 'scripts/run.py']. " +
                "A string or a one-element array runs through `sh -c`, so pipes, `&&`, quoting, and globbing work, and a path that holds a space " +
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
    env: z
        .record(z.string(), z.string())
        .optional()
        .describe(
            "Extra environment variables for this command. The thread pools (OMP_NUM_THREADS, OPENBLAS_NUM_THREADS, MKL_NUM_THREADS) " +
                "default to 1, and the core count that a script reads is the CPU quota of the grant. For one multi-threaded process, " +
                "raise the thread variables here, and keep workers × threads within the quota.",
        ),
    timeoutSeconds: z.number().int().positive().optional().describe("Per-command timeout in seconds. Default 3600."),
});

/** Extensions that mark an argv token as the thing being run, not a flag or a data path. */
const SCRIPT_EXTENSIONS = [".py", ".R", ".r", ".sh", ".js", ".ts", ".ipynb"];

/** The first script-like token in an argv, or `undefined` when none looks like one. */
/** A shell line runs as a one-element argv, which the sandbox runs through `sh -c`. */
function argvOf(command: string | readonly string[]): readonly string[] {
    return typeof command === "string" ? [command] : command;
}

function scriptToken(command: readonly string[]): string | undefined {
    return command.find((arg) => SCRIPT_EXTENSIONS.some((extension) => arg.endsWith(extension)));
}

const hasScriptExtension = (word: string): boolean => SCRIPT_EXTENSIONS.some((extension) => word.endsWith(extension));

/** What ends a word of a shell line beside whitespace: an operator, a grouping mark, a quote, or the `=` of an option. */
const SHELL_WORD_BREAKS: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r", ";", "|", "&", "<", ">", "(", ")", "'", '"', "`", "="]);

/** The words of a shell line. A walk over the characters, with no regular expression over model text. */
function shellWords(line: string): string[] {
    const words: string[] = [];
    let word = "";
    for (const char of line) {
        if (!SHELL_WORD_BREAKS.has(char)) {
            word += char;
            continue;
        }
        if (word.length > 0) words.push(word);
        word = "";
    }
    if (word.length > 0) words.push(word);
    return words;
}

/** The most directories that the words of one shell line resolve against. A line has one `cd`, or a small number. */
const MAX_SHELL_DIRECTORIES = 8;

/** The most script paths inside shell lines that one command gets a digest check for. A command names one script, or a small number. */
const MAX_CHECKED_SCRIPTS = 16;

/**
 * Each absolute path that a command can run as a script, for the digest check before the run. An argv element can
 * be a shell line, for example the one element of an `sh -c` call or the string after `bash -c`, thus each element
 * gives its words also. A `cd` in a line moves the words after it, and a subshell can end that move. Thus a
 * relative word resolves against each directory that a `cd` before it can give, and against the cwd of the command. The check
 * compares a digest and writes no script, thus a path that the command does not run costs one read.
 */
export function scriptPathsOf(command: readonly string[], cwd: string): string[] {
    // An element of a direct argv is one path, also when it holds a space. These paths come first and have no
    // bound, thus a long element before the script cannot use the bound of the words.
    const paths = new Set<string>(command.length > 1 ? command.filter(hasScriptExtension).map((arg) => posixPath.resolve(cwd, arg)) : []);
    const bound = paths.size + MAX_CHECKED_SCRIPTS;
    const add = (base: string, word: string): void => {
        if (paths.size < bound) paths.add(posixPath.resolve(base, word));
    };
    for (const arg of command) {
        const words = shellWords(arg);
        // Each directory that a word of the line can run in, the newest first. A subshell or a failed `cd` ends a
        // move, and the host does not parse the scopes of the shell. Thus a `cd` adds a directory for each
        // directory before it, and takes none away.
        let dirs: readonly string[] = [cwd];
        for (const [index, word] of words.entries()) {
            const target = word === "cd" ? words[index + 1] : undefined;
            // A target that the shell expands (`~`, `$HOME`, `-`) names no directory that the host can resolve.
            if (target !== undefined && !["-", "~", "$"].some((mark) => target.startsWith(mark))) {
                const moved = dirs.map((dir) => posixPath.resolve(dir, target));
                dirs = [...new Set([...moved, ...dirs])].slice(0, MAX_SHELL_DIRECTORIES);
            }
            if (!hasScriptExtension(word)) continue;
            for (const dir of dirs) add(dir, word);
        }
    }
    return [...paths];
}

/**
 * The analysis-relative path of the script that an argv runs, resolved against the cwd of the exec. A one-element
 * argv is a shell line, thus its words are the tokens. A script outside the mount is no file of the analysis, and
 * it gives `undefined`.
 */
function analysisScriptPath(command: readonly string[], cwd: string, mountRoot: string): string | undefined {
    const tokens = command.length === 1 ? collapseWhitespace(command[0] ?? "").split(" ") : command;
    const token = scriptToken(tokens);
    if (token === undefined) return undefined;
    const relative = stripMountPrefix(mountRoot, posixPath.resolve(cwd, token));
    return relative.startsWith("/") ? undefined : relative;
}

/** What one exec leaves for the lineage collector of the step. */
type ExecCallRecord = {
    readonly command: readonly string[];
    /** The analysis-relative path of the script that the command ran. */
    scriptPath?: string;
    readonly exitCode: number | null;
    readonly durationMs: number | null;
    provenance?: ProvenanceFrame;
    /** The decision-record writes of the script check before the exec, for the mutator. */
    recordWrites?: readonly WriteRecord[];
};

type ExecuteCommandResult = {
    readonly status: "ok";
    readonly note?: string;
    /** The decision records that the host wrote to the step again before the command ran, because a copy was absent or changed. */
    readonly decision_records_restored?: readonly string[];
} & BoundedExecResult;

/** What the agent must know about a result that is not a plain exit: a timeout, a dropped end of a stream, or an ended sandbox. */
function execNote(result: BoundedExecResult): string | undefined {
    const notes: string[] = [];
    if (result.syntheticFailure !== undefined) {
        notes.push(
            "The sandbox ended under the command" +
                (result.syntheticFailure.reason === "sandbox-oom-killed" ? ": the command passed the memory limit." : ".") +
                " The command can have left partial files, and nothing runs it again. The next command runs on a new sandbox of the same size; " +
                "call `acquire_sandbox` with a larger size for more memory.",
        );
    }
    if (result.timedOut) notes.push("The timeout stopped the command.");
    if (result.stdoutTruncated || result.stderrTruncated) {
        notes.push(`A stream passed the cap of ${EXEC_STREAM_BYTE_CAP / (1024 * 1024)} MiB, and its end was dropped. Write long output to a file in logs/.`);
    }
    return notes.length === 0 ? undefined : notes.join(" ");
}

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
     * The workspace filesystem, the mutator of the step, and the host copies of
     * the decision records, for the record check of a script the command runs.
     * All absent (a read-only agent), no record is read or written.
     */
    readonly workspaceFilesystem?: WorkspaceFilesystem;
    readonly mutator?: WorkspaceMutator;
    readonly records?: DecisionRecordStore;
};

export function createExecuteCommandTool(
    deps: ExecuteCommandDeps,
): Tool<z.infer<typeof ExecuteCommandInputSchema>, ExecuteCommandResult | WithToolCallRecord<ExecuteCommandResult, ExecCallRecord>> {
    const { lease, defaultCwd, lineageCollector, mountRoot } = deps;
    const recordLogger = (deps.logger ?? createNoopLogger()).named("execute_command").named("decision-record");

    return defineTool({
        id: "execute_command",
        ownStep: true,
        description:
            "Run a command in the sandbox and return its stdout/stderr/exit code. " +
            "A command runs only on the sandbox that `acquire_sandbox` granted, thus acquire it before the first command. " +
            "Use it for scripts, CLI tools, and shell pipes; read and write files with the file tools, which need no sandbox. " +
            "A failed command is data, not an error: read `exitCode`. stdout and stderr are not a deliverable, thus a result that " +
            "you only print is lost. Write a script, and persist its outputs to output/.",
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
        describeCall: ({ command }) => {
            const argv = argvOf(command);
            return scriptToken(argv) ?? argv.join(" ");
        },
        execute: async (
            { command: input, cwd, env, timeoutSeconds },
            ctx,
        ): Promise<Result<ExecuteCommandResult | WithToolCallRecord<ExecuteCommandResult, ExecCallRecord>, ToolError>> => {
            const command = argvOf(input);
            const effectiveCwd = cwd === undefined ? defaultCwd : cwd.startsWith("/") ? cwd : posixPath.join(defaultCwd, cwd);

            // Each script the command names, as the sandbox resolves it, also inside a shell line. A relative path
            // resolves against the cwd of the command, which is a `/{analysisId}/...` path, thus the workspace
            // filesystem resolves it the same way.
            const recordWrites: WriteRecord[] = [];
            const restored: string[] = [];
            if (deps.workspaceFilesystem && deps.mutator && deps.records) {
                for (const scriptPath of scriptPathsOf(command, effectiveCwd)) {
                    const checked = await reconcileScriptRecord({
                        filesystem: deps.workspaceFilesystem,
                        mutator: deps.mutator,
                        records: deps.records,
                        session: ctx.session,
                        invocationId: ctx.invocationId,
                        toolName: "execute_command",
                        scriptPath,
                    });
                    if (checked.status === "noted") recordWrites.push(...checked.writes);
                    if (checked.status === "restored") recordWrites.push(checked.write);
                    if (checked.status === "noted" && !checked.copyWritten) {
                        recordLogger.warn("the copy of a decision record in the step takes no write, thus only the host copy holds the change", {
                            path: decisionRecordPathFor(scriptPath) ?? scriptPath,
                        });
                    }
                    if (checked.status === "restored" || (checked.status === "noted" && checked.restored)) {
                        const recordPath = decisionRecordPathFor(scriptPath) ?? scriptPath;
                        restored.push(recordPath);
                        recordLogger.warn("the copy of a decision record in the step was absent or changed, thus the host wrote it again", {
                            path: recordPath,
                        });
                    }
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

            const execResult = boundExecResult(result);
            const note = execNote(execResult);
            const plain: ExecuteCommandResult =
                restored.length > 0 ? { status: "ok", decision_records_restored: restored, ...execResult } : { status: "ok", ...execResult };
            const bounded: ExecuteCommandResult = note === undefined ? plain : { ...plain, note };
            if ((!lineageCollector || !mountRoot) && recordWrites.length === 0) return ok(bounded);
            const record: ExecCallRecord = {
                command,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
            };
            if (result.provenance) record.provenance = result.provenance;
            const scriptPath = mountRoot === undefined ? undefined : analysisScriptPath(command, effectiveCwd, mountRoot);
            if (scriptPath !== undefined) record.scriptPath = scriptPath;
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
                    scriptPath: record.scriptPath,
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
