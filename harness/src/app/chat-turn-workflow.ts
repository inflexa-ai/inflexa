/**
 * The chat turn as a DBOS workflow.
 *
 * The host opens a turn in its request: the harness checks the thread, resolves
 * the agent, claims the thread for the turn, and starts the workflow. The
 * workflow input holds ids and settings, the sanitized user text, and no
 * credential. The live credential stays in the memory of the process, and the
 * function of the host gives it to a turn that a recovery runs in a new process.
 *
 * The body prepares the opening in one step, reads the view of the thread up to
 * the last row before the turn, and runs the turn of `chat-turn.ts` with the
 * transport of a workflow: each model call and each tool call is a step, each
 * write of the turn is a step with a key, and the frames go to the durable
 * stream of the workflow. A host reads them with `read`.
 */

import { randomUUID } from "node:crypto";

import { DBOS } from "@dbos-inc/dbos-sdk";
import { closeDurableStream } from "@dbos-inc/vercel-ai";
import type { LanguageModelMiddleware } from "ai";
import { z } from "zod";

import type { AuthContext } from "../auth/types.js";
import type { ChatFrame, EventSource } from "../contracts/chat-events.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import type { AgentDefinition } from "../loop/types.js";
import { createConversationDisplayRecorder } from "../memory/conversation-display-recorder.js";
import { createThreadHistory } from "../memory/thread-history.js";
import type { ThreadType } from "../memory/thread-store.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import type { PromptCachePolicy } from "../providers/types.js";
import { claimThreadForTurn, closeOpenTurnRecords, releaseThreadOfTurn, turnOfAsk } from "../state/active-turns.js";
import type { AskReply, AskRequest } from "../tools/approval/contract.js";
import { askPartOf, type AskGateway } from "../tools/approval/gateway.js";
import type { AnswerOutcome } from "../tools/approval/queries.js";
import type { ApprovalDecision } from "../loop/run-loop.js";
import { stepUuid } from "../tools/workspace/edit-file.js";
import {
    openThread,
    readTurnContext,
    runOpenTurn,
    TurnCredentialMissingError,
    userTextOf,
    type ChatTurnRefusal,
    type ChatTurnSession,
    type RunChatTurnDeps,
    type TurnTransport,
} from "./chat-turn.js";
import { CHAT_STREAM_KEY, createTurnStreamWriter, readChatTurn } from "../loop/chat-stream.js";
import { turnCredentials, withRootTurn } from "../loop/turn-credentials.js";
import { assembleMessages, loadHistoryView, sanitizedUserMessage } from "./message-assembly.js";

/** The name of the turn workflow. */
export const CHAT_TURN_WORKFLOW = "chat-turn";

/** The input of a turn workflow: ids and settings, with no history and no credential. */
export type ChatTurnInput = {
    readonly turnId: string;
    readonly analysisId: string;
    readonly threadId: string;
    readonly threadType: ThreadType;
    /** The user text after the sanitization of the opening. */
    readonly userText: string;
    readonly userId: string;
    readonly author?: string;
    readonly startedAtMs: number;
    readonly promptCache?: PromptCachePolicy;
};

/** How a turn workflow ended. */
export type ChatTurnEnd = {
    readonly status: "done" | "aborted" | "failed";
    readonly reason?: string;
    readonly durationMs: number;
    readonly opened: boolean;
};

/** The values of a turn that a host opens. */
export type OpenChatTurnRequest = {
    readonly analysisId: string;
    readonly threadId: string;
    readonly userInput: string;
    /** Who sent the user message. */
    readonly author?: string;
    /** When the host got the message. Absent counts from the open. */
    readonly startedAtMs?: number;
    readonly promptCache?: PromptCachePolicy;
};

export type ChatTurnStart =
    { readonly kind: "started"; readonly turnId: string; readonly agent: AgentDefinition } | ChatTurnRefusal | { readonly kind: "turn_in_progress" };

/** The chat turns of a runtime, as a host uses them. */
export type ChatTurns = {
    /** Open a turn and start its workflow. A refusal comes back before the turn writes a row. */
    open(session: ChatTurnSession, request: OpenChatTurnRequest): Promise<ChatTurnStart>;
    /** The frames of a turn from its start, live, until the turn ends. A second read gives the same frames. */
    read(turnId: string): AsyncGenerator<ChatFrame>;
    /** Stop a turn. The turn closes as `aborted`. */
    stop(turnId: string): Promise<void>;
    /** Answer an ask. The turn that waits for it gets the answer, in the process that runs it. */
    answer(askId: string, reply: AskReply): Promise<AnswerOutcome>;
};

