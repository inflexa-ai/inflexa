/**
 * A chat turn in the process of a test, with no workflow. The turn of `chat-turn.ts` runs over a transport that
 * streams to an emit sink and runs each write directly, thus a test drives the storage and the loop of a turn with
 * no DBOS engine. A host reaches a turn through the turn workflow only, and `inProcessChatTurns` gives the test of
 * a host the same surface over this turn.
 */

import { randomUUID } from "node:crypto";

import type { ChatFrame } from "../contracts/chat-events.js";
import { toChatFrame } from "../contracts/chat-frame.js";
import { chatTurnEndOf, type ChatTurnEnd, type ChatTurns } from "./chat-turn-workflow.js";

import type { LoopOptions } from "../loop/run-loop.js";
import type { EmitFn } from "../loop/types.js";
import { createConversationDisplayRecorder } from "../memory/conversation-display-recorder.js";
import type { PromptCachePolicy } from "../providers/types.js";
import type { AgentDefinition } from "../loop/types.js";
import {
    prepareChatTurn,
    runOpenTurn,
    userTextOf,
    type ChatTurnRan,
    type ChatTurnRefusal,
    type ChatTurnSession,
    type OpenChatTurnParams,
    type PrepareChatTurnResult,
    type RunChatTurnDeps,
} from "./chat-turn.js";

/** The transport values of a turn in process. */
export type InProcessRunParams = {
    readonly session: ChatTurnSession;
    readonly emit: EmitFn;
    readonly signal: AbortSignal;
    readonly author?: string;
    /** Absent counts from the open. */
    readonly startedAtMs?: number;
    readonly promptCache?: PromptCachePolicy;
    /** The decision of the user on a call that asks for approval. Absent: the loop denies the call. */
    readonly approve?: LoopOptions["approve"];
};

export type InProcessTurnParams = OpenChatTurnParams & InProcessRunParams;

export type InProcessTurnResult = ChatTurnRefusal | ChatTurnRan;

/** A prepared turn with its agent. Call `run` one time: each call stores a new opening of the same user message. */
export type InProcessOpenTurn = {
    readonly kind: "ready";
    readonly agent: AgentDefinition;
    readonly run: (params: InProcessRunParams) => Promise<ChatTurnRan>;
};

/** Prepare a turn and resolve its agent. A refusal comes back before any row of the turn exists. */
export async function openInProcessTurn(deps: RunChatTurnDeps, params: OpenChatTurnParams): Promise<InProcessOpenTurn | ChatTurnRefusal> {
    const openedAtMs = Date.now();
    let prepared: PrepareChatTurnResult;
    try {
        prepared = await prepareChatTurn(deps, params);
    } catch (cause) {
        return { kind: "prepare_failed", cause };
    }
    if (prepared.kind === "not_found") return prepared;
    const agent = deps.agents.forThread(prepared.threadType);
    if (agent.isErr()) return { kind: "agent_unresolved", threadType: prepared.threadType };
    const ready = prepared;
    return {
        kind: "ready",
        agent: agent.value,
        run: (run) => {
            const recorder = createConversationDisplayRecorder({ userText: userTextOf(ready.userMessage), agentId: agent.value.id, sink: run.emit });
            return runOpenTurn(
                deps,
                params,
                ready,
                agent.value,
                { session: run.session, author: run.author, startedAtMs: run.startedAtMs ?? openedAtMs, promptCache: run.promptCache },
                {
                    signal: run.signal,
                    emit: recorder.emit,
                    onText: (text) => recorder.emit({ type: "text-delta", text }),
                    recorder,
                    durably: (_name, write) => write(),
                    approve: run.approve,
                },
            );
        },
    };
}

/** Open a turn in process and run it. */
export async function runInProcessTurn(deps: RunChatTurnDeps, params: InProcessTurnParams): Promise<InProcessTurnResult> {
    const { analysisId, threadId, userInput, ...run } = params;
    const opened = await openInProcessTurn(deps, { analysisId, threadId, userInput });
    if (opened.kind !== "ready") return opened;
    return opened.run(run);
}

/** The frames of one turn: each read gives them from the start, live until the turn ends. */
type FrameLog = {
    push(frame: ChatFrame): void;
    close(): void;
    read(): AsyncGenerator<ChatFrame>;
};

function createFrameLog(): FrameLog {
    const frames: ChatFrame[] = [];
    let closed = false;
    let waiters: (() => void)[] = [];
    const wake = (): void => {
        const woken = waiters;
        waiters = [];
        for (const resolve of woken) resolve();
    };
    return {
        push(frame) {
            frames.push(frame);
            wake();
        },
        close() {
            closed = true;
            wake();
        },
        async *read() {
            for (let index = 0; ; index += 1) {
                while (index >= frames.length) {
                    if (closed) return;
                    await new Promise<void>((resolve) => waiters.push(resolve));
                }
                const frame = frames[index];
                if (frame !== undefined) yield frame;
            }
        },
    };
}

/**
 * The chat turns of a host test, over the turn in process: `open` starts the turn at once, `read` gives its frames
 * with the end frame of a turn workflow, `stop` aborts it, and `outcome` gives its end. An ask has no answer here,
 * thus a call that asks for an approval is denied.
 */
export function inProcessChatTurns(deps: RunChatTurnDeps): ChatTurns {
    const turns = new Map<string, { readonly log: FrameLog; readonly controller: AbortController; readonly end: Promise<ChatTurnEnd | null> }>();
    return {
        async open(session, request) {
            const opened = await openInProcessTurn(deps, { analysisId: request.analysisId, threadId: request.threadId, userInput: request.userInput });
            if (opened.kind !== "ready") return opened;
            const turnId = randomUUID();
            const rootSource = { agentId: opened.agent.id, callPath: [opened.agent.id] };
            const log = createFrameLog();
            const controller = new AbortController();
            const end = opened
                .run({
                    session,
                    emit: (event) => {
                        const frame = toChatFrame(event, rootSource);
                        if (frame !== null) log.push(structuredClone(frame));
                    },
                    signal: controller.signal,
                    author: request.author,
                    startedAtMs: request.startedAtMs,
                    promptCache: request.promptCache,
                })
                .then((ran): ChatTurnEnd => {
                    const turnEnd = chatTurnEndOf(ran);
                    log.push(
                        turnEnd.status === "failed"
                            ? { type: "error", message: turnEnd.reason ?? "The turn failed.", reason: turnEnd.code, source: rootSource }
                            : { type: "finish", source: rootSource, turnUsage: turnEnd.turnUsage },
                    );
                    return turnEnd;
                })
                .catch(() => null)
                .finally(() => log.close());
            turns.set(turnId, { log, controller, end });
            return { kind: "started", turnId, agent: opened.agent };
        },
        read(turnId) {
            const turn = turns.get(turnId);
            if (turn === undefined) throw new Error(`No turn ${turnId} runs in this process.`);
            return turn.log.read();
        },
        stop(turnId) {
            turns.get(turnId)?.controller.abort(new DOMException("The user stopped the turn.", "AbortError"));
            return Promise.resolve();
        },
        answer: () => Promise.resolve("not_found"),
        outcome: (turnId) => turns.get(turnId)?.end ?? Promise.resolve(null),
    };
}
