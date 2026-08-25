/**
 * run_inflexa — let the conversation agent drive the local `inflexa` CLI.
 *
 * The tool takes an argv (the words that would follow `inflexa` on a shell),
 * classifies it WITHOUT running anything ({@link classifyInflexaArgv}), and then:
 *   - malformed argv    → an `invalid` data variant (no spawn, no prompt);
 *   - introspection      → runs immediately (help/version describe the CLI and
 *                          touch no user data), returning its captured output;
 *   - a real action      → runs the registration-declared {@link AgentPolicy} as
 *                          a cascade ({@link decideAction}): a `blocked` command
 *                          is refused with its reason BEFORE any grant/ask lookup
 *                          (so a stale grant cannot resurrect it); an `auto`
 *                          command spawns prompt-free when every explicitly-set
 *                          option is safe-listed, else escalates to the prompt;
 *                          an `approval` command pauses on `ctx.ask`; a command
 *                          with no declared policy fails closed as `blocked`.
 *
 * The subprocess is a plain child process — the same way the agent shells out to
 * any other command — so the CLI's own commands stay the single implementation of
 * what `inflexa` does; this tool is only the bridge that lets the agent invoke it.
 */

import { join } from "node:path";

import { defineTool, type AskRequest, type ToolError } from "@inflexa-ai/harness";
import type { Command } from "commander";
import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { type AgentPolicy, getAgentPolicy, isTransferPolicy } from "../../cli/agent_policy.ts";
import { buildProgram } from "../../cli/index.ts";
import { env } from "../../lib/env.ts";
import { anchorPathForAnalysisId } from "../analysis/output.ts";
import { classifyInflexaArgv, toEffectiveArgv } from "./inflexa_classify.ts";

/** Combined cap on a run's captured output (stdout and stderr together), so one runaway command cannot overflow the turn's context. */
const MAX_OUTPUT_CHARS = 60_000;

/**
 * Default QUIET time a single `inflexa` invocation may spend before it is abandoned.
 *
 * The bound that matters is silence, not duration. A flat wall-clock deadline cannot tell a command
 * that is working from one that is wedged, so any value is wrong for someone: 2 minutes kills a
 * legitimate multi-gigabyte download, and a value generous enough to spare it would let a genuinely
 * hung command hold the turn for just as long. Measuring the gap between output separates the two —
 * a command that is still reporting is still working, however long it takes, and one that has said
 * nothing for two minutes is not coming back.
 *
 * A transfer is the case where even that reading fails, because a captured download is legitimately
 * silent for the whole of one large file. Such a command carries `TransferTrait` and runs under neither
 * bound; its liveness is watched over the arriving bytes instead.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * Default absolute ceiling, independent of how chatty the child is.
 *
 * The backstop for the case the idle timer cannot see: a command looping forever while printing.
 * Deliberately far above any real invocation — a large Series transfer is minutes, not tens of
 * minutes — so it never truncates honest work, and the user's own turn abort remains the fast path.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

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
 * What the approval prompt of a transfer command says before the standing-grant sentence.
 *
 * The user consents to a run with no deadline, which the argv line does not show, thus the prompt must
 * say it. It says only that. How the run ends is the downloader's mechanism, and a prompt that recited
 * it would ask the user to hold a number they can act on in no way, and would go stale the day the
 * mechanism changes.
 */
const TRANSFER_DETAIL = "This command downloads data. It has no time limit. ";

/**
 * What the tool should do with a classified `action` verdict, decided purely from
 * the registration-declared policy — no I/O, so the escalation and fail-closed
 * branches (unreachable through the real registry, which stamps every command) are
 * directly unit-testable. `blocked` carries the model-facing message; `ask` means
 * run the `ctx.ask` approval flow; `spawn` means run with no prompt.
 */
export type ActionDecision = { readonly kind: "blocked"; readonly message: string } | { readonly kind: "ask" } | { readonly kind: "spawn" };

/**
 * Run the policy cascade for a classified action. The order is load-bearing:
 *
 * - No policy → `blocked` (fail closed). Reachable only by bypassing every static
 *   enforcement layer, so the message names it a developer-side gap, not a user
 *   decision to override.
 * - `blocked` → refuse with the declared reason. This runs BEFORE any grant/ask
 *   lookup (the caller consults no grant here), so a command reclassified `blocked`
 *   wins over a stale "always" grant that still matches its `grantKey`.
 * - `auto` → `spawn` iff every explicitly-set option is safe-listed; any out-of-set
 *   option yields `ask`. Policy is the floor and flags only escalate — an unknown
 *   flag can push an `auto` invocation up to a prompt, never down past a block.
 * - `approval` → `ask`.
 */