export type ChatTurnWorkflowDeps = RunChatTurnDeps & {
    /**
     * The credential of a turn that the process did not open, for example after a restart. A host with one fixed
     * credential gives it for each turn. Absent, or `undefined` for a turn: the turn ends as `interrupted` before
     * its next model call.
     */
    readonly credentialFor?: (turnId: string) => AuthContext | undefined;
    /** How long a turn waits for the answer of an ask. Absent: {@link DEFAULT_ASK_WAIT_SECONDS}. */
    readonly askWaitSeconds?: number;
};

/** A turn waits half an hour for the answer of an ask, and then the ask expires. */
export const DEFAULT_ASK_WAIT_SECONDS = 30 * 60;

const AskReplySchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("once") }),
    z.object({ kind: z.literal("always") }),
    z.object({ kind: z.literal("reject"), feedback: z.string().optional() }),
]);

/** The topic of the message that carries the answer of one ask to its turn. */
function askTopic(askId: string): string {
    return `ask:${askId}`;
}

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["PENDING", "ENQUEUED"]);

/** The part of the stored input of a turn workflow that the stop of a turn reads. */
const StoredTurnInputSchema = z.tuple([z.looseObject({ threadId: z.string() })]);

/** A middleware that fails each model call that a recovered turn makes with no credential. */
function missingCredentialGuard(): LanguageModelMiddleware {
    return {
        specificationVersion: "v4",
        wrapStream: () => Promise.reject(new TurnCredentialMissingError()),
        wrapGenerate: () => Promise.reject(new TurnCredentialMissingError()),
    };
}

/**
 * Register the turn workflow and give the chat turns of the runtime. Call it before DBOS launches, because DBOS
 * finds the workflow of a recovery by its registered name.
 */
export function registerChatTurns(deps: ChatTurnWorkflowDeps): ChatTurns {
    const logger = (deps.logger ?? createNoopLogger()).named("harness.chat");
    // The live credential of each turn that this process opened, and the stop of each turn that this process runs.
    const controls = new Map<string, AbortController>();
    turnCredentials.setHostCredential(deps.credentialFor);

    const workflow = DBOS.registerWorkflow(
        async (input: ChatTurnInput): Promise<ChatTurnEnd> => {
            const controller = new AbortController();
            controls.set(input.turnId, controller);
            try {
                return await withRootTurn(input.turnId, () => runTurnWorkflow(deps, input, controller.signal, turnCredentials.of(input.turnId)));
            } finally {
                controls.delete(input.turnId);
                turnCredentials.drop(input.turnId);
            }
        },
        { name: CHAT_TURN_WORKFLOW },
    );

    const stillRuns = async (turnId: string): Promise<boolean> => {
        const status = await DBOS.getWorkflowStatus(turnId);
        return status !== null && ACTIVE_STATUSES.has(status.status);
    };

    return {
        async open(session, request) {
            const startedAtMs = request.startedAtMs ?? Date.now();
            let threadType: ThreadType;
            try {
                const opened = await openThread(deps, request);
                if (opened.kind === "not_found") return opened;
                threadType = opened.threadType;
            } catch (cause) {
                return { kind: "prepare_failed", cause };
            }
            const agent = deps.agents.forThread(threadType);
            if (agent.isErr()) return { kind: "agent_unresolved", threadType };

            const turnId = randomUUID();
            const claim = await claimThreadForTurn(deps.pool, request.threadId, turnId, stillRuns);
            if (claim.isErr()) return { kind: "prepare_failed", cause: claim.error };
            if (claim.value.kind === "no_thread") return { kind: "not_found" };
            if (claim.value.kind === "held") return { kind: "turn_in_progress" };

            turnCredentials.put(turnId, session.auth);
            const input: ChatTurnInput = {
                turnId,
                analysisId: request.analysisId,
                threadId: request.threadId,
                threadType,
                userText: userTextOf(sanitizedUserMessage(request.userInput)),
                userId: session.identity.user,
                author: request.author,
                startedAtMs,
                promptCache: request.promptCache,
            };
            try {
                await DBOS.startWorkflow(workflow, { workflowID: turnId })(input);
            } catch (cause) {
                turnCredentials.drop(turnId);
                await releaseThreadOfTurn(deps.pool, request.threadId, turnId).unwrapOr(undefined);
                return { kind: "prepare_failed", cause };
            }
            return { kind: "started", turnId, agent: agent.value };
        },

        read(turnId) {
            return readChatTurn(turnId, {});
        },

        async stop(turnId) {
            const controller = controls.get(turnId);
            if (controller !== undefined) {
                controller.abort(new DOMException("The user stopped the turn.", "AbortError"));
                return;
            }
            // No process of this host runs the turn: the cancel ends the workflow and its sub-agents, and the harness
            // closes its records.
            const status = await DBOS.getWorkflowStatus(turnId);
            if (status === null || !ACTIVE_STATUSES.has(status.status)) return;
            await DBOS.cancelWorkflow(turnId, { cancelChildren: true });
            const input = StoredTurnInputSchema.safeParse(status.input);
            if (!input.success) return;
            const [{ threadId }] = input.data;
            const closed = await closeOpenTurnRecords(deps.pool, threadId);
            if (closed.isErr()) logger.warn("the record of a canceled turn did not close", { turnId, op: closed.error.op });
            await releaseThreadOfTurn(deps.pool, threadId, turnId).unwrapOr(undefined);
        },

        async answer(askId, reply) {
            if (deps.askGateway === undefined) return "not_found";
            const outcome = await deps.askGateway.answer(askId, reply);
            if (outcome !== "applied") return outcome;
            const turnId = await turnOfAsk(deps.pool, askId).unwrapOr(undefined);
            if (turnId !== undefined) await DBOS.send(turnId, reply, askTopic(askId));
            return outcome;
        },
    };
}

