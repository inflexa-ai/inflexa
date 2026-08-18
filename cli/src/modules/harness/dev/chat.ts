// TODO(extend): `inflexa chat` is a dev/E2E surface — a clack/stdout REPL that
// drives the harness conversation agent so the whole embedded loop
// (assemble → prepareChatTurn → runAgent → appendTurn) can be exercised
// end-to-end WITHOUT a TUI. Its product replacement is the TUI chat (capability
// `tui-harness-chat`), the landed user-facing conversation surface; this command
// is kept only to exercise the harness loop headlessly. Its standing disposition is
// the dev-channel gate: `src/cli/index.ts` registers it only when `devCommandsEnabled()`
// is true, so a release build never carries it (absent from --help; invoking the name
// fails non-zero as an unrecognized argument); `INFLEXA_DEV=1` re-enables it on a
// shipped binary for support. See the
// `dev-commands` spec. The turn body it drives is the shared engine (`turn.ts`) the TUI chat runs too,
// so what stays here is only the REPL transport: a clack line prompt and the
// coarse stdout printer. The spec-level record is
// `openspec/specs/chat-command/spec.md`.

import { pathToFileURL } from "node:url";

import { randomUUIDv7 } from "bun";
import { intro, log, outro, spinner, text, isCancel } from "@clack/prompts";
import { type ResultAsync } from "neverthrow";
import { createStreamingChat, createThreadHistory, createThreadStore, type AgentSession, type DbError, type EmitFn, type Thread } from "@inflexa-ai/harness";
import type { OpenableEntry, OpenTarget, PresentationBody } from "../../../types/session.ts";

import { describeCause } from "../../../lib/cause.ts";
import { fail } from "../../../lib/cli.ts";
import { shutdown } from "../../../lib/shutdown.ts";
import { claimAnalysisOrFail, resolveSingleAnalysis, type ContextFlags } from "../../analysis/context.ts";
import { resolveHarnessConfig } from "../config.ts";
import { ensureSandboxImage } from "../../libs/pull.ts";
import { materializeTarget, readFileReference, readPresentation } from "../artifact_open.ts";
import { isSubAgentEvent, readAskPart, readPlanCard, readRunCard, subAgentActivityLabel } from "../chat_printer.ts";
import { planToDag } from "../plan_dag.ts";
import { bootHarnessRuntime, describeBootError, type HarnessRuntime } from "../runtime.ts";
import { buildChatSession, runChatTurn } from "../turn.ts";

/** The `empty`-context hint specific to `inflexa chat`. */
const CHAT_EMPTY_HINT = "No analysis here. Run `inflexa` to start one, add inputs, then `inflexa chat`.";

/**
 * The outcome of resolving which thread a chat invocation runs on. `new` and
 * `resume` both carry the id to converse on; `not_found` is the spec-mandated
 * single refusal for BOTH an absent thread and one owned by another analysis
 * (the harness does not distinguish them, and the command must not either);
 * `lookup_failed` is a genuine storage fault (Postgres down), kept distinct so
 * the command reports it as such rather than as "thread not found".
 */
export type ThreadSelection =
    | { readonly kind: "new"; readonly threadId: string }
    | { readonly kind: "resume"; readonly threadId: string }
    | { readonly kind: "not_found" }
    | { readonly kind: "lookup_failed"; readonly cause: DbError };

/**
 * Decide the thread for a chat invocation. Pure over its injected seams so the
 * branch table is unit-tested without a Postgres `Pool`:
 *
 * - No `--thread`: mint a fresh id and let the first turn create the row
 *   (`prepareChatTurn` creates an absent thread itself). We do NOT pre-create it.
 * - `--thread <id>`: the row MUST already exist and belong to this analysis. An
 *   absent row (typo) or a foreign one both resolve to `not_found` — without this
 *   pre-check a typo'd id would silently mint a new empty thread on the first turn.
 */