export function decideAction(policy: AgentPolicy | undefined, grantKey: string, setOptions: readonly string[]): ActionDecision {
    if (policy === undefined) {
        return {
            kind: "blocked",
            message:
                `\`${grantKey}\` is not classified for agent use: it has no agent policy declared. ` +
                "This is a gap in run_inflexa's command policy (a developer-side omission), not a decision you or the user can approve around — report it rather than retrying.",
        };
    }
    switch (policy.kind) {
        case "blocked":
            return { kind: "blocked", message: policy.reason };
        case "auto":
            return setOptions.every((opt) => policy.safeFlags.includes(opt)) ? { kind: "spawn" } : { kind: "ask" };
        case "approval":
            return { kind: "ask" };
        default: {
            // Exhaustive: a new AgentPolicy kind must add a case above, or this fails to compile.
            const _exhaustive: never = policy;
            return _exhaustive;
        }
    }
}

/**
 * The outcome the model sees, as data on the ok channel — every expected result
 * is a variant here, never a thrown error (a denied `ctx.ask` is the one throw,
 * and it is the harness loop's to map). `invalid` is a rejected argv; `blocked`
 * is a command the agent may not run — a `blocked` policy (a TUI launcher or an
 * infrastructure-lifecycle command) or the fail-closed case of a command carrying
 * no declared policy; `ran` is a
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

/**
 * The subprocess seam — injectable so tests assert on the composed argv and working directory without
 * spawning a real process.
 *
 * `bounds` rides the call rather than the construction, because the deadlines belong to the COMMAND and
 * not to the tool: a transfer runs unbounded while every other command keeps the tool's own two bounds,
 * and one tool instance serves both.
 */
export type RunSubprocess = (cmd: readonly string[], cwd: string | undefined, signal: AbortSignal, bounds: SpawnBounds) => Promise<SubprocessResult>;

/**
 * Locate the folder an analysis lives in — injectable so tests need no database.
 *
 * `undefined` means "could not be located", which the caller treats as "inherit this process's
 * directory": a best-effort improvement on the working directory, never a reason to refuse a command.
 */
export type ResolveAnalysisFolder = (analysisId: string) => string | undefined;

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

/**
 * Re-bound one captured stream to {@link MAX_OUTPUT_CHARS}, marking the cut so
 * the model knows output was dropped. The real spawn budgets both streams
 * jointly at capture time; this per-stream backstop exists because the
 * subprocess seam is injectable and the bound must hold for any seam.
 */
function truncateOutput(text: string): string {
    return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(0, MAX_OUTPUT_CHARS) + "…[truncated]";
}

/**
 * Render one argv element for the approval prompt. An element carrying
 * whitespace or a quote is wrapped in quotes — an unquoted join would show
 * `refs download my file` for a three-element argv whose one operand is
 * "my file", and the user would approve word boundaries that are not the ones
 * spawning. Display-only: the spawn receives the raw array (no shell), so this
 * must be faithful to a reader, not a correct shell escaper; an element carrying
 * BOTH quote kinds is unrepresentable in the tokenizer's grammar and is simply
 * double-quoted.
 */
