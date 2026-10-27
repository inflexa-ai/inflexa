/**
 * install_from_source — build a package no index serves, from its source, in a
 * build session the embedder holds.
 *
 * The tool is the agent face of the `BuildSession` interface. It exists only
 * when the embedder binds the interface: the conversation composition adds it
 * to its roster, and no sandbox roster holds it, because an acquisition is a
 * host action. The tool drives the session call by call — `start`, then `exec`
 * reads in the exploration phase, then the plan ask, then per-command asks in
 * the build phase, then the commit ask — and writes no store state itself: one
 * clean run of the approved script is the only writer.
 *
 * A rejection of any ask ends the session and rethrows `AskRejectedError`
 * (deliberately not caught, matching `run_inflexa`): the loop maps the throw to
 * an execution-denied result and ends the turn.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { errorMessageOf } from "../lib/thrown.js";
import { textOf } from "../lib/unknown-text.js";
import { keptTextOf, pairSafeIndex, TOOL_RESULT_CAP, toolOutputRef, type ToolOutputStore } from "../loop/tool-output.js";
import type { BuildExecResult, BuildPlan, BuildSession, BuildSource } from "../sandbox/types.js";
import { defineTool, type Tool, type ToolContext, type ToolError } from "./define-tool.js";

/** The room the fixed fields of an exec result leave under the tool-result cap. */
const RESULT_BUDGET = TOOL_RESULT_CAP - 512;

export type InstallFromSourceDeps = {
    readonly buildSession: BuildSession;
    readonly toolOutputStore?: ToolOutputStore;
};

/** One live session of this process. A session ends at its stop, at a completed commit, or at a rejection. */
type SessionState = {
    readonly source: BuildSource;
    readonly commit?: string;
    readonly workingDir: string;
    readonly classHosts?: readonly string[];
    seq: number;
    plan?: BuildPlan;
};

export type InstallFromSourceResult =
    | {
          readonly status: "started";
          readonly sessionId: string;
          readonly source: string;
          readonly commit?: string;
          readonly workingDir: string;
          readonly note: string;
      }
    | {
          readonly status: "ran";
          readonly sessionId: string;
          readonly execId: string;
          readonly exitCode: number | null;
          readonly timedOut: boolean;
          readonly output: string;
          readonly kept?: { readonly ref: string; readonly keptLength: number };
      }
    | { readonly status: "committed"; readonly pin: string; readonly storeDir: string; readonly note: string }
    | { readonly status: "clean_run_failed"; readonly sessionId: string; readonly reason: string; readonly note: string }
    | { readonly status: "plan_required"; readonly sessionId: string; readonly note: string }
    | { readonly status: "stopped"; readonly sessionId: string }
    | { readonly status: "session_ended"; readonly sessionId: string }
    | { readonly status: "unknown_session"; readonly sessionId: string }
    | { readonly status: "failed"; readonly reason: string };

const START_NOTE =
    "The session is in its exploration phase: its network holds the host of the source alone. " +
    "Read the repository (the README, the file layout, the build files) and install nothing. " +
    "Send the first build command with `hosts`, `aptPackages`, and `strategy` to raise the plan approval.";

const CLEAN_RUN_FAILED_NOTE =
    "The clean run wrote nothing; the same session stays open. The session held a state the script does not make — " +
    "correct the script through further exec calls, then commit again.";

const COMMITTED_NOTE =
    "The package landed in the store from one clean run of the script. The session ended; link the package into a farm with `link_packages`.";

const PLAN_REQUIRED_NOTE = "A commit needs an approved plan first: send the first build command with `hosts`, `aptPackages`, and `strategy`.";

const EXPLORATION_ROOT_NOTE =
    "Root is a build-phase capability: no exploration command runs as root. Approve the plan first — send the first build " +
    "command with `hosts`, `aptPackages`, and `strategy` — then re-run the command with `root: true`.";