export async function selectThread(
    analysisId: string,
    threadRef: string | undefined,
    getThread: (threadId: string) => ResultAsync<Thread | null, DbError>,
    newThreadId: () => string,
): Promise<ThreadSelection> {
    if (threadRef === undefined) return { kind: "new", threadId: newThreadId() };
    return getThread(threadRef).match(
        (thread): ThreadSelection => {
            // Absent OR owned by a different analysis → the one indistinguishable refusal.
            if (thread === null || thread.analysisId !== analysisId) return { kind: "not_found" };
            return { kind: "resume", threadId: thread.threadId };
        },
        (cause): ThreadSelection => ({ kind: "lookup_failed", cause }),
    );
}

/**
 * `inflexa chat <analysis>` — converse with the harness conversation agent
 * scoped to a resolved analysis. Flow mirrors `inflexa profile`/`inflexa run`
 * beat for beat up to boot: resolve analysis → pre-flight gates → per-analysis
 * instance lock → boot the embedded runtime → then select the thread and run the
 * REPL. `threadRef` is the optional `--thread <id>` resume target.
 */
export async function runChat(flags: ContextFlags, threadRef: string | undefined): Promise<void> {
    // A REPL needs an interactive terminal — fail fast before any side effect.
    if (!process.stdin.isTTY) fail("`inflexa chat` needs an interactive terminal (its prompt cannot run on a non-TTY stdin).");

    const analysis = resolveSingleAnalysis(flags, CHAT_EMPTY_HINT);
    const cfg = resolveHarnessConfig();

    intro(`inflexa chat — ${analysis.name}`);

    // Surface an invalid `harness` config block before the image check — a config
    // error collapses every field to its default, so a later gate would fail
    // misleadingly (same guard `inflexa profile`/`inflexa run` open with).
    if (cfg.configError) fail(describeBootError({ type: "harness_config_invalid", issues: cfg.configError.issues }));

    await ensureSandboxImage(cfg.sandboxImage);

    // Claim the per-analysis lock before boot, so this analysis stays
    // single-process for the whole chat — a coarse guard so only one provenance
    // recorder writes this analysis's PROV document; two concurrent recorders (one
    // per process) would each persist to `analyses.provenance` and clobber the
    // other last-write-wins. The same guard the TUI takes on open. Acquired after
    // the fail-fast pre-flight and before the runtime boots; the process-exit hook
    // (src/index.ts) releases it on every exit, so a bail-out below leaks nothing.
    claimAnalysisOrFail(analysis, "Wait for it to finish or stop that process, then re-run.");

    const s = spinner();
    s.start("Booting the harness runtime (Postgres, callback listener, DBOS)");
    const runtime = (await bootHarnessRuntime({ config: cfg })).match(
        (r) => r,
        (e) => {
            s.error("Harness runtime boot failed");
            return fail(describeBootError(e));
        },
    );
    s.stop(`Runtime ready — model ${runtime.conversation.model}`);

    // Select the thread: new-by-default, or resume the `--thread <id>` target
    // after an ownership pre-check (foreign/absent → the single not-found refusal).
    const selection = await selectThread(
        analysis.id,
        threadRef,
        (id) => createThreadStore(runtime.pool).getThread(id),
        () => randomUUIDv7(),
    );
    switch (selection.kind) {
        case "lookup_failed":
            fail(`Could not look up thread "${threadRef}" (${selection.cause.type}). Is Postgres reachable?`);
            break;
        case "not_found":
            fail(
                `No thread "${threadRef}" for "${analysis.name}". Omit --thread to start a new conversation, or pass an id from a prior chat on this analysis.`,
            );
            break;
        case "new":
            log.info("Starting a new conversation thread");
            break;
        case "resume":
            log.info(`Resuming thread ${selection.threadId}`);
            break;
        default: {
            const exhaustive: never = selection;
            throw new Error(`unhandled thread selection: ${JSON.stringify(exhaustive)}`);
        }
    }
    const threadId = selection.threadId;

    await runRepl(runtime, analysis.id, threadId);
}