/**
 * The approval of a turn workflow. The raise of the ask is a step, and the turn waits for the answer with a durable
 * wait of its body, thus a recovery waits again for the same ask. A stop of the turn ends the wait.
 */
function workflowApproval(
    gateway: AskGateway,
    input: ChatTurnInput,
    emitPart: (part: ReturnType<typeof askPartOf>) => Promise<void>,
    signal: AbortSignal,
    waitSeconds: number,
): (request: AskRequest, call: { readonly toolCallId: string }) => Promise<ApprovalDecision> {
    return async (request, call) => {
        const id = stepUuid(`${input.turnId}:ask:${call.toolCallId}`);
        const scope = { analysisId: input.analysisId, userId: input.userId, threadId: input.threadId };
        const raised = await DBOS.runStep(() => gateway.raise(id, request, scope), { name: "chat-turn.ask" });
        if (raised === "granted") {
            await emitPart(askPartOf(id, request, "resolved", "always"));
            return { kind: "approved" };
        }
        await emitPart(askPartOf(id, request, "pending"));

        const stopped = new Promise<"stopped">((resolve) => {
            if (signal.aborted) resolve("stopped");
            signal.addEventListener("abort", () => resolve("stopped"), { once: true });
        });
        const answered = await Promise.race([DBOS.recv<unknown>(askTopic(id), waitSeconds), stopped]);
        if (answered === "stopped") {
            await DBOS.runStep(() => gateway.abort(id), { name: "chat-turn.ask-abort" });
            await emitPart(askPartOf(id, request, "aborted"));
            throw signal.reason ?? new DOMException("The user stopped the turn.", "AbortError");
        }
        const reply = AskReplySchema.safeParse(answered);
        if (!reply.success) {
            await DBOS.runStep(() => gateway.expire(id), { name: "chat-turn.ask-expire" });
            await emitPart(askPartOf(id, request, "expired"));
            return { kind: "denied", feedback: "The approval expired unanswered." };
        }
        if (reply.data.kind === "reject") {
            await emitPart(askPartOf(id, request, "rejected", "reject"));
            return { kind: "denied", feedback: reply.data.feedback };
        }
        await emitPart(askPartOf(id, request, "resolved", reply.data.kind));
        return { kind: "approved" };
    };
}

