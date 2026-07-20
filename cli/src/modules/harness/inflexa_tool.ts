/**
 * run_inflexa — let the conversation agent drive the local `inflexa` CLI.
 *
 * The tool takes an argv (the words that would follow `inflexa` on a shell),
 * classifies it WITHOUT running anything ({@link classifyInflexaArgv}), and then:
 *   - malformed argv    → an `invalid` data variant (no spawn, no prompt);
 *   - introspection      → runs immediately (help/version describe the CLI and
 *                          touch no user data), returning its captured output;
 *   - a real action      → pauses on `ctx.ask` for the user's approval, then runs.
 *
 * The subprocess is a plain child process — the same way the agent shells out to
 * any other command — so the CLI's own commands stay the single implementation of
 * what `inflexa` does; this tool is only the bridge that lets the agent invoke it.
 */

import { join } from "node:path";

import { defineTool, type AskRequest, type ToolError } from "@inflexa-ai/harness";
import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { env } from "../../lib/env.ts";
import { classifyInflexaArgv, toEffectiveArgv } from "./inflexa_classify.ts";

/** Cap on each captured stream so one runaway command cannot overflow the turn's context. */
const MAX_OUTPUT_CHARS = 60_000;

/** Default wall-clock bound on a single `inflexa` invocation before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Commands the agent may not run at all — not even with approval. These open an
 * interactive terminal UI, which cannot function as a captured subprocess: with
 * stdin ignored and stdout/stderr piped there is no terminal to drive, so the
 * child renders into a non-TTY pipe and hangs until the timeout. Keyed by the
 * classifier's resolved subcommand path (its `grantKey`); the value is the reason
 * handed back to the model. Checked BEFORE `ctx.ask`, because a command that can
 * never usefully run is not a decision to put to the user.
 */
const BLOCKED_COMMANDS: ReadonlyMap<string, string> = new Map([
    ["inflexa", "Bare `inflexa` opens the interactive terminal UI, which cannot run as a captured subprocess. It is not available to you."],
    ["inflexa config", "`inflexa config` opens the interactive settings UI, which cannot run as a captured subprocess. It is not available to you."],
]);

/**
 * The outcome the model sees, as data on the ok channel — every expected result
 * is a variant here, never a thrown error (a denied `ctx.ask` is the one throw,
 * and it is the harness loop's to map). `invalid` is a rejected argv; `blocked`
 * is a command the agent may not run (an interactive TUI launcher); `ran` is a
 * completed process (any exit code — a non-zero exit is a real answer, not a tool
 * failure); `timed_out` is a process abandoned at the deadline.
 */
export type RunInflexaResult =
    | { readonly status: "invalid"; readonly message: string }
    | { readonly status: "blocked"; readonly message: string }
    | { readonly status: "ran"; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
    | { readonly status: "timed_out" };

/** Captured result of one `inflexa` subprocess. `timedOut` distinguishes a deadline kill from a real exit. */
export type SubprocessResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean };

/** The subprocess seam — injectable so tests assert on the composed argv without spawning a real process. */
export type RunSubprocess = (cmd: readonly string[], signal: AbortSignal) => Promise<SubprocessResult>;

/**
 * Resolve the OS-level command that runs `argv` through `inflexa`.
 *
 * A dev run has no compiled binary, so the CLI source entry is executed by the
 * `bun` runtime (`execPath`) — `[bun, src/index.ts, ...argv]`. A release binary is
 * itself the `inflexa` executable, so `execPath` already IS the CLI —
 * `[inflexa, ...argv]`. Pure and injectable so both shapes are unit-testable.
 */
export function resolveInvocation(argv: readonly string[], opts: { isDevelopment: boolean; execPath: string; scriptPath: string }): string[] {
    return opts.isDevelopment ? [opts.execPath, opts.scriptPath, ...argv] : [opts.execPath, ...argv];
}

/** Truncate a captured stream to {@link MAX_OUTPUT_CHARS}, marking the cut so the model knows output was dropped. */
function truncateOutput(text: string): string {
    return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(0, MAX_OUTPUT_CHARS) + "…[truncated]";
}

/**
 * The real subprocess wrapper: spawn `cmd`, capture stdout/stderr, and bound the
 * run by `timeoutMs`. The timeout and the caller's `signal` (chat disconnect) are
 * merged — either aborts the child — but only the timeout's firing is reported as
 * `timedOut`, so a user-cancelled run is not mislabelled a timeout.
 *
 * Not wrapped in a Result: this is the throwing-boundary seam itself (mirrors
 * `lib/container.ts`'s `capture`). A spawn that fails to launch is an unexpected
 * fault — it throws, and the loop's dispatch maps it to an error tool result.
 */