const InstallFromSourceInputSchema = z
    .object({
        op: z
            .enum(["start", "exec", "commit", "stop"])
            .describe(
                "Which step of the build session to run. " +
                    "'start' — begin a session for one source (`gitUrl`, optionally `gitRef`, or `folder`). " +
                    "'exec' — run one command in the session (`sessionId`, `command`). " +
                    "'commit' — run the clean build (`sessionId`, `script`). " +
                    "'stop' — end the session (`sessionId`).",
            ),
        gitUrl: z.string().min(1).optional().describe("For 'start': the git URL of the source, for example https://github.com/tacazares/SeedMatchR."),
        gitRef: z
            .string()
            .min(1)
            .optional()
            .describe("For 'start' with `gitUrl`: a branch, a tag, or a commit sha to build at. Absent builds the head of the default branch."),
        folder: z.string().min(1).optional().describe("For 'start': the local folder path of the source."),
        sessionId: z.string().min(1).optional().describe("For 'exec', 'commit', and 'stop': the session id that 'start' returned."),
        command: z
            .string()
            .min(1)
            .optional()
            .describe("For 'exec': the one command to run. Each exec is a fresh shell — use absolute paths or `cd <dir> && <command>`."),
        root: z
            .boolean()
            .optional()
            .describe(
                "For 'exec': run this command as root. The default is the non-root user of the image. Pass true only when the command needs it (for example apt-get); the approval says that the command runs as root.",
            ),
        hosts: z
            .array(z.string().min(1))
            .min(1)
            .optional()
            .describe(
                "For the first 'exec' of the build phase, and for an amended plan: every host the session egress must hold — the apt snapshot host, the Python index, the pak repositories, and any host the build itself contacts.",
            ),
        aptPackages: z
            .array(z.string().min(1))
            .optional()
            .describe("For the first 'exec' of the build phase: the apt packages the build installs, each by name."),
        strategy: z
            .string()
            .min(1)
            .optional()
            .describe("For the first 'exec' of the build phase: the build strategy you propose — the standard path, or what custom steps it needs and why."),
        script: z
            .string()
            .min(1)
            .optional()
            .describe(
                "For 'commit': the build script — the exact commands that worked in the session, building exactly one root artifact into /work/out (the clean run starts in the read-only /work/src, so a build that writes into the tree copies it first) and installing no dependencies.",
            ),
    })
    .refine((d) => d.op !== "start" || (d.gitUrl !== undefined) !== (d.folder !== undefined), {
        message: "start needs exactly one source: pass `gitUrl` (optionally with `gitRef`) or `folder`, never both and never neither",
        path: ["gitUrl"],
    })
    .refine((d) => d.op !== "start" || d.gitRef === undefined || d.gitUrl !== undefined, {
        message: "gitRef rides on a gitUrl source — pass `gitUrl` too, or use `folder`",
        path: ["gitRef"],
    })
    .refine((d) => d.op === "start" || d.sessionId !== undefined, {
        message: "sessionId is required for this op — copy it from the 'start' result",
        path: ["sessionId"],
    })
    .refine((d) => d.op !== "exec" || d.command !== undefined, {
        message: "command is required when op is 'exec' — the one command this call runs",
        path: ["command"],
    })
    .refine((d) => d.op !== "commit" || d.script !== undefined, {
        message: "script is required when op is 'commit' — the build script the clean run executes",
        path: ["script"],
    })
    .refine(
        (d) =>
            d.op !== "exec" ||
            (d.hosts === undefined && d.aptPackages === undefined && d.strategy === undefined) ||
            (d.hosts !== undefined && d.aptPackages !== undefined && d.strategy !== undefined),
        {
            message: "the plan travels as one piece — pass `hosts`, `aptPackages`, and `strategy` together, on the first build command or on an amendment",
            path: ["hosts"],
        },
    );