function displayArgvElement(element: string): string {
    if (!/[\s"']/.test(element)) return element;
    return element.includes('"') ? `'${element}'` : `"${element}"`;
}

/**
 * Accumulate a subprocess stream while ALWAYS draining to the end: past the
 * budget, chunks are still read and dropped rather than left in the pipe, so a
 * chatty child never blocks on backpressure while the capture stays
 * memory-bounded (buffering a multi-hundred-MB stream just to slice 60k off the
 * front is the failure this exists to prevent).
 *
 * `budget` is SHARED, mutable state: both collectors of one spawn draw from the
 * same remaining-character pool, so the cap bounds the run's combined output —
 * what the turn's context pays for — not each stream separately. First-arrived
 * output wins the budget; sound without locking because each decrement is
 * synchronous between `await`s on a single thread.
 */
function collectCapped(
    stream: ReadableStream<Uint8Array>,
    budget: { remaining: number },
    onActivity?: () => void,
): { done: Promise<void>; cancel: () => void; text: () => string } {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let truncated = false;
    const done = (async () => {
        try {
            for (;;) {
                const { done: eof, value } = await reader.read();
                if (eof) return;
                // Before the truncation check: past the budget the bytes are dropped, but they are
                // still evidence the child is alive, and the idle bound must not fire on a command
                // whose only fault is being chatty enough to have exhausted the cap.
                onActivity?.();
                if (truncated) continue;
                const chunk = decoder.decode(value, { stream: true });
                if (chunk.length <= budget.remaining) {
                    text += chunk;
                    budget.remaining -= chunk.length;
                } else {
                    text += chunk.slice(0, budget.remaining);
                    budget.remaining = 0;
                    truncated = true;
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
    /**
     * Absolute ceiling on the run, however chatty the child is. Omitted means no ceiling, and then only
     * `idleTimeoutMs` and the caller's own signal can end the child — the shape a transfer command runs
     * under, where the downloader holds the liveness bound instead (see `TransferTrait`).
     */
    readonly timeoutMs?: number;
    /** Longest the child may produce NO output before it is abandoned. Omitted means only `timeoutMs` bounds it. */
    readonly idleTimeoutMs?: number;
    readonly flushGraceMs?: number;
    readonly killGraceMs?: number;
}

/**
 * The real subprocess wrapper: spawn `cmd`, capture stdout/stderr memory-bounded,
 * and bound the run by each bound `bounds` gives — `timeoutMs` for the whole run,
 * and `idleTimeoutMs` for how long it stays silent (rearmed on every chunk either
 * stream produces — so a command that reports progress runs as long as it needs,
 * while a wedged one still dies promptly). Both are optional, and a `bounds` that
 * gives neither leaves the caller's `signal` as the only stop — which is what a
 * transfer command runs under. The deadlines and the caller's `signal` (chat
 * disconnect / turn abort) are merged — either aborts the child — and `endedBy`
 * reports which one fired (timeout wins a tie: the deadline elapsed either way),
 * so a user cancel is never mislabelled a timeout or a completed run.
 *
 * Not wrapped in a Result: this is the throwing-boundary seam itself (mirrors
 * `lib/container.ts`'s `capture`). A spawn that fails to launch is an unexpected
 * fault — it throws, and the loop's dispatch maps it to an error tool result.
 */
export async function spawnInflexa(cmd: readonly string[], signal: AbortSignal, bounds: SpawnBounds, cwd?: string): Promise<SubprocessResult> {
    const { timeoutMs, idleTimeoutMs, flushGraceMs = FLUSH_GRACE_MS, killGraceMs = KILL_GRACE_MS } = bounds;
    // Hand-driven rather than `AbortSignal.timeout`, because the idle bound has to be REARMED on
    // every chunk the child produces and a timeout signal cannot be restarted. `timedOut` is the
    // authority for `endedBy`: both deadlines mean "the child ran out of time", and the caller's
    // own signal must still be distinguishable from either.
    const deadline = new AbortController();
    let timedOut = false;
    const expire = (): void => {
        timedOut = true;
        deadline.abort();
    };
    const combined = AbortSignal.any([signal, deadline.signal]);
    // `[...cmd]` copies the readonly argv into the mutable array `Bun.spawn` expects. No `env`: Bun
    // then inherits the parent's startup snapshot, which is what every other child of this process
    // gets. An absent `cwd` likewise inherits, so the key is omitted rather than passed as undefined.
    const proc = Bun.spawn({ cmd: [...cmd], stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: combined, ...(cwd === undefined ? {} : { cwd }) });

    // Armed only once the child exists. A launch that throws (ENOENT on the binary) propagates out of
    // this function, so a timer armed before it would never be cleared — and a pending `setTimeout`
    // holds the event loop open, keeping the process alive for the whole bound rather than merely
    // firing into an abort nobody reads. Ordering is what closes that, so nothing between here and
    // the clears on the exit path may throw; the deadline controller is built above because
    // `Bun.spawn` needs its signal, but a controller with no timer costs nothing if the spawn fails.
    const totalTimer: ReturnType<typeof setTimeout> | null = timeoutMs === undefined ? null : setTimeout(expire, timeoutMs);
    let idleTimer: ReturnType<typeof setTimeout> | null = idleTimeoutMs === undefined ? null : setTimeout(expire, idleTimeoutMs);
    // Latched once the child is reaped, because output outlives it: the pipes are still read
    // during the flush grace below, and a chunk arriving there would otherwise rearm the idle
    // timer AFTER the clears, leaving a timer nothing owns — one that holds the event loop open
    // for the whole bound and then aborts a run that already returned.
    let settled = false;
    const noteActivity = (): void => {
        if (idleTimeoutMs === undefined || timedOut || settled) return;
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = setTimeout(expire, idleTimeoutMs);
    };

    // The abort kill is SIGTERM, which a child can trap and outlive; escalate to
    // SIGKILL after a grace so the deadline is a real bound, not a suggestion.
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const escalate = (): void => {
        killTimer = setTimeout(() => proc.kill("SIGKILL"), killGraceMs);
    };
    if (combined.aborted) escalate();
    else combined.addEventListener("abort", escalate, { once: true });

    // One pool across both streams: the cap is per RUN — the model-facing bound —
    // not per stream, so a stderr-only failure can still use the whole budget.
    const budget = { remaining: MAX_OUTPUT_CHARS };
    const stdout = collectCapped(proc.stdout, budget, noteActivity);
    const stderr = collectCapped(proc.stderr, budget, noteActivity);
    const exitCode = await proc.exited;
    settled = true;
    if (totalTimer !== null) clearTimeout(totalTimer);
    if (idleTimer !== null) clearTimeout(idleTimer);
    if (killTimer !== null) clearTimeout(killTimer);
    // The child is reaped; a LATER abort of the caller's long-lived turn signal
    // must not schedule a stray SIGKILL timer against it. No-op when the abort
    // already fired (`once` removed the listener) — the timer was cleared above.
    combined.removeEventListener("abort", escalate);

    // The child is gone, but its pipes may not be: give buffered output a short
    // flush window, then stop reading and take what arrived — a grandchild that
    // inherited the pipes must not stall the tool past the child's own exit.
    await Promise.race([Promise.all([stdout.done, stderr.done]), Bun.sleep(flushGraceMs)]);
    stdout.cancel();
    stderr.cancel();

    const endedBy = timedOut ? "timeout" : signal.aborted ? "cancel" : "exit";
    return { exitCode, stdout: stdout.text(), stderr: stderr.text(), endedBy };
}

/**
 * Render the agent-runnable command surface FROM the registry, for the tool's own description.
 *
 * The alternative is prose naming what the CLI covers — a second, hand-kept copy
 * of the registry that nothing typechecks, so it drifts the first time a command
 * is added or reclassified and stays wrong until an agent believes it. A stamped
 * policy is the exact membership test: `registerAction` is the only way to attach
 * an action handler and it requires a policy, so "carries a policy" IS "an agent
 * could run this" — which also keeps this on the public `getAgentPolicy` read
 * rather than the private slot the audit tests must reach for.
 *
 * Arguments and options are deliberately left out: they are the bulk of the
 * surface and the fastest-moving part of it, and `--help` already serves them
 * accurately on demand. Blocked commands need only their name.
 */
function describeCommandSurface(): string {
    const groups: Record<AgentPolicy["kind"], string[]> = { auto: [], approval: [], blocked: [] };
    const walk = (command: Command, path: readonly string[]): void => {
        const policy = getAgentPolicy(command);
        const name = `\`${path.join(" ")}\``;
        if (policy !== undefined) groups[policy.kind].push(policy.kind === "blocked" ? name : `${name} (${command.description()})`);
        for (const child of command.commands) walk(child, [...path, child.name()]);
    };
    // A fresh throwaway root, reflecting THIS process's baked build channel exactly as
    // the classifier's does. Nothing is parsed, so there is no help/error output to silence.
    for (const child of buildProgram().commands) walk(child, [child.name()]);

    return [
        groups.auto.length > 0 ? `Read-only, and normally run without interrupting the user: ${groups.auto.join("; ")}.` : "",
        groups.approval.length > 0 ? `Always stop for the user's approval first: ${groups.approval.join("; ")}.` : "",
        groups.blocked.length > 0 ? `Not available through this tool at all: ${groups.blocked.join(", ")}.` : "",
    ]
        .filter(Boolean)
        .join(" ");
}

/** Construction deps for {@link createRunInflexaTool}; every field defaults to the real host value, overridable in tests. */
export interface RunInflexaToolDeps {
    readonly runSubprocess?: RunSubprocess;
    readonly isDevelopment?: boolean;
    readonly execPath?: string;
    readonly scriptPath?: string;
    readonly timeoutMs?: number;
    readonly idleTimeoutMs?: number;
    readonly resolveAnalysisFolder?: ResolveAnalysisFolder;
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
    const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const resolveAnalysisFolder: ResolveAnalysisFolder = deps.resolveAnalysisFolder ?? ((analysisId) => anchorPathForAnalysisId(analysisId) ?? undefined);
    const runSubprocess: RunSubprocess = deps.runSubprocess ?? ((cmd, cwd, signal, bounds) => spawnInflexa(cmd, signal, bounds, cwd));

    return defineTool({
        id: "run_inflexa",
        description:
            "Run the local `inflexa` command-line tool — the host's control surface for the environment an analysis runs in. " +
            'Pass `argv` as the list of words you would type after `inflexa` on a shell (e.g. ["--help"], or ["--version"]). ' +
            "When the environment is missing something the work needs, look here before telling the user it cannot be had: " +
            "provisioning you can drive through this tool is a real option, not something out of reach. " +
            "The commands below are the entire surface available to you, listed without their arguments and options — " +
            'run ["<subcommand>", "--help"] to learn those before invoking, which is always free and never prompts. ' +
            "A read-only command can still escalate to an approval when an option outside its known-safe set rides along, " +
            "so being asked is normal and never a sign the command was the wrong one. " +
            describeCommandSurface() +
            " Captured stdout, stderr, and exit code come back to you; a non-zero exit is a real answer about what happened, not a tool failure. " +
            "THE PACKAGE FLOW, after a plan is made: write the plan's package list to the user, mark each package the pool does not hold " +
            "(`list_available_packages` answers that), and then ask for each missing one with its own gated " +
            '["store", "add", "<name>"] call — one package per call, `--version <v>` when the plan pins one, `--lang python|r` when the name is ambiguous. ' +
            "Each approved add ENQUEUES; the acquisitions run as one batch when this turn settles, so do not wait for bytes between asks. " +
            "Invite a swap: the user can name a different package in place of a proposed one, and then you revise the plan toward it and do not ask for the replaced one again. " +
            "A declined ask is guidance, never an error: propose an alternative or replan, and never send the same ask again. " +
            'When a package you asked for is still missing in a later turn, run ["store", "ls"] BEFORE any second ask: ' +
            "a failed flight listed there carries the recorded reason, and your next message reports that reason instead of repeating the ask. " +
            "A run refusal that names missing packages means the pool does not hold them yet — `inflexa store add <name>` is the remedy to propose.",
        inputSchema: z.object({
            argv: z
                .array(z.string())
                .describe(
                    "The words to pass to `inflexa`, one per element, exactly as typed on a shell " +
                        '(e.g. ["--help"] or ["<subcommand>", "--help"]). An empty list runs bare `inflexa`.',
                ),
        }),
        // The chip names the argv that WILL run, and not the argv the model sent.
        // `toEffectiveArgv` is the whole of the classifier's normalization, and
        // every runnable verdict carries its result unchanged. The hook is
        // synchronous and `classifyInflexaArgv` is async, thus the hook computes
        // the same value rather than a call to the verdict.
        //
        // Each element goes through `displayArgvElement`, the same encoder that
        // builds the approval prompt. The standing invariant of this tool is that
        // what the user approves is exactly what runs, thus one argv must not read
        // two ways. The leading `inflexa` of the prompt stays off, because the
        // surface that renders a detail already prints the name of the tool.
        describeCall: ({ argv }) => toEffectiveArgv(argv).map(displayArgvElement).join(" "),
        execute: async (input, ctx): Promise<Result<RunInflexaResult, ToolError>> => {
            // The classification parses THIS process's commander tree; the spawned
            // child rebuilds its own. The two agree because the dev-command gate
            // derives from the baked build channel plus env the child inherits
            // (INFLEXA_BUILD_CHANNEL / INFLEXA_DEV — see lib/env.ts), so the
            // approved classification describes exactly what will run. `c.argv` is
            // the classifier-normalized argv its verdict describes — the ONLY argv
            // this tool may display or spawn, so the command the user approves is
            // exactly the one that runs.
            const c = await classifyInflexaArgv(input.argv);

            // A rejected argv never reaches a process or a prompt — report it and let the model correct itself.
            if (c.kind === "malformed") return ok({ status: "invalid", message: c.message });

            // Read once, and used twice: it decides the bounds the child runs under, and it decides what
            // the approval says about them. Introspection (`--help`) carries no policy and is never one.
            const transfer = c.kind === "action" && isTransferPolicy(c.policy);

            if (c.kind === "action") {
                // The registration-declared policy is the floor. `decideAction` runs it before any
                // grant/ask interaction, so a `blocked` command (or an unclassified one, fail-closed)
                // is refused here rather than prompting for something that is not the user's decision.
                const decision = decideAction(c.policy, c.grantKey, c.setOptions);
                if (decision.kind === "blocked") return ok({ status: "blocked", message: decision.message });

                if (decision.kind === "ask") {
                    const request: AskRequest = {
                        title: "Run inflexa command",
                        // The EXACT argv that will run — what the user approves is precisely what
                        // executes, nothing hidden. Spaced elements render quoted so the word
                        // boundaries the user reads are the word boundaries that spawn.
                        command: ["inflexa", ...c.argv.map(displayArgvElement)].join(" "),
                        // The caveat leads, because it is what this approval buys that the argv line does not
                        // show: consent to a run with no deadline. It states the one condition that ends
                        // such a run, so "no time limit" cannot read as "no way out".
                        detail: `${transfer ? TRANSFER_DETAIL : ""}Approving "always" lets this inflexa subcommand run again in this analysis without asking each time.`,
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
                // `decision.kind === "spawn"` (an `auto` run within its safeFlags) and an approved `ask`
                // both fall through to the shared run path below — an `auto` run leaves no ask-ledger
                // row, deliberately matching introspection's audit posture.
            }

            // Introspection and an approved action both reach here and run the same way.
            //
            // The agent route of `store add` rides the hidden `--queued` flag (the
            // package-store-management spec): the approved call ENQUEUES into the
            // pending set and returns at once, and the chat flushes the batch of
            // the turn as ONE provisioner run when the asks settle. The flag is
            // appended HERE, never by the model — it is invisible to the approval
            // prompt because it changes no effect the user consents to (the same
            // acquisition runs either way, only batched). The `--analysis` of the
            // chat's own analysis is appended when the model named none, from the
            // TRUSTED session scope — the same rationale as the cwd below.
            let argv = c.argv;
            if (argv[0] === "store" && argv[1] === "add" && !argv.includes("--run-flush")) {
                const scoped = ctx.session.scope;
                const extra = ["--queued"];
                if (!argv.includes("--analysis") && scoped.kind === "analysis") extra.push("--analysis", scoped.analysisId);
                argv = [...argv, ...extra];
            }
            const cmd = resolveInvocation(argv, { isDevelopment, execPath, scriptPath });
            // Run the child in the analysis's own folder, so a command that resolves its target from the
            // working directory lands on the chat's analysis rather than wherever this process happens to
            // have been started — the two differ after `inflexa resume`, an `--analysis` launch, or a
            // mid-session swap. The directory comes from the trusted session scope, never the model argv,
            // so no wording the model picks can move a cwd-resolved command off the chat's analysis. That
            // is a property of the cwd alone, not containment: an argv carrying `--analysis` still
            // retargets, and the approval prompt above — which shows the exact argv — is the boundary
            // there, as it is for every other approval-gated command. Unlocatable is not a failure: the
            // child then inherits this process's directory.
            const scope = ctx.session.scope;
            const cwd = scope.kind === "analysis" ? resolveAnalysisFolder(scope.analysisId) : undefined;
            // A transfer runs with neither bound: `downloadToFile` ends it when the bytes stop, and a
            // second deadline out here could only ever cut an honest download short (see `TransferTrait`).
            const r = await runSubprocess(cmd, cwd, ctx.signal, transfer ? {} : { timeoutMs, idleTimeoutMs });
            // truncateOutput re-bounds here because the seam is injectable: the real
            // spawn already caps at source, but the contract must hold for any seam.
            if (r.endedBy === "timeout") return ok({ status: "timed_out", stdout: truncateOutput(r.stdout), stderr: truncateOutput(r.stderr) });
            if (r.endedBy === "cancel") return ok({ status: "cancelled" });
            return ok({ status: "ran", exitCode: r.exitCode, stdout: truncateOutput(r.stdout), stderr: truncateOutput(r.stderr) });
        },
    });
}