async function spawnInflexa(cmd: readonly string[], signal: AbortSignal, timeoutMs: number): Promise<SubprocessResult> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);
    // `[...cmd]` copies the readonly argv into the mutable array `Bun.spawn` expects.
    const proc = Bun.spawn({ cmd: [...cmd], stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: combined });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr, timedOut: timeoutSignal.aborted };
}

/** Construction deps for {@link createRunInflexaTool}; every field defaults to the real host value, overridable in tests. */
export interface RunInflexaToolDeps {
    readonly runSubprocess?: RunSubprocess;
    readonly isDevelopment?: boolean;
    readonly execPath?: string;
    readonly scriptPath?: string;
    readonly timeoutMs?: number;
}

/**
 * Build the `run_inflexa` conversation tool. Defaults wire the real host: the
 * baked dev/release channel, this process's `bun`/binary path, the source entry
 * beside this module, and a real timeout-bounded spawn.
 */
export function createRunInflexaTool(deps: RunInflexaToolDeps = {}) {
    const isDevelopment = deps.isDevelopment ?? env.isDevelopment;
    const execPath = deps.execPath ?? process.execPath;
    // This module lives at src/modules/harness/, so the CLI source entry is two levels up.
    const scriptPath = deps.scriptPath ?? join(import.meta.dir, "../../index.ts");
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const runSubprocess: RunSubprocess = deps.runSubprocess ?? ((cmd, signal) => spawnInflexa(cmd, signal, timeoutMs));

    return defineTool({
        id: "run_inflexa",
        description:
            "Run the local `inflexa` command-line tool. Pass `argv` as the list of words you would type " +
            'after `inflexa` on a shell (e.g. ["--help"], or ["--version"]). Drive it like any unfamiliar ' +
            'command: start from ["--help"] to see the top-level commands, then drill in with ' +
            '["<subcommand>", "--help"] to learn a subcommand\'s arguments and options before you invoke it. ' +
            "Help and version lookups run right away; a command that would actually do something pauses for the " +
            "user's approval first, and the captured stdout, stderr, and exit code come back to you.",
        inputSchema: z.object({
            argv: z
                .array(z.string())
                .describe(
                    "The words to pass to `inflexa`, one per element, exactly as typed on a shell " +
                        '(e.g. ["--help"] or ["<subcommand>", "--help"]). An empty list runs bare `inflexa`.',
                ),
        }),
        execute: async (input, ctx): Promise<Result<RunInflexaResult, ToolError>> => {
            const args = toEffectiveArgv(input.argv);
            const c = await classifyInflexaArgv(args);

            // A rejected argv never reaches a process or a prompt — report it and let the model correct itself.
            if (c.kind === "malformed") return ok({ status: "invalid", message: c.message });

            if (c.kind === "action") {
                // A blocked command (an interactive TUI launcher) can never run as a captured
                // subprocess — refuse it here rather than prompting for something that would hang.
                const blockedReason = BLOCKED_COMMANDS.get(c.grantKey);
                if (blockedReason !== undefined) return ok({ status: "blocked", message: blockedReason });

                const request: AskRequest = {
                    title: "Run inflexa command",
                    // The EXACT argv that will run — what the user approves is precisely what executes, nothing hidden.
                    command: ["inflexa", ...args].join(" "),
                    detail: 'Approving "always" lets this inflexa subcommand run again in this analysis without asking each time.',
                    // Trade-off accepted here: the standing grant keys on the bare subcommand PATH, not this exact
                    // argv, so an "always" on a benign `inflexa X` also blesses a later, more dangerous flag variant
                    // (`inflexa X --destructive`) of the same subcommand without a fresh prompt. That is tolerable
                    // because `command` above always shows the EXACT argv at the moment consent is given — nothing is
                    // hidden when the user decides; only a silent RE-RUN of the same subcommand is what the grant covers.
                    grantKey: c.grantKey,
                };
                // `ctx.ask` throws `AskRejectedError` on denial. Deliberately NOT caught: the harness loop maps the
                // throw to an execution-denied tool result and ends the turn, which is exactly the denial behavior.
                await ctx.ask(request);
            }

            // Introspection and an approved action both reach here and run the same way.
            const cmd = resolveInvocation(args, { isDevelopment, execPath, scriptPath });
            const r = await runSubprocess(cmd, ctx.signal);
            if (r.timedOut) return ok({ status: "timed_out" });
            return ok({ status: "ran", exitCode: r.exitCode, stdout: truncateOutput(r.stdout), stderr: truncateOutput(r.stderr) });
        },
    });
}
