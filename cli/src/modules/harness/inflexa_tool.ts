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
 * How long after the child exits its pipes may keep flowing before capture stops.
 * The pipes can outlive the child: a grandchild that inherited them (say, a
 * compose helper the CLI spawned and left running) holds EOF off indefinitely,
 * and waiting for it would wedge the tool long after the child itself finished.
 * One second is ample for an exited child's buffered output to flush.
 */
const FLUSH_GRACE_MS = 1_000;

/**
 * How long after the abort kill (SIGTERM) to wait before escalating to SIGKILL.
 * SIGTERM is trappable, so without the escalation a child that ignores it would
 * hold `exited` open forever and the timeout would bound nothing.
 */
const KILL_GRACE_MS = 2_000;

/**
 * Commands the agent may not run at all — not even with approval. These exist
 * only to open an interactive terminal UI, which cannot function as a captured
 * subprocess; their launchers refuse a non-TTY stdin at entry, so an approved
 * spawn would just burn the user's approval on an immediate error. Refusing here,
 * BEFORE `ctx.ask`, keeps a command that can never usefully run from ever
 * becoming a decision to put to the user. Keyed by the classifier's resolved
 * subcommand path (its `grantKey`); the value is the reason handed to the model.
 *
 * This map is the courtesy layer, not the safety boundary: the launchers' own
 * TTY guard (`requireInteractiveTerminal`, lib/cli.ts) is the structural
 * backstop, so a future TUI command missing from this map exits non-zero with a
 * clear message instead of hanging.
 */
const BLOCKED_COMMANDS: ReadonlyMap<string, string> = new Map([
    ["inflexa", "Bare `inflexa` opens the interactive terminal UI, which cannot run as a captured subprocess. It is not available to you."],
    ["inflexa config", "`inflexa config` opens the interactive settings UI, which cannot run as a captured subprocess. It is not available to you."],
    [
        "inflexa new",
        "`inflexa new` creates an analysis and opens its interactive chat UI, which cannot run as a captured subprocess. " +
            "It is not available to you — ask the user to run it themselves.",
    ],
    [
        "inflexa resume",
        "`inflexa resume` opens an analysis's interactive chat UI, which cannot run as a captured subprocess. " +
            "It is not available to you — ask the user to run it themselves.",
    ],
    // Dev-channel registry only: a release build has no `chat` command, so on a
    // release binary this argv parses as malformed before the map is consulted.
    ["inflexa chat", "`inflexa chat` opens an interactive prompt loop, which cannot run as a captured subprocess. It is not available to you."],
]);

/**
 * The outcome the model sees, as data on the ok channel — every expected result
 * is a variant here, never a thrown error (a denied `ctx.ask` is the one throw,
 * and it is the harness loop's to map). `invalid` is a rejected argv; `blocked`
 * is a command the agent may not run (an interactive TUI launcher); `ran` is a
 * completed process (any exit code — a non-zero exit is a real answer, not a tool
 * failure); `timed_out` is a process abandoned at the deadline, carrying whatever
 * output it produced first (a partial download log still tells the model how far
 * it got); `cancelled` is the turn's own abort — bare, because the turn that
 * would read it is already being torn down.
 */
export type RunInflexaResult =
    | { readonly status: "invalid"; readonly message: string }
    | { readonly status: "blocked"; readonly message: string }
    | { readonly status: "ran"; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
    | { readonly status: "timed_out"; readonly stdout: string; readonly stderr: string }
    | { readonly status: "cancelled" };

/**
 * Captured result of one `inflexa` subprocess. `endedBy` names what ended it: a
 * real `exit`, the tool's `timeout` deadline, or the turn's `cancel`. `exitCode`
 * is always numeric — Bun resolves `exited` to 128+signal for a signal death —
 * but it is only meaningful for `exit`.
 */
export type SubprocessResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly endedBy: "exit" | "timeout" | "cancel" };

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
 * Accumulate a subprocess stream up to `cap` characters while ALWAYS draining to
 * the end: past the cap, chunks are still read and dropped rather than left in
 * the pipe, so a chatty child never blocks on backpressure while the capture
 * stays memory-bounded (buffering a multi-hundred-MB stream just to slice 60k
 * off the front is the failure this exists to prevent).
 */