async function runTurnWorkflow(
    deps: ChatTurnWorkflowDeps,
    input: ChatTurnInput,
    signal: AbortSignal,
    credential: AuthContext | undefined,
): Promise<ChatTurnEnd> {
    const agent = deps.agents.forThread(input.threadType);
    if (agent.isErr()) throw new Error(`No agent is registered for the thread type "${input.threadType}".`);
    const rootSource: EventSource = { agentId: agent.value.id, callPath: [agent.value.id] };
    const history = createThreadHistory(deps.pool, deps.logger);

    const opening = await DBOS.runStep(
        async () => {
            const endSeq = unwrapOrThrow(await history.latestSeq(input.threadId)) ?? -1;
            const assembled = await assembleMessages({
                threadId: input.threadId,
                threadType: input.threadType,
                analysisId: input.analysisId,
                userInput: input.userText,
                ...(await readTurnContext(deps.pool, input.analysisId)),
                history,
                workingMemory: createWorkingMemory(deps.pool),
                logger: deps.logger,
                throughSeq: endSeq,
            });
            return { endSeq, userMessage: assembled.userMessage, contextRecords: assembled.contextRecords };
        },
        { name: "chat-turn.prepare" },
    );
    // The rows up to the turn never change, thus a replay reads the same view, and no checkpoint holds the thread.
    const view = await loadHistoryView({ threadId: input.threadId, threadType: input.threadType, history, logger: deps.logger, throughSeq: opening.endSeq });

    const recorder = createConversationDisplayRecorder({
        userText: userTextOf(opening.userMessage),
        agentId: agent.value.id,
        sink: () => undefined,
        messageIds: { user: stepUuid(`${input.turnId}:user`), assistant: (index) => stepUuid(`${input.turnId}:assistant:${index}`) },
    });
    const writer = createTurnStreamWriter(rootSource, (frame) => recorder.observe(frame));
    await writer.write({ type: "message-start", messageId: recorder.userMessageId(), role: "user", source: rootSource });
    await writer.write({ type: "message-start", messageId: recorder.assistantMessageId(), role: "assistant", source: rootSource });

    const transport: TurnTransport = {
        signal,
        emit: writer.emit,
        chatStream: CHAT_STREAM_KEY,
        toolWriter: writer.toolWriter,
        recorder,
        durably: (name, write) => DBOS.runStep(write, { name }),
        groupKey: (index) => `${input.turnId}:${index}`,
        announce: (messageId) => writer.write({ type: "message-start", messageId, role: "assistant", source: rootSource }),
        modelMiddleware: credential === undefined ? [missingCredentialGuard()] : undefined,
        approve:
            deps.askGateway === undefined
                ? undefined
                : workflowApproval(
                      deps.askGateway,
                      input,
                      async (part) => {
                          await writer.emit({ type: "data-ask", data: part });
                      },
                      signal,
                      deps.askWaitSeconds ?? DEFAULT_ASK_WAIT_SECONDS,
                  ),
    };
    const session: ChatTurnSession = {
        identity: { user: input.userId },
        scope: { kind: "analysis", analysisId: input.analysisId, threadId: input.threadId },
        // A turn with no credential makes no model call, thus no adapter reads the empty value.
        auth: credential ?? {},
    };
    const ran = await runOpenTurn(
        deps,
        { analysisId: input.analysisId, threadId: input.threadId, userInput: input.userText },
        { kind: "ok", threadType: input.threadType, history: view, userMessage: opening.userMessage, contextRecords: opening.contextRecords },
        agent.value,
        { session, author: input.author, startedAtMs: input.startedAtMs, promptCache: input.promptCache },
        transport,
    );

    const { outcome } = ran;
    await writer.write(
        outcome.status === "failed"
            ? { type: "error", message: outcome.reason, reason: outcome.reason, source: rootSource }
            : { type: "finish", source: rootSource, turnUsage: ran.turnUsage },
    );
    await writer.settle();
    await closeDurableStream(CHAT_STREAM_KEY, outcome.status === "done" ? "stop" : outcome.status === "aborted" ? "aborted" : "error");
    await DBOS.runStep(async () => unwrapOrThrow(await releaseThreadOfTurn(deps.pool, input.threadId, input.turnId)), { name: "chat-turn.release" });
    return { status: outcome.status, reason: outcome.status === "failed" ? outcome.reason : undefined, durationMs: ran.durationMs, opened: ran.opened };
}