/**
 * The REPL. One `ThreadHistory`, one printer, and one `AgentSession` are built
 * ONCE and reused every turn (the thread is fixed for the invocation). Each turn
 * is the harness's transport-free sequence — `prepareChatTurn → runAgent →
 * appendTurn` — under a turn-scoped abort signal. The loop ends two
 * ways, both draining through `shutdown` from HERE (never from a signal handler):
 * a cancelled prompt (Ctrl+C / Ctrl+D at idle → `shutdown(0)`), or a turn that
 * returns `"stop"` because a second SIGINT arrived mid-turn (→ `shutdown(130)`,
 * after the turn has fully unwound).
 */
async function runRepl(runtime: HarnessRuntime, analysisId: string, threadId: string): Promise<void> {
    const history = createThreadHistory(runtime.pool);
    const sink: ChatSink = { out: (str) => void process.stdout.write(str), errLine: (str) => console.error(str) };
    // The analysis scopes openable references so `show_file`/`show_user` cards resolve to workspace
    // paths for their OSC 8 `file://` links.
    const printer = createChatPrinter(sink, { analysisId });

    // The REPL runs as the `"cli-chat"` agent. `buildChatSession` puts `threadId`
    // in scope (so a chat-launched plan stamps `cortex_runs.thread_id`) and gives
    // a length-1 callPath (so this agent's events pass the printer's sub-agent
    // depth filter) — see its docs for the full rationale.
    const session: AgentSession = buildChatSession("cli-chat", analysisId, threadId);

    for (;;) {
        const answer = await text({ message: "you", placeholder: "Type a message — Ctrl+C to exit" });
        // Ctrl+C / Ctrl+D at the idle prompt: exit cleanly through the graceful
        // shutdown path (drains DBOS, stops ingress, releases both locks).
        if (isCancel(answer)) {
            outro("Ended chat");
            return void (await shutdown(0));
        }
        const userInput = answer.trim();
        if (userInput.length === 0) continue;
        const outcome = await runTurn(runtime, history, printer, sink, session, analysisId, threadId, userInput);
        // A second SIGINT during the turn requested a stop. The turn has fully
        // unwound (its `appendTurn` ran against a still-live pool), so drain and
        // exit here — once, deterministically (130 = terminated by SIGINT).
        if (outcome === "stop") {
            outro("Ended chat");
            return void (await shutdown(130));
        }
    }
}

/**
 * One chat turn under a turn-scoped `AbortController`. Returns
 * `"continue"` to keep the REPL prompting or `"stop"` to end it — the loop, not
 * this function, owns teardown, which is exactly what makes the second-SIGINT
 * path race-free. The prepare→run→append body itself is the shared headless
 * engine (`runChatTurn` in `turn.ts`); this function owns only the REPL-specific
 * shell around it: the turn-scoped SIGINT wiring and the mapping of the engine's
 * `TurnOutcome` onto the sink's user-visible lines.
 *
 * The SIGINT handler is installed for the turn's duration only, so the idle
 * prompt keeps clack's own Ctrl+C handling (isCancel → clean exit):
 *
 *   - FIRST SIGINT: abort the turn. `runChatTurn` sees the aborted signal, returns
 *     an `aborted` outcome (having persisted `[userMessage, ...partial]`), and we return
 *     `"continue"` — back to the prompt.
 *   - SECOND SIGINT (while the first is still unwinding): flag `forceStop` and do
 *     nothing else. We deliberately do NOT call `shutdown()` from the handler:
 *     `shutdown()` runs `pool.end()` in an onShutdown hook, and a fire-and-forget
 *     `shutdown()` would race the still-unwinding turn — `appendTurn` writing to a
 *     pool being torn down ("Could not save the turn"), or the loop starting a
 *     fresh turn mid-teardown, until `process.exit(130)` finally wins. Instead the
 *     turn finishes unwinding with the pool still alive, then we return `"stop"`
 *     and `runRepl` drains and shuts down ONCE, deterministically, after the turn.
 *
 * Limitation: a tool that ignores its abort signal won't observe `forceStop` until
 * it returns on its own, so a stuck turn delays the stop — a harness/tool concern,
 * out of scope here.
 *
 * Outcome mapping renders the shared engine contract — kept in lockstep with the TUI so both surfaces describe the same outcome identically. The engine persists
 * `[userMessage, ...loopOutput]` on a clean turn and `[userMessage, ...partial]` on a
 * resolved abort; only a thrown failure (or the defensive thrown-abort path) persists
 * `[userMessage]` alone. Any `appendTurn` fault surfaces as `outcome.appendError` —
 * reported here on every `runAgent`-reaching branch.
 * On a clean turn the answer already streamed live through `chat`'s onText, so
 * `finishTurn(fallbackText)` suppresses its duplicate final render; the fallback
 * prints only for a turn that produced no deltas at all.
 */
