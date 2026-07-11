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

import { randomUUIDv7 } from "bun";
import { intro, log, outro, spinner, text, isCancel } from "@clack/prompts";
import { type ResultAsync } from "neverthrow";
import { createStreamingChat, createThreadHistory, createThreadStore, type AgentChat, type AgentSession, type DbError, type Thread } from "@inflexa-ai/harness";

import { describeCause } from "../../lib/cause.ts";
import { fail } from "../../lib/cli.ts";
import { acquireInstanceLock } from "../../lib/lock.ts";
import { shutdown } from "../../lib/shutdown.ts";
import type { ContextFlags } from "../analysis/context.ts";
import { resolveHarnessConfig } from "./config.ts";
import { createChatPrinter, type ChatSink } from "./chat_printer.ts";
import { describeBootError, ensureSandboxImage, resolveSingleAnalysis } from "./profile.ts";
import { bootHarnessRuntime, type HarnessRuntime } from "./runtime.ts";
import { buildChatSession, runChatTurn } from "./turn.ts";

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
    // single-process for the whole chat — the interim two-recorder fix of #37,
    // the same guard the TUI takes on open. Acquired after the fail-fast pre-flight
    // and before the runtime boots; the process-exit hook (src/index.ts) releases
    // it on every exit, so a bail-out below leaks nothing.
    const lock = acquireInstanceLock(analysis.id);
    if (!lock.acquired) {
        fail(`"${analysis.name}" is already open in another instance (pid ${lock.holderPid}). Wait for it to finish or stop that process, then re-run.`);
    }

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
    const printer = createChatPrinter(sink);

    // Live token streaming. `runAgent`'s `provider` option is `AgentChat` (one
    // collapsed response per call — `RunAgentOptions`, harness loop/run-agent.ts),
    // and the raw `ChatProvider` satisfies it NON-streaming: its `chat` never
    // emits deltas, so answers would only render whole at turn end.
    // `createStreamingChat` builds an `AgentChat` over the provider's `chatStream`
    // primitive instead, forwarding each text delta into the printer's own
    // text-delta channel (through `emit`, so the printer's per-turn streamed flag
    // and copy-on-receive rules apply unchanged). Only THIS top-level loop runs
    // on the wrapper — sub-agent loops (planner, literature reviewer) were wired
    // to the plain provider at assembly, so their tokens never reach the sink.
    // Abort semantics are untouched: the wrapper re-throws an AbortError verbatim.
    const chat = createStreamingChat(runtime.conversation.provider, (text) => void printer.emit({ type: "text-delta", text }));

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
        const outcome = await runTurn(runtime, chat, history, printer, sink, session, analysisId, threadId, userInput);
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
 *     an `aborted` outcome (having persisted `[userMessage]`), and we return
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
 * `[userMessage, ...loopOutput]` on a clean turn and `[userMessage]` on abort/throw,
 * surfacing any `appendTurn` fault as `outcome.appendError` — reported here on every
 * `runAgent`-reaching branch.
 * On a clean turn the answer already streamed live through `chat`'s onText, so
 * `finishTurn(fallbackText)` suppresses its duplicate final render; the fallback
 * prints only for a turn that produced no deltas at all.
 */
async function runTurn(
    runtime: HarnessRuntime,
    chat: AgentChat,
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
            conversationAgent: runtime.conversationAgent,
            chat,
            history,
            session,
            emit: printer.emit,
            signal: controller.signal,
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