/** The source as one line an ask or a result shows. */
function renderSource(source: BuildSource, commit?: string): string {
    if (source.kind === "folder") return `the local folder ${source.path}`;
    const ref = source.ref === undefined ? "" : ` (ref ${source.ref})`;
    return `${source.url}${ref} at commit ${commit ?? "unresolved"}`;
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** The complete host list the session will carry: the hosts the plan adds beside the fixed hosts of the class, because the user approves exactly what the wall will allow. */
const completeHosts = (state: SessionState, hosts: readonly string[]): readonly string[] => [...new Set([...hosts, ...(state.classHosts ?? [])])];

/** A plan the user already approved, resent unchanged, asks nothing and restarts nothing. */
const samePlan = (a: BuildPlan, b: BuildPlan): boolean => a.strategy === b.strategy && sameLines(a.hosts, b.hosts) && sameLines(a.aptPackages, b.aptPackages);

/** The two streams of one exec as the one log the model reads. */
function combinedOutput(stdout: string, stderr: string): string {
    if (stdout.length === 0) return stderr;
    if (stderr.length === 0) return stdout;
    return `${stdout}\n--- stderr ---\n${stderr}`;
}

export function createInstallFromSourceTool(deps: InstallFromSourceDeps): Tool<z.infer<typeof InstallFromSourceInputSchema>, InstallFromSourceResult> {
    const sessions = new Map<string, SessionState>();
    const ended = new Set<string>();

    const failureOf = (cause: unknown): string => errorMessageOf(cause) ?? textOf(cause);

    /** A session the user refused to continue ends here: the container must not outlive the refusal. */
    async function stopAfterRejection(sessionId: string): Promise<void> {
        sessions.delete(sessionId);
        ended.add(sessionId);
        try {
            await deps.buildSession.stop(sessionId);
        } catch {
            // The denial the user sees outranks a cleanup failure; a stopped host process cleans the container as debris.
        }
    }

    /** Ask the plan, then bind it. A rejection ends the session and leaves the throw to the loop. */
    async function askPlan(ctx: ToolContext, sessionId: string, state: SessionState, plan: BuildPlan): Promise<void> {
        const amended = state.plan !== undefined;
        try {
            await ctx.ask({
                title: amended ? "Approve the amended source-build plan" : "Approve the source-build plan",
                command: `${amended ? "restart" : "start"} the build phase of ${renderSource(state.source, state.commit)} under hosts: ${plan.hosts.join(", ")}`,
                detail:
                    `Source: ${renderSource(state.source, state.commit)}\n` +
                    `Egress hosts of the session: ${plan.hosts.join(", ")}\n` +
                    `apt packages: ${plan.aptPackages.length > 0 ? plan.aptPackages.join(", ") : "none"}\n` +
                    `Strategy: ${plan.strategy}\n` +
                    `Approving ${amended ? "restarts the session container under this host list" : "moves the session to its build phase under this host list"}; each command still asks on its own.`,
            });
        } catch (cause) {
            await stopAfterRejection(sessionId);
            throw cause;
        }
        state.plan = plan;
    }

    async function askCommand(ctx: ToolContext, sessionId: string, command: string, root: boolean): Promise<void> {
        try {
            await ctx.ask({
                title: "Run build-session command",
                command,
                detail: `${root ? "This command runs as root in the build session. " : ""}Approving "always" runs the remaining commands of THIS session without asking each time.`,
                grantKey: `install_from_source:${sessionId}`,
            });
        } catch (cause) {
            await stopAfterRejection(sessionId);
            throw cause;
        }
    }

    async function askCommit(ctx: ToolContext, sessionId: string, state: SessionState, script: string): Promise<void> {
        try {
            await ctx.ask({
                title: "Approve the source-build commit",
                command: `run one clean build of ${renderSource(state.source, state.commit)} from the pristine snapshot`,
                detail:
                    `Build script:\n${script}\n\n` +
                    `Build record preview — source: ${renderSource(state.source, state.commit)}; ` +
                    `egress hosts: ${state.plan?.hosts.join(", ") ?? "none"}; ` +
                    `apt packages: ${state.plan?.aptPackages.join(", ") || "none"}. ` +
                    "The committed record also holds the image digests, the apt snapshot date, and the tool versions of the clean run.",
            });
        } catch (cause) {
            await stopAfterRejection(sessionId);
            throw cause;
        }
    }

    /** The exec result under the tool-result cap, with the whole log kept for `read_tool_output` when a store is wired. */
    async function renderExec(ctx: ToolContext, sessionId: string, r: BuildExecResult): Promise<Extract<InstallFromSourceResult, { status: "ran" }>> {
        const full = combinedOutput(r.stdout, r.stderr);
        const base = {
            status: "ran" as const,
            sessionId,
            execId: r.execId,
            exitCode: r.exitCode,
            timedOut: r.timedOut,
        };
        let shown = full;
        let output: Extract<InstallFromSourceResult, { status: "ran" }> = { ...base, output: shown };
        while (JSON.stringify(output).length > RESULT_BUDGET && shown.length > 0) {
            shown = shown.slice(0, pairSafeIndex(shown, Math.floor((shown.length * 3) / 4), -1));
            output = { ...base, output: shown };
        }
        if (shown.length >= full.length || deps.toolOutputStore === undefined) return output;

        const content = keptTextOf(full);
        const ref = toolOutputRef(`${ctx.session.scope.analysisId}:${r.execId}`);
        const threadId = ctx.session.runFrame === undefined ? ctx.session.scope.threadId : undefined;
        const put = await deps.toolOutputStore.put({
            analysisId: ctx.session.scope.analysisId,
            ref,
            toolName: "install_from_source",
            toolCallId: ctx.invocationId,
            threadId,
            content,
            totalLength: full.length,
        });
        return put.isOk() ? { ...output, kept: { ref, keptLength: content.length } } : output;
    }

    return defineTool({
        id: "install_from_source",
        description:
            "Build an R or Python package that no package index serves, from its source, and land it in the package store — " +
            "for example a package that lives only as a fork on GitHub at a pinned commit, or one that exists only as a folder on the local disk. " +
            "The source is a git URL (optionally at a ref or a commit) or a local folder. " +
            "The tool drives a host-held build session, one call per step: " +
            '`op: "start"` with `gitUrl` (plus optional `gitRef`) or `folder` — the host resolves the ref to a full commit sha and the tree lands before the first command; ' +
            '`op: "exec"` with `sessionId` and one `command`; ' +
            '`op: "commit"` with `sessionId` and the build `script`; ' +
            '`op: "stop"` with `sessionId`. ' +
            "THE FLOW: start begins an EXPLORATION phase — the session network holds the host of the source alone, so read the repository (the README, the file layout, the DESCRIPTION or pyproject, the build files) and install nothing. " +
            "When you know the build, send the FIRST build command with the plan fields `hosts`, `aptPackages`, and `strategy`: the user approves the plan (the source, the commit, the hosts, the apt packages, the strategy), " +
            'and each further command asks on its own; an "always" covers the commands of THIS session only. ' +
            "Pass `root: true` only for a command that needs it (for example apt-get); its approval says that the command runs as root. " +
            "When a command fails at the egress wall for a host the plan did not name, add the host to `hosts` and send the amended plan with the next command — the user approves the wider list and the session restarts under it. " +
            "Each exec is a FRESH shell: a `cd` or an `export` of one call never persists into the next. " +
            "Use absolute paths or `cd <dir> && <command>`; the default working directory is the working-copy root of the session (the `workingDir` of the start result). " +
            "TRY THE STANDARD PATH FIRST: for R, a pak lockfile resolve of the local source tree, which pulls the CRAN and Bioconductor dependencies; " +
            "for Python, a wheel build of the tree, then a hash-pinned resolve of the wheel's requirements. Custom steps are for when the standard path fails, and the plan names the strategy you propose. " +
            "THE IDENTITY AND VERSION COME FROM THE PACKAGE METADATA — the `Package` and `Version` fields of the DESCRIPTION for R, the `.dist-info` of the built wheel for Python — " +
            "never from the repository name, and never ask the user for a version. " +
            "WHEN THE BUILD WORKS, write the commands that worked into one build script and commit it: the script contract is fixed — the clean run starts in the READ-ONLY /work/src, so a build that writes into the tree copies it first, and exactly one root artifact lands in /work/out — the user approves the script and the build record, " +
            "and one clean run of the script in a new container over the pristine snapshot — that run alone writes the store. " +
            "A failed clean run returns to the SAME session: the session held a state the script does not make, so correct the script there and commit again. " +
            'STOP the session (`op: "stop"`) when the build is done or the user refuses to continue. ' +
            "Exec output obeys the tool-result cap; a longer log comes back cut with a reference you read through `read_tool_output`.",
        inputSchema: InstallFromSourceInputSchema,
        describeCall: (input) => {
            switch (input.op) {
                case "start":
                    return `start a source build from ${input.gitUrl ?? input.folder ?? "no source"}`;
                case "exec":
                    return input.command;
                case "commit":
                    return `commit the build script (${input.script?.split("\n").length ?? 0} lines)`;
                case "stop":
                    return `stop session ${input.sessionId ?? "unknown"}`;
            }
        },
        execute: async (input, ctx): Promise<Result<InstallFromSourceResult, ToolError>> => {
            switch (input.op) {
                case "start": {
                    const source: BuildSource =
                        input.gitUrl !== undefined ? { kind: "git", url: input.gitUrl, ref: input.gitRef } : { kind: "folder", path: input.folder ?? "" };
                    try {
                        const handle = await deps.buildSession.start(source, ctx.session.scope.analysisId);
                        sessions.set(handle.sessionId, { source, commit: handle.commit, workingDir: handle.workingDir, classHosts: handle.classHosts, seq: 0 });
                        return ok({
                            status: "started",
                            sessionId: handle.sessionId,
                            source: renderSource(source, handle.commit),
                            commit: handle.commit,
                            workingDir: handle.workingDir,
                            note: START_NOTE,
                        });
                    } catch (cause) {
                        return ok({ status: "failed", reason: failureOf(cause) });
                    }
                }
                case "exec": {
                    const sessionId = input.sessionId ?? "";
                    const state = sessions.get(sessionId);
                    if (state === undefined) {
                        return ok(ended.has(sessionId) ? { status: "session_ended", sessionId } : { status: "unknown_session", sessionId });
                    }
                    // Root is a build-phase capability: the exploration
                    // container walls the source host alone and runs reads,
                    // thus a root marker with no plan riding the call and none
                    // approved asks for a phase the session never reached. A
                    // call that carries the plan fields may be root — the first
                    // build command is usually a root apt-get.
                    const plan: BuildPlan | undefined =
                        input.hosts !== undefined && input.aptPackages !== undefined && input.strategy !== undefined
                            ? { hosts: completeHosts(state, input.hosts), aptPackages: input.aptPackages, strategy: input.strategy }
                            : undefined;
                    if (state.plan === undefined && plan === undefined && input.root === true) {
                        return ok({ status: "plan_required", sessionId, note: EXPLORATION_ROOT_NOTE });
                    }
                    // The plan ask precedes every build command; an unchanged plan asks nothing and restarts nothing.
                    const planToAsk = plan !== undefined && (state.plan === undefined || !samePlan(plan, state.plan)) ? plan : undefined;
                    if (planToAsk !== undefined) {
                        await askPlan(ctx, sessionId, state, planToAsk);
                    }
                    // A command of the build phase asks on its own; an exploration read needs no ask,
                    // because its container holds no store mount and its egress holds the source host alone.
                    if (state.plan !== undefined) {
                        await askCommand(ctx, sessionId, input.command ?? "", input.root === true);
                    }
                    state.seq += 1;
                    const execId = `${sessionId}-${state.seq}`;
                    try {
                        const r = await deps.buildSession.exec(sessionId, { command: input.command ?? "", execId, root: input.root, plan: planToAsk });
                        return ok(await renderExec(ctx, sessionId, r));
                    } catch (cause) {
                        return ok({ status: "failed", reason: failureOf(cause) });
                    }
                }
                case "commit": {
                    const sessionId = input.sessionId ?? "";
                    const state = sessions.get(sessionId);
                    if (state === undefined) {
                        return ok(ended.has(sessionId) ? { status: "session_ended", sessionId } : { status: "unknown_session", sessionId });
                    }
                    if (state.plan === undefined) {
                        return ok({ status: "plan_required", sessionId, note: PLAN_REQUIRED_NOTE });
                    }
                    await askCommit(ctx, sessionId, state, input.script ?? "");
                    try {
                        const outcome = await deps.buildSession.commit(sessionId, input.script ?? "");
                        if (outcome.kind === "committed") {
                            sessions.delete(sessionId);
                            ended.add(sessionId);
                            return ok({ status: "committed", pin: outcome.pin, storeDir: outcome.storeDir, note: COMMITTED_NOTE });
                        }
                        return ok({ status: "clean_run_failed", sessionId, reason: outcome.reason, note: CLEAN_RUN_FAILED_NOTE });
                    } catch (cause) {
                        return ok({ status: "failed", reason: failureOf(cause) });
                    }
                }
                case "stop": {
                    const sessionId = input.sessionId ?? "";
                    if (!sessions.has(sessionId)) {
                        return ok(ended.has(sessionId) ? { status: "session_ended", sessionId } : { status: "unknown_session", sessionId });
                    }
                    try {
                        await deps.buildSession.stop(sessionId);
                    } catch (cause) {
                        return ok({ status: "failed", reason: failureOf(cause) });
                    }
                    sessions.delete(sessionId);
                    ended.add(sessionId);
                    return ok({ status: "stopped", sessionId });
                }
            }
        },
    });
}