async function runTurn(
    runtime: HarnessRuntime,
    history: ReturnType<typeof createThreadHistory>,
    printer: ReturnType<typeof createChatPrinter>,
    sink: ChatSink,
    session: AgentSession,
    analysisId: string,
    threadId: string,
    userInput: string,
): Promise<"continue" | "stop"> {
    const controller = new AbortController();
    let aborting = false;
    // Set by a SECOND SIGINT (see doc): request a deterministic stop AFTER this
    // turn finishes unwinding, rather than tearing down the pool concurrently.
    let forceStop = false;
    const onSigint = (): void => {
        if (aborting) {
            forceStop = true;
            return;
        }
        aborting = true;
        controller.abort();
    };
    process.on("SIGINT", onSigint);
    // Report an `appendTurn` fault identically on each runAgent-reaching branch —
    // a single closure so the three sites cannot drift.
    const reportAppendError = (e: DbError | undefined): void => {
        if (e) sink.errLine(`Could not save the turn to the thread (${e.type}).`);
    };
    try {
        const outcome = await runChatTurn({
            pool: runtime.pool,
            agents: runtime.agents,
            chat: (emit) => createStreamingChat(runtime.conversation.provider, (text) => void emit({ type: "text-delta", text })),
            history,
            session,
            emit: printer.emit,
            signal: controller.signal,
            // Same recorder the runtime stamped onto every workflow: the REPL drives the same loop the
            // TUI does, so it carries the same accounting — see `RunChatTurnArgs.usageRecorder`.
            usageRecorder: runtime.usageRecorder,
            analysisId,
            threadId,
            userInput,
        });
        switch (outcome.kind) {
            case "ok":
                reportAppendError(outcome.appendError);
                printer.finishTurn(outcome.fallbackText);
                break;
            case "aborted":
                sink.out("\n  [interrupted]\n");
                reportAppendError(outcome.appendError);
                printer.finishTurn();
                break;
            case "filtered":
                sink.errLine("The model declined this request and stopped the turn (content filter). Switch the chat model, then send the message again.");
                reportAppendError(outcome.appendError);
                printer.finishTurn(outcome.fallbackText);
                break;
            case "failed":
                sink.errLine(`The turn failed: ${describeCause(outcome.cause)}`);
                reportAppendError(outcome.appendError);
                printer.finishTurn();
                break;
            case "prepare_failed":
                sink.errLine(`Could not assemble the turn (is Postgres reachable?): ${describeCause(outcome.cause)}`);
                // Emit the per-turn separator + reset state on this pre-`runAgent`
                // bail too, so output shape stays uniform with the streamed path.
                printer.finishTurn();
                break;
            case "thread_gone":
                sink.errLine("This conversation thread is no longer available.");
                printer.finishTurn();
                break;
            case "agent_unresolved":
                // Preparation succeeded but this build has no agent for the thread's type; a retry cannot
                // change that, so name the type and stop rather than suggesting one.
                sink.errLine(`No agent is registered for "${outcome.threadType}" threads in this build.`);
                printer.finishTurn();
                break;
            default: {
                const exhaustive: never = outcome;
                throw new Error(`unhandled turn outcome: ${JSON.stringify(exhaustive)}`);
            }
        }
        // A second SIGINT during the turn requests a deterministic stop; report it
        // up so `runRepl` tears down after the turn has fully unwound (the `finally`
        // below still runs first, removing this turn's SIGINT listener).
        return forceStop ? "stop" : "continue";
    } finally {
        process.removeListener("SIGINT", onSigint);
    }
}