function collectCapped(stream: ReadableStream<Uint8Array>, cap: number): { done: Promise<void>; cancel: () => void; text: () => string } {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let truncated = false;
    const done = (async () => {
        try {
            for (;;) {
                const { done: eof, value } = await reader.read();
                if (eof) return;
                if (truncated) continue;
                const chunk = decoder.decode(value, { stream: true });
                if (text.length + chunk.length > cap) {
                    text += chunk.slice(0, cap - text.length);
                    truncated = true;
                } else {
                    text += chunk;
                }
            }
        } catch {
            // A stream error (broken pipe after a kill) is an expected end of
            // capture, not a fault: what was read stands as the result.
        }
    })();
    return {
        done,
        /** Stop reading (a pending read settles as done) — for a pipe a grandchild still holds open. */
        cancel: (): void => void reader.cancel().catch(() => {}),
        text: (): string => (truncated ? text + "…[truncated]" : text),
    };
}

/** Injectable process bounds for {@link spawnInflexa}; graces default to the real values, shrinkable in tests. */
export interface SpawnBounds {
    readonly timeoutMs: number;
    readonly flushGraceMs?: number;
    readonly killGraceMs?: number;
}

/**
 * The real subprocess wrapper: spawn `cmd`, capture stdout/stderr memory-bounded,
 * and bound the run by `timeoutMs`. The timeout and the caller's `signal` (chat
 * disconnect / turn abort) are merged — either aborts the child — and `endedBy`
 * reports which one fired (timeout wins a tie: the deadline elapsed either way),
 * so a user cancel is never mislabelled a timeout or a completed run.
 *
 * Not wrapped in a Result: this is the throwing-boundary seam itself (mirrors
 * `lib/container.ts`'s `capture`). A spawn that fails to launch is an unexpected
 * fault — it throws, and the loop's dispatch maps it to an error tool result.
 */
export async function spawnInflexa(cmd: readonly string[], signal: AbortSignal, bounds: SpawnBounds): Promise<SubprocessResult> {
    const { timeoutMs, flushGraceMs = FLUSH_GRACE_MS, killGraceMs = KILL_GRACE_MS } = bounds;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);
    // `[...cmd]` copies the readonly argv into the mutable array `Bun.spawn` expects.
    const proc = Bun.spawn({ cmd: [...cmd], stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: combined });

    // The abort kill is SIGTERM, which a child can trap and outlive; escalate to
    // SIGKILL after a grace so the deadline is a real bound, not a suggestion.
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const escalate = (): void => {
        killTimer = setTimeout(() => proc.kill("SIGKILL"), killGraceMs);
    };
    if (combined.aborted) escalate();
    else combined.addEventListener("abort", escalate, { once: true });

    const stdout = collectCapped(proc.stdout, MAX_OUTPUT_CHARS);
    const stderr = collectCapped(proc.stderr, MAX_OUTPUT_CHARS);
    const exitCode = await proc.exited;
    if (killTimer !== null) clearTimeout(killTimer);

    // The child is gone, but its pipes may not be: give buffered output a short
    // flush window, then stop reading and take what arrived — a grandchild that
    // inherited the pipes must not stall the tool past the child's own exit.
    await Promise.race([Promise.all([stdout.done, stderr.done]), Bun.sleep(flushGraceMs)]);
    stdout.cancel();
    stderr.cancel();

    const endedBy = timeoutSignal.aborted ? "timeout" : signal.aborted ? "cancel" : "exit";
    return { exitCode, stdout: stdout.text(), stderr: stderr.text(), endedBy };
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
    const runSubprocess: RunSubprocess = deps.runSubprocess ?? ((cmd, signal) => spawnInflexa(cmd, signal, { timeoutMs }));

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
            // The classification parses THIS process's commander tree; the spawned
            // child rebuilds its own. The two agree because the dev-command gate
            // derives from the baked build channel plus env the child inherits
            // (INFLEXA_BUILD_CHANNEL / INFLEXA_DEV — see lib/env.ts), so the
            // approved classification describes exactly what will run.
            const c = await classifyInflexaArgv(args);

            // A rejected argv never reaches a process or a prompt — report it and let the model correct itself.
            if (c.kind === "malformed") return ok({ status: "invalid", message: c.message });

            if (c.kind === "action") {
                // A blocked command (an interactive TUI launcher) can never run as a captured
                // subprocess — refuse it here rather than prompting for something doomed to fail.
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
            // truncateOutput re-bounds here because the seam is injectable: the real
            // spawn already caps at source, but the contract must hold for any seam.
            if (r.endedBy === "timeout") return ok({ status: "timed_out", stdout: truncateOutput(r.stdout), stderr: truncateOutput(r.stderr) });
            if (r.endedBy === "cancel") return ok({ status: "cancelled" });
            return ok({ status: "ran", exitCode: r.exitCode, stdout: truncateOutput(r.stdout), stderr: truncateOutput(r.stderr) });
        },
    });
}
