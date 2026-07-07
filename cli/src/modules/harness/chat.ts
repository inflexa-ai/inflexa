// TODO(extend): `inflexa chat` is a deliberately temporary walking-skeleton dev
// surface — a clack/stdout REPL that drives the harness conversation agent so the
// whole embedded loop (assemble → prepareChatTurn → runAgent → appendTurn) can be
// exercised end-to-end before a real client exists. Its named replacement is the
// daemon chat engine + TUI client (#33 M3/M4): once that lands, this command and
// its printer are deleted and the conversation moves onto the daemon transport.
// Everything this file exercises transfers verbatim — the turn halves, the session
// scope that stamps `cortex_runs.thread_id`, the emit categories — only the
// transport (a clack line prompt + a coarse stdout printer) is throwaway. The
// standing record to clear is the `chat-command` spec (the delta lives in
// `openspec/changes/embed-conversation-agent/specs/chat-command/spec.md` until it
// syncs to `openspec/specs/chat-command/spec.md`). Do NOT grow this into a product
// surface: rendering, reconnect, and multi-client behavior are #33's, not here.

import { randomUUIDv7 } from "bun";
import { intro, log, outro, spinner, text, isCancel } from "@clack/prompts";
import { ResultAsync } from "neverthrow";
import {
    createStreamingChat,
    createThreadHistory,
    createThreadStore,
    finalText,
    makeLocalAuth,
    passthroughStep,
    prepareChatTurn,
    runAgent,
    type AgentChat,
    type AgentSession,
    type DbError,
    type ModelMessage,
    type Thread,
} from "@inflexa-ai/harness";

import { fail } from "../../lib/cli.ts";
import { acquireInstanceLock } from "../../lib/lock.ts";
import { shutdown } from "../../lib/shutdown.ts";
import type { ContextFlags } from "../analysis/context.ts";
import { resolveHarnessConfig } from "./config.ts";
import { createChatPrinter, type ChatSink } from "./chat_printer.ts";
import { describeBootError, ensureSandboxImage, resolveSingleAnalysis } from "./profile.ts";
import { bootHarnessRuntime, type HarnessRuntime } from "./runtime.ts";

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

/** `unknown` → a one-line message, the shape the other harness commands use. */
function errText(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
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
    s.stop(`Runtime ready — model ${runtime.model}`);

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
 * appendTurn` — under a turn-scoped abort signal (design D7). The loop ends two
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
    const chat = createStreamingChat(runtime.provider, (text) => void printer.emit({ type: "text-delta", text }));

    // The session carries `threadId` IN scope — load-bearing: `execute_plan`
    // reads `session.scope.threadId` and stamps `cortex_runs.thread_id` from it,
    // so a plan launched from this chat carries thread lineage (design D4). The
    // top-level `callPath` has length 1, so the printer's sub-agent depth filter
    // (drop `callPath.length > 1`) keeps this agent's events and drops planner /
    // literature-reviewer traffic.
    const session: AgentSession = {
        identity: { user: "local" },
        scope: { kind: "analysis", analysisId, threadId },
        provenance: { agentId: "cli-chat", callPath: ["cli-chat"] },
        auth: makeLocalAuth(),
    };

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
 * One chat turn under a turn-scoped `AbortController` (design D7). Returns
 * `"continue"` to keep the REPL prompting or `"stop"` to end it — the loop, not
 * this function, owns teardown, which is exactly what makes the second-SIGINT
 * path race-free.
 *
 * The SIGINT handler is installed for the turn's duration only, so the idle
 * prompt keeps clack's own Ctrl+C handling (isCancel → clean exit):
 *
 *   - FIRST SIGINT: abort the turn. `runAgent` throws its AbortError, the turn
 *     unwinds through `appendTurn`/`finishTurn`, and we return `"continue"` — back
 *     to the prompt.
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
 * `appendTurn` ALWAYS runs on every `runAgent`-reaching path — even on abort or a
 * thrown turn — so the turn persists. On a clean return that is
 * `[userMessage, ...loopOutput]`; on a throw/abort the harness's `runAgent` throws
 * BEFORE returning its message array (the AbortError propagates out of the
 * streaming `chat`), so the partial loop output is structurally unavailable and
 * only `[userMessage]` can be persisted — though the tokens streamed before the
 * abort remain visible on the terminal.
 *
 * On a clean turn the answer already streamed live through `chat`'s onText, so
 * `finishTurn(fallbackText)` suppresses its duplicate final render (the deltas
 * and `finalText` are the same content); the fallback prints only for a turn
 * that produced no deltas at all.
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
    try {
        const prepared = await ResultAsync.fromPromise(prepareChatTurn({ pool: runtime.pool }, { analysisId, threadId, userInput }), (e): unknown => e).match(
            (r) => r,
            (cause) => ({ kind: "prepare_failed" as const, cause }),
        );
        if (prepared.kind === "prepare_failed") {
            sink.errLine(`Could not assemble the turn (is Postgres reachable?): ${errText(prepared.cause)}`);
            // Emit the per-turn separator + reset state on this pre-`runAgent` bail
            // too, so output shape stays uniform with the streamed path (nothing
            // streamed here, so there is no double print).
            printer.finishTurn();
            return forceStop ? "stop" : "continue";
        }
        if (prepared.kind === "not_found") {
            // Reachable only if the thread was deleted mid-session (the resume
            // pre-check already refused foreign/absent ids before the REPL began).
            sink.errLine("This conversation thread is no longer available.");
            printer.finishTurn();
            return forceStop ? "stop" : "continue";
        }

        const initial = prepared.messages;
        const { toPersist, fallbackText } = await ResultAsync.fromPromise(
            runAgent(runtime.conversationAgent, initial, session, {
                provider: chat,
                signal: controller.signal,
                emit: printer.emit,
                runStep: passthroughStep,
            }),
            (e): unknown => e,
        ).match(
            (result) => ({
                toPersist: [prepared.userMessage, ...result.messages.slice(initial.length)] as ModelMessage[],
                fallbackText: finalText(result.messages),
            }),
            (cause) => {
                if (controller.signal.aborted) sink.out("\n  [interrupted]\n");
                else sink.errLine(`The turn failed: ${errText(cause)}`);
                return { toPersist: [prepared.userMessage] as ModelMessage[], fallbackText: "" };
            },
        );

        // Persist unconditionally — the partial turn must survive an abort/throw.
        (await history.appendTurn(threadId, toPersist)).match(
            () => {},
            (e) => sink.errLine(`Could not save the turn to the thread (${e.type}).`),
        );
        printer.finishTurn(fallbackText);
        // A second SIGINT during the turn requests a deterministic stop; report it
        // up so `runRepl` tears down after the turn has fully unwound (the `finally`
        // below still runs first, removing this turn's SIGINT listener).
        return forceStop ? "stop" : "continue";
    } finally {
        process.removeListener("SIGINT", onSigint);
    }
}
