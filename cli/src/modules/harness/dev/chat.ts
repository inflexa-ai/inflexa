// TODO(extend): `inflexa chat` is a dev/E2E surface — a clack/stdout REPL that
// drives the conversation agent of the local server, so the whole chat turn of the
// harness (the opening, each round, and the outcome) can be exercised end-to-end
// WITHOUT a TUI. Its product replacement is the TUI chat (capability
// `tui-harness-chat`), the landed user-facing conversation surface; this command
// is kept only to exercise the harness loop headlessly. Its standing disposition is
// the dev-channel gate: `src/cli/index.ts` registers it only when `devCommandsEnabled()`
// is true, so a release build never carries it (absent from --help; invoking the name
// fails non-zero as an unrecognized argument); `INFLEXA_DEV=1` re-enables it on a
// shipped binary for support. See the `dev-commands` spec. It is a client of the
// local server (`POST {A}/chat`, the same route the TUI chat sends to), so what stays
// here is only the REPL transport: a clack line prompt, the ask prompt, and the
// coarse stdout printer. The spec-level record is
// `openspec/specs/chat-command/spec.md`.

import { pathToFileURL } from "node:url";

import { randomUUIDv7 } from "bun";
import { intro, isCancel, log, outro, select, text } from "@clack/prompts";
import type { ResultAsync } from "neverthrow";
import { checkChatPart, type AskPart, type ChatFrame, type ChatPartFrame } from "@inflexa-ai/harness/contracts/index.js";
import type { OpenableEntry, OpenTarget, PresentationBody } from "../../../types/session.ts";

import type { AskReply, ThreadSummary, TurnSummary } from "../../../api/conversation.ts";
import { describeClientError, type ClientError } from "../../../client/api.ts";
import { resolveSingleAnalysisOrFail, type ContextFlags } from "../../../client/commands/analyses.ts";
import { abortTurn, answerAsk, createChatTurn, fetchThread, fetchTurn } from "../../../client/conversation.ts";
import { fail } from "../../../lib/cli.ts";
import { getLogger } from "../../../lib/log.ts";
import { shutdown } from "../../../lib/shutdown.ts";
import { materializeTarget } from "../artifact_open.ts";
import { isSubAgentEvent, readFileReference, readPlanCard, readPresentation, subAgentActivityLabel } from "../chat_printer.ts";
import { planToDag } from "../plan_dag.ts";

/** The `empty`-context hint specific to `inflexa chat`. */
const CHAT_EMPTY_HINT = "No analysis here. Run `inflexa` to start one, add inputs, then `inflexa chat`.";

/**
 * The outcome of resolving which thread a chat invocation runs on. `new` and
 * `resume` both carry the id to converse on; `not_found` is the spec-mandated
 * single refusal for BOTH an absent thread and one owned by another analysis
 * (the server does not distinguish them, and the command must not either);
 * `lookup_failed` is a genuine fault (the server is gone, or its store failed),
 * kept distinct so the command reports it as such rather than as "thread not found".
 */
export type ThreadSelection =
    | { readonly kind: "new"; readonly threadId: string }
    | { readonly kind: "resume"; readonly threadId: string }
    | { readonly kind: "not_found" }
    | { readonly kind: "lookup_failed"; readonly cause: ClientError };

/**
 * Decide the thread for a chat invocation. Pure over its injected reads so the
 * branch table is unit-tested without a server:
 *
 * - No `--thread`: mint a fresh id and let the first turn create the row
 *   (the server creates an absent thread itself). We do NOT pre-create it.
 * - `--thread <id>`: the row MUST already exist and belong to this analysis. An
 *   absent row (typo) or a foreign one both read as `null` from `GET {T}` and resolve
 *   to `not_found` — without this pre-check a typo'd id would silently mint a new
 *   empty thread on the first turn.
 */
export async function selectThread(
    threadRef: string | undefined,
    getThread: (threadId: string) => ResultAsync<ThreadSummary | null, ClientError>,
    newThreadId: () => string,
): Promise<ThreadSelection> {
    if (threadRef === undefined) return { kind: "new", threadId: newThreadId() };
    return getThread(threadRef).match(
        (thread): ThreadSelection => (thread === null ? { kind: "not_found" } : { kind: "resume", threadId: thread.id }),
        (cause): ThreadSelection => ({ kind: "lookup_failed", cause }),
    );
}

/**
 * `inflexa chat <analysis>` — converse with the conversation agent of the local
 * server, scoped to a resolved analysis: resolve the analysis → select the thread
 * → run the REPL. `threadRef` is the optional `--thread <id>` resume target.
 */