// ── The emit sink ────────────────────────────────────────────────────────────────────────────────
//
// Renders one in-process `EmitFn` stream to a plain-text terminal. Deliberately coarse: this is the
// dev surface, not the TUI renderer. It lives in this file rather than beside it because
// `createChatPrinter` has exactly one caller — the REPL above — and a single-caller helper stays with
// its caller (`cli/CLAUDE.md`). The event READERS it calls are shared with the TUI, so those stay in
// `modules/harness/chat_printer.ts`.
//
// Three rules are load-bearing and each maps to a chat-command spec requirement:
//
//   1. COPY-ON-RECEIVE. In-process `emit` shares mutable references with the agent loop (the same
//      hazard the TUI's clone-before-store rule guards). Every branch extracts the strings, ids, and
//      statuses it renders at receipt and NEVER retains the received event or its `data` object.
//      Printing is synchronous inside `emit`, so a caller that mutates a part after emitting it
//      cannot change what was already written.
//   2. TOP-LEVEL ONLY. Events whose `source.callPath` is deeper than the top-level agent (sub-agent
//      traffic: planner, literature reviewer) are routed under the tool call they run inside, never
//      to the transcript root.
//   3. ACCUMULATE, RENDER COARSELY. Text deltas are written as received; the terminal itself is the
//      accumulator. Tool activity prints a one-line chip on start and its outcome on finish.
//      `data-plan`/`data-run-card` render their embedded content; every other conversation part
//      prints a one-line tagged mention so the surface OBSERVES unknown traffic rather than hiding it.
//
// stdout carries the conversation; stderr carries diagnostics — the sink splits them so a caller can
// pipe the transcript cleanly. Output is plain ASCII: the `GLYPHS` registry is a `src/tui/` rule.

/**
 * Where the printer writes. Injected so the unit tests drive a pure recording
 * sink; production wires `out → process.stdout.write` and `errLine → console.error`.
 */
export type ChatSink = {
    /** Conversation output — written verbatim, no trailing newline added (deltas accumulate). */
    readonly out: (s: string) => void;
    /** One diagnostic line to stderr (a newline is the sink's concern). */
    readonly errLine: (s: string) => void;
};

/**
 * The small per-turn API the chat REPL drives. `emit` is the `EmitFn` handed to
 * `runAgent` — the `chat` seam of the `runChatTurn` call above also routes the
 * streaming provider's per-token callback through it as `text-delta` events, so
 * deltas and loop/tool events share one sink and one set of rules. `finishTurn`
 * flushes and resets per-turn state (dangling tool chips, the streamed-text flag).
 */
export type ChatPrinter = {
    /**
     * The `EmitFn` sink handed to `runAgent` (and fed the streaming provider's
     * text deltas). Routes sub-agent traffic under the open tool call (rule 2),
     * renders each event category coarsely, and never retains a received object
     * (copy-on-receive).
     */
    readonly emit: EmitFn;
    /**
     * Close out the turn. `fallbackText` is the turn's final assistant text
     * (from `finalText(runAgent result)`): printed only when the turn streamed
     * no `text-delta`s — the deltas and the final text are the SAME content, so
     * this both prevents the double print on a streamed turn and keeps a
     * delta-less turn (or one run without the streaming wrapper) from rendering
     * nothing.
     */
    readonly finishTurn: (fallbackText?: string) => void;
};

/** ms as a compact human string for the tool-chip completion line. */
function formatMs(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Build an OSC 8 hyperlink whose VISIBLE text is `text` and whose target is `uri` — degrades to plain `text` on terminals without link support. */
function hyperlink(uri: string, text: string): string {
    return `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;
}

/** Render a text-shaped presentation table as aligned monospace columns (the REPL's plain-text table form). */
function formatTable(headers: string[], rows: string[][]): string {
    const widths = headers.map((h, ci) => Math.max(h.length, ...rows.map((r) => (r[ci] ?? "").length)));
    const line = (cells: string[]): string => `    ${cells.map((c, ci) => (c ?? "").padEnd(widths[ci] ?? 0)).join("  ")}`.trimEnd();
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(headers.map((_, ci) => r[ci] ?? "")))].join("\n");
}

/**
 * How the printer resolves an openable entry to the absolute path it links to (materializing `echart`/`svg`
 * into the workspace's `presentations/` directory). Injectable so the printer's openable rendering is
 * unit-testable without a booted workspace; production omits it and gets the real {@link materializeTarget}.
 */
export type PrinterOptions = {
    /** The analysis whose workspace root resolves openable references. */
    readonly analysisId?: string;
    /** Resolve an entry's target to an absolute path (materializing when needed), or `null` when unavailable. */
    readonly resolvePath?: (analysisId: string, target: OpenTarget) => string | null;
};

/**
 * Build a chat printer over `sink`. Holds only per-turn primitive state (the
 * streamed-text flag and open tool chips keyed by id → name+start-time) — never
 * a received object — so copy-on-receive holds by construction.
 */
export function createChatPrinter(sink: ChatSink, options: PrinterOptions = {}): ChatPrinter {
    const analysisId = options.analysisId ?? "";
    const resolvePath =
        options.resolvePath ??
        ((aid: string, target: OpenTarget): string | null =>
            materializeTarget(aid, target).match(
                (path) => path,
                () => null,
            ));
    let streamedText = false;
    // toolUseId → the primitives needed to close its chip. Storing the extracted
    // name (a string copy) and a timestamp, never the event, keeps copy-on-receive.
    const openTools = new Map<string, { name: string; startedAt: number }>();

    const emit: EmitFn = (event) => {
        // Rule 2: sub-agent traffic (planner, literature reviewer) never becomes a
        // TRANSCRIPT entry — its iterations and tool calls are numerous, and emitting
        // them at the root would bury the conversation. But dropping it outright made a
        // long tool call indistinguishable from a wedged one, so it is now ROUTED
        // instead: a subordinate line under the tool call it is running inside. The TUI
        // adapter shares this predicate and does the same thing with its tool block.
        if (isSubAgentEvent(event)) {
            const label = subAgentActivityLabel(event);
            // Only while a tool is actually open: a sub-agent event outside any tool
            // call has nothing to be subordinate TO, and printing it at the root is the
            // burial this rule exists to prevent.
            if (label && openTools.size > 0) sink.out(`    ${label}\n`);
            return;
        }

        switch (event.type) {
            case "text-delta":
                // Rule 3: write as received; the terminal accumulates.
                streamedText = true;
                sink.out(event.text);
                return;
            case "done":
                // Stream terminal marker — the text already rendered via deltas.
                return;
            case "iteration":
                // Loop iteration boundary — orchestration, not transcript content.
                return;
            case "tool-started": {
                const name = event.name;
                // Opaque display text the harness computed from this call's input — printed, never parsed.
                const detail = event.detail;
                openTools.set(event.toolUseId, { name, startedAt: Date.now() });
                sink.out(`\n  [tool] ${name}${detail === undefined ? "" : ` ${detail}`} running...\n`);
                return;
            }
            case "tool-finished": {
                const name = event.name;
                const started = openTools.get(event.toolUseId);
                openTools.delete(event.toolUseId);
                const dur = started ? ` (${formatMs(Date.now() - started.startedAt)})` : "";
                // Three outcomes get three words. `denied` is the user's own refusal of an approval, so
                // printing it as `error` would report their decision as a fault of the tool.
                const outcome = event.outcome === "error" ? "error" : event.outcome === "denied" ? "denied" : `done${dur}`;
                // A tool that describes its own result names the outcome here — the page it wrote, the
                // version it recorded — so the finished line prints what the running line could not know.
                const detail = event.detail;
                sink.out(`  [tool] ${name}${detail === undefined ? "" : ` ${detail}`} ${outcome}\n`);
                return;
            }
            default: {
                // Only `ChatDataPart` remains (its `type` is `data-${string}`).
                renderDataPart(event.type, event.data);
                return;
            }
        }
    };

    function renderDataPart(type: `data-${string}`, data: unknown): void {
        switch (type) {
            case "data-plan": {
                const plan = readPlanCard(data);
                const heading = plan.title || plan.planId;
                sink.out(`\n  [plan] ${heading} (${plan.planId})\n`);
                const graph =
                    plan.steps.length > 0
                        ? planToDag(plan.steps).match(
                              (value) => value || null,
                              () => null,
                          )
                        : null;
                if (graph) {
                    for (const line of graph.split("\n")) sink.out(`    ${line}\n`);
                } else {
                    for (const step of plan.steps) sink.out(`    - ${step.id} ${step.name} [${step.agent}]\n`);
                }
                return;
            }
            case "data-run-card": {
                const run = readRunCard(data);
                sink.out(`\n  [run] ${run.runId}: ${run.title} (${run.stepCount} step(s))\n`);
                return;
            }
            case "data-presentation": {
                const view = readPresentation(data);
                if (view.shape === "inline") renderInlinePresentation(view.title, view.body);
                else renderOpenables(view.title, [view.entry]);
                return;
            }
            case "data-file-reference": {
                const view = readFileReference(data);
                renderOpenables(view.title, view.entries);
                return;
            }
            case "data-ask": {
                // The REPL is a write-only sink with no mid-turn input path, so it cannot answer an ask —
                // the harness denies it by default. Still observe the approval and its outcome, one line.
                const ask = readAskPart(data);
                sink.out(`\n  [approval] ${ask.command} — ${ask.status}\n`);
                return;
            }
            default:
                // Rule 3: observe unknown parts, do not swallow them.
                sink.out(`  [part:${type}]\n`);
                return;
        }
    }

    /** Print a text-shaped presentation inline: markdown source verbatim, code fenced, tables as aligned text. */
    function renderInlinePresentation(title: string | undefined, body: PresentationBody): void {
        if (title) sink.out(`\n  [show] ${title}\n`);
        switch (body.kind) {
            case "markdown":
                sink.out(`${body.body}\n`);
                return;
            case "code":
                sink.out("```" + body.language + "\n" + body.code + "\n```\n");
                return;
            case "table":
                sink.out(`${formatTable(body.headers, body.rows)}\n`);
                if (body.caption) sink.out(`    ${body.caption}\n`);
                return;
            default: {
                const _exhaustive: never = body;
                return _exhaustive;
            }
        }
    }

    /** Print openable entries: one line per entry with the resolved path as an OSC 8 `file://` link (plain path visible). */
    function renderOpenables(title: string | undefined, entries: OpenableEntry[]): void {
        if (title) sink.out(`\n  [show] ${title}\n`);
        for (const entry of entries) {
            if (entry.target.kind === "unavailable") {
                sink.out(`    ${entry.name}: ${entry.caption ?? "unavailable"}\n`);
                continue;
            }
            const path = resolvePath(analysisId, entry.target);
            const suffix = entry.caption ? ` — ${entry.caption}` : "";
            // The visible text stays the raw path; the link TARGET is a percent-encoded `file://` URI
            // (via `pathToFileURL`) so spaces / `#` in the path don't truncate or mangle the OSC 8 target.
            if (path) sink.out(`    ${entry.name}  ${hyperlink(pathToFileURL(path).href, path)}${suffix}\n`);
            else sink.out(`    ${entry.name}  (path unavailable)${suffix}\n`);
        }
    }

    function finishTurn(fallbackText?: string): void {
        // Non-streaming `runAgent` path: nothing arrived as deltas, so print the
        // final assistant text now (a streaming loop that emitted deltas skips this).
        if (!streamedText && fallbackText && fallbackText.trim().length > 0) {
            sink.out(fallbackText);
        }
        // A turn aborted mid-tool leaves a chip open — close it honestly.
        for (const [, { name }] of openTools) sink.out(`  [tool] ${name} interrupted\n`);
        // Separate this turn's output from the next prompt.
        sink.out("\n");
        streamedText = false;
        openTools.clear();
    }

    return { emit, finishTurn };
}