export async function runChat(flags: ContextFlags, threadRef: string | undefined): Promise<void> {
    // A REPL needs an interactive terminal — fail fast before any side effect.
    if (!process.stdin.isTTY) fail("`inflexa chat` needs an interactive terminal (its prompt cannot run on a non-TTY stdin).");

    const analysis = await resolveSingleAnalysisOrFail(flags, CHAT_EMPTY_HINT);

    intro(`inflexa chat — ${analysis.name}`);

    // Select the thread: new-by-default, or resume the `--thread <id>` target
    // after an ownership pre-check (foreign/absent → the single not-found refusal).
    const selection = await selectThread(
        threadRef,
        (id) => fetchThread(analysis.id, id),
        () => randomUUIDv7(),
    );
    switch (selection.kind) {
        case "lookup_failed":
            fail(`Could not look up thread "${threadRef}": ${describeClientError(selection.cause)}`);
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

    await runRepl(analysis.id, threadId);
}

/**
 * The REPL. One printer is built ONCE and reused every turn (the thread is fixed
 * for the invocation). Each turn is one `POST {A}/chat`. The loop ends two ways,
 * both draining through `shutdown` from HERE (never from a signal handler): a
 * cancelled prompt (Ctrl+C / Ctrl+D at idle → `shutdown(0)`), or a turn that
 * returns `"stop"` because a second SIGINT arrived mid-turn (→ `shutdown(130)`,
 * after the turn has fully unwound).
 */
async function runRepl(analysisId: string, threadId: string): Promise<void> {
    const sink: ChatSink = { out: (str) => void process.stdout.write(str), errLine: (str) => console.error(str) };
    // The analysis scopes openable references so `show_file`/`show_user` cards resolve to workspace
    // paths for their OSC 8 `file://` links.
    const printer = createChatPrinter(sink, { analysisId });

    for (;;) {
        const answer = await text({ message: "you", placeholder: "Type a message — Ctrl+C to exit" });
        // Ctrl+C / Ctrl+D at the idle prompt: exit cleanly through the graceful shutdown path.
        if (isCancel(answer)) {
            outro("Ended chat");
            return void (await shutdown(0));
        }
        const userInput = answer.trim();
        if (userInput.length === 0) continue;
        const outcome = await runTurn(printer, sink, analysisId, threadId, userInput);
        // A second SIGINT during the turn requested a stop. The turn has fully
        // unwound on the server, so exit here — once, deterministically (130 =
        // terminated by SIGINT).
        if (outcome === "stop") {
            outro("Ended chat");
            return void (await shutdown(130));
        }
    }
}

/**
 * One chat turn on the server. Returns `"continue"` to keep the REPL prompting or
 * `"stop"` to end it — the loop, not this function, owns teardown. This function
 * owns only the REPL-specific shell around the turn: the turn-scoped SIGINT wiring,
 * the ask prompt, and the mapping of the turn summary onto the sink's lines.
 *
 * The SIGINT handler is installed for the turn's duration only, so the idle
 * prompt keeps clack's own Ctrl+C handling (isCancel → clean exit):
 *
 *   - FIRST SIGINT: send the abort of the turn (`POST {T}/turns/:turnId/abort`).
 *     The server stops the loop, stores the rounds, closes the turn, and ends the
 *     stream with `finish` — back to the prompt.
 *   - SECOND SIGINT (while the first is still unwinding): flag `forceStop` and do
 *     nothing else. The stream is read to its end, then we return `"stop"` and
 *     `runRepl` exits ONCE, deterministically, after the turn.
 *
 * Limitation: a tool that ignores its abort signal won't let the turn end until it
 * returns on its own, so a stuck turn delays the stop — a harness/tool concern,
 * out of scope here.
 *
 * Outcome mapping renders the turn summary of the server — kept in lockstep with the TUI so both
 * surfaces describe the same outcome identically. On a clean turn the answer already streamed live,
 * so `finishTurn(fallbackText)` suppresses its duplicate final render; the fallback prints only for a
 * turn that produced no deltas at all.
 */
async function runTurn(printer: ChatPrinter, sink: ChatSink, analysisId: string, threadId: string, userInput: string): Promise<"continue" | "stop"> {
    let turnId: string | null = null;
    let aborting = false;
    // Set by a SECOND SIGINT (see doc): request a deterministic stop AFTER this turn finishes unwinding.
    let forceStop = false;
    const sendAbort = (id: string): void => {
        void abortTurn(analysisId, threadId, id).match(
            () => undefined,
            (e) => sink.errLine(`Could not stop the turn: ${describeClientError(e)}`),
        );
    };
    const onSigint = (): void => {
        if (aborting) {
            forceStop = true;
            return;
        }
        aborting = true;
        // Before the server names the turn, the abort waits for the id below.
        if (turnId !== null) sendAbort(turnId);
    };
    process.on("SIGINT", onSigint);
    try {
        const started = await createChatTurn(analysisId, { threadId, message: userInput });
        if (started.isErr()) {
            const e = started.error;
            sink.errLine(
                e.type === "http" && e.status === 404
                    ? "This conversation thread is no longer available."
                    : `Could not start the turn: ${describeClientError(e)}`,
            );
            printer.finishTurn();
            return forceStop ? "stop" : "continue";
        }
        turnId = started.value.turnId;
        if (aborting) sendAbort(turnId);
        for await (const item of started.value.frames) {
            if (item.isErr()) {
                if (item.error.type === "bad_json") getLogger("chat").warn({ detail: item.error.detail }, "chat frame dropped: it is not JSON");
                else sink.errLine(`The stream of the turn broke: ${describeClientError(item.error)}`);
                continue;
            }
            printer.frame(item.value);
            const ask = pendingAsk(item.value);
            // The turn waits on the ask, thus the prompt holds the stream until the user answers.
            if (ask !== null) await answerPendingAsk(analysisId, ask, sink);
        }
        (await fetchTurn(analysisId, threadId, turnId)).match(
            (summary) => reportOutcome(summary, printer, sink),
            (e) => {
                sink.errLine(`Could not read the outcome of the turn: ${describeClientError(e)}`);
                printer.finishTurn();
            },
        );
        return forceStop ? "stop" : "continue";
    } finally {
        process.removeListener("SIGINT", onSigint);
    }
}

/** The pending ask of the root agent that a frame opens, or `null`. A sub-agent never asks the user directly. */
function pendingAsk(frame: ChatFrame): AskPart | null {
    if (frame.type !== "data-ask" || isSubAgentEvent(frame)) return null;
    const checked = checkChatPart(frame);
    return checked.ok && checked.frame.type === "data-ask" && checked.frame.status === "pending" ? checked.frame : null;
}

/** Ask the user for a decision, and send it with `POST {A}/asks/:askId/answer`. A cancelled prompt rejects. */
async function answerPendingAsk(analysisId: string, ask: AskPart, sink: ChatSink): Promise<void> {
    const choice = await select<AskReply["kind"]>({
        message: `${ask.title}\n  ${ask.command}${ask.detail === undefined ? "" : `\n  ${ask.detail}`}`,
        options: [
            { value: "once", label: "Approve once" },
            { value: "always", label: "Always approve" },
            { value: "reject", label: "Reject" },
        ],
    });
    const reply: AskReply = isCancel(choice) || choice === "reject" ? { kind: "reject" } : { kind: choice };
    (await answerAsk(analysisId, ask.id, reply)).match(
        () => undefined,
        (e) => sink.errLine(`Could not answer the approval: ${describeClientError(e)}`),
    );
}

/** Print the outcome of a turn from its summary. */
function reportOutcome(summary: TurnSummary, printer: ChatPrinter, sink: ChatSink): void {
    // Report a store fault identically on each branch that ran — a single closure so the sites cannot drift.
    const reportStoreFault = (): void => {
        if (summary.storeFailed === true) sink.errLine("Could not save the turn to the thread.");
    };
    switch (summary.status) {
        case "done":
            reportStoreFault();
            printer.finishTurn(summary.fallbackText);
            return;
        case "aborted":
            sink.out("\n  [interrupted]\n");
            reportStoreFault();
            printer.finishTurn();
            return;
        case "filtered":
            sink.errLine("The model declined this request and stopped the turn (content filter). Switch the chat model, then send the message again.");
            reportStoreFault();
            printer.finishTurn(summary.fallbackText);
            return;
        case "failed":
            sink.errLine(summary.failure?.message ?? "The turn failed.");
            reportStoreFault();
            printer.finishTurn();
            return;
        case "running":
            sink.errLine("The stream ended while the turn still runs on the server.");
            printer.finishTurn();
            return;
        default: {
            const exhaustive: never = summary.status;
            throw new Error(`unhandled turn status: ${JSON.stringify(exhaustive)}`);
        }
    }
}

// ── The frame sink ───────────────────────────────────────────────────────────────────────────────
//
// Renders the frame stream of one turn to a plain-text terminal. Deliberately coarse: this is the
// dev surface, not the TUI renderer. It lives in this file rather than beside it because
// `createChatPrinter` has exactly one caller — the REPL above — and a single-caller helper stays with
// its caller (`cli/CLAUDE.md`). The event READERS it calls are shared with the TUI, so those stay in
// `modules/harness/chat_printer.ts`.
//
// Three rules are load-bearing and each maps to a chat-command spec requirement:
//
//   1. COPY-ON-RECEIVE. Every branch extracts the strings, ids, and statuses it renders at receipt
//      and NEVER retains the received frame. Printing is synchronous inside `frame`, so nothing that
//      happens to a frame after it arrived can change what was already written.
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
 * The small per-turn API the chat REPL drives. `frame` takes each frame of the
 * turn stream of the server, so deltas and loop/tool frames share one sink and
 * one set of rules. `finishTurn` flushes and resets per-turn state (dangling tool
 * chips, the streamed-text flag).
 */
export type ChatPrinter = {
    /**
     * The sink of the turn stream. Routes sub-agent traffic under the open tool
     * call (rule 2), renders each frame category coarsely, and never retains a
     * received object (copy-on-receive).
     */
    readonly frame: (frame: ChatFrame) => void;
    /**
     * Close out the turn. `fallbackText` is the turn's final assistant text
     * (the `fallbackText` of the turn summary): printed only when the turn
     * streamed no `text-delta`s — the deltas and the final text are the SAME
     * content, so this both prevents the double print on a streamed turn and
     * keeps a delta-less turn from rendering nothing.
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

    const onFrame = (frame: ChatFrame): void => {
        // Rule 2: sub-agent traffic (planner, literature reviewer) never becomes a
        // TRANSCRIPT entry — its tool calls are numerous, and emitting them at the root
        // would bury the conversation. But dropping it outright made a long tool call
        // indistinguishable from a wedged one, so it is ROUTED instead: a subordinate
        // line under the tool call it is running inside. The TUI adapter shares this
        // predicate and does the same thing with its tool block.
        if (isSubAgentEvent(frame)) {
            const label = subAgentActivityLabel(frame);
            // Only while a tool is actually open: a sub-agent frame outside any tool
            // call has nothing to be subordinate TO, and printing it at the root is the
            // burial this rule exists to prevent.
            if (label && openTools.size > 0) sink.out(`    ${label}\n`);
            return;
        }

        switch (frame.type) {
            case "text-delta":
                // Rule 3: write as received; the terminal accumulates.
                streamedText = true;
                sink.out(frame.text);
                return;
            case "tool-started": {
                const name = frame.name;
                // Opaque display text the harness computed from this call's input — printed, never parsed.
                const detail = frame.detail;
                openTools.set(frame.toolUseId, { name, startedAt: Date.now() });
                sink.out(`\n  [tool] ${name}${detail === undefined ? "" : ` ${detail}`} running...\n`);
                return;
            }
            case "tool-finished": {
                const name = frame.name;
                const started = openTools.get(frame.toolUseId);
                openTools.delete(frame.toolUseId);
                const dur = started ? ` (${formatMs(Date.now() - started.startedAt)})` : "";
                // Three outcomes get three words. `denied` is the user's own refusal of an approval, so
                // printing it as `error` would report their decision as a fault of the tool.
                const outcome = frame.outcome === "error" ? "error" : frame.outcome === "denied" ? "denied" : `done${dur}`;
                // A tool that describes its own result names the outcome here — the page it wrote, the
                // version it recorded — so the finished line prints what the running line could not know.
                const detail = frame.detail;
                sink.out(`  [tool] ${name}${detail === undefined ? "" : ` ${detail}`} ${outcome}\n`);
                return;
            }
            case "finish":
            case "error":
                // The REPL reads the summary of the turn after the stream ends, and reports the outcome from it.
                return;
            default: {
                // The one check of a part: each reader past this point trusts the type of the part.
                const checked = checkChatPart(frame);
                if (!checked.ok) {
                    getLogger("chat").warn({ type: frame.type, error: checked.error }, "chat part dropped: it failed the check of its type");
                    return;
                }
                renderDataPart(checked.frame);
                return;
            }
        }
    };

    function renderDataPart(part: ChatPartFrame): void {
        switch (part.type) {
            case "data-plan": {
                const plan = readPlanCard(part);
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
            case "data-run-card":
                sink.out(`\n  [run] ${part.runId}: ${part.title} (${part.stepCount} step(s))\n`);
                return;
            case "data-presentation": {
                const view = readPresentation(part);
                if (view.shape === "inline") renderInlinePresentation(view.title, view.body);
                else renderOpenables(view.title, [view.entry]);
                return;
            }
            case "data-file-reference": {
                const view = readFileReference(part);
                renderOpenables(view.title, view.entries);
                return;
            }
            case "data-ask":
                // One line for the approval and for its outcome. The REPL prompts for a pending ask after
                // this line (`answerPendingAsk`).
                sink.out(`\n  [approval] ${part.command} — ${part.status}\n`);
                return;
            default:
                // Rule 3: observe unknown parts, do not swallow them.
                sink.out(`  [part:${part.type}]\n`);
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

    return { frame: onFrame, finishTurn };
}
