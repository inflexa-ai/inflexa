import { join } from "node:path";

import { randomUUIDv7 } from "bun";
import { Hono, type Context } from "hono";
import { Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
    createStreamingChat,
    createThreadHistory,
    createThreadStore,
    reportSessionDir,
    storedMessagesToChat,
    toChatFrame,
    type ChatFrame,
    type DbError,
    type Pool,
    type StoredMessage,
    type Thread,
    type ThreadStore,
} from "@inflexa-ai/harness";
import type { EventSource } from "@inflexa-ai/harness/contracts/index.js";

import {
    TURN_ID_HEADER,
    type AbortTurnResponse,
    type AnswerAskResponse,
    type AskList,
    type CredentialVerdictView,
    type DeletedThread,
    type MessageList,
    type PurgedThread,
    type ReportPageFate,
    type RetractResponse,
    type ThreadList,
    type ThreadSummary,
    type TurnFailure,
    type TurnList,
} from "../../api/conversation.ts";
import { findAnalysesByRef } from "../../db/primary_query.ts";
import { causeDetailLines, describeCause, findAuthCause } from "../../lib/cause.ts";
import { rmResultAsync, type FsError } from "../../lib/fs.ts";
import { getLogger } from "../../lib/log.ts";
import { locateExistingOutputDir } from "../../modules/analysis/output.ts";
import { resolveModelConnection, type ModelConnectionIdentity } from "../../modules/harness/config.ts";
import { buildChatSession, healTailOrphan, retractTailTurn, runChatTurn, type RunChatTurnArgs, type TurnOutcome } from "../../modules/harness/turn.ts";
import { readCredentialVerdict, type CredentialStateError, type CredentialVerdict } from "../../modules/infra/credential_state.ts";
import { MODEL_API_KEY_VAR, providerKindForSlug } from "../../modules/infra/setup.ts";
import { startPendingFlushChild } from "../../modules/libs/store.ts";
import type { ServerBoot } from "../boot.ts";
import {
    apiError,
    DEFAULT_SSE_OPTS,
    internalError,
    listEnvelope,
    parsePage,
    readBody,
    requireRuntime,
    sseResponse,
    type ServerEnv,
    type SseOpts,
} from "../http.ts";
import { abortTurn, endTurn, findTurn, forgetTurn, listThreadTurns, newTurnsRefused, startTurn, type TurnEnding } from "../turns.ts";

/**
 * Where the page files of an analysis live, or why the server cannot name them. An analysis whose workspace
 * tree was never written holds no page folder (`absent`). A tree that the server cannot locate can hold one.
 */
export type WorkspaceRootLookup = { readonly kind: "root"; readonly root: string } | { readonly kind: "absent" } | { readonly kind: "unlocatable" };

/** What the conversation routes are built from. Tests replace each one, because no cli test reaches Postgres or a model. */
export type ConversationRouteOpts = {
    /** The thread store over the pool. Real: `createThreadStore`. */
    readonly threads: (pool: Pool) => ThreadStore;
    /** Each turn of a thread, for the transcript. Real: `createThreadHistory(pool).loadAll`. */
    readonly loadTurns: (pool: Pool, threadId: string) => ResultAsync<StoredMessage[][], DbError>;
    /** Remove the tail turn. With `ifOrphan`, only a tail turn with no assistant row. Real: `retractTailTurn`, `healTailOrphan`. */
    readonly retract: (pool: Pool, threadId: string, ifOrphan: boolean) => ResultAsync<RetractResponse, DbError>;
    /** The analysis of a thread, archived or live, or `null` when no row has the id. Real: one primary-key read. */
    readonly threadAnalysisId: (pool: Pool, threadId: string) => ResultAsync<string | null, DbError>;
    /** One chat turn. Real: `runChatTurn` of `modules/harness/turn.ts`. */
    readonly runTurn: (args: RunChatTurnArgs) => Promise<TurnOutcome>;
    /** The model connection, for the remedy of a failed turn. Real: `resolveModelConnection`. */
    readonly connection: () => ModelConnectionIdentity;
    /** The credential state of the proxy after a failed `cliproxy` turn. Real: `readCredentialVerdict`. */
    readonly readCredentialVerdict: () => Promise<Result<CredentialVerdict, CredentialStateError>>;
    /** The sweep of the queued package adds at the end of each turn. Real: `startPendingFlushChild`. */
    readonly flushPendingAdds: () => void;
    /** The workspace root of an analysis. Real: `locateExistingOutputDir` over the analysis row. */
    readonly workspaceRoot: (analysisId: string) => WorkspaceRootLookup;
    /** Remove one report page folder by force. Ok when the folder is gone. Real: `rmResultAsync`. */
    readonly removeDir: (dir: string) => ResultAsync<void, FsError>;
    readonly sse: SseOpts;
};

/** The production {@link ConversationRouteOpts}. */
export const DEFAULT_CONVERSATION_ROUTE_OPTS: ConversationRouteOpts = {
    threads: createThreadStore,
    loadTurns: (pool, threadId) => createThreadHistory(pool).loadAll(threadId),
    retract: (pool, threadId, ifOrphan) => (ifOrphan ? healTailOrphan(pool, threadId) : retractTailTurn(pool, threadId)),
    threadAnalysisId,
    runTurn: (args) => runChatTurn(args),
    connection: resolveModelConnection,
    readCredentialVerdict,
    flushPendingAdds: () => void startPendingFlushChild(),
    workspaceRoot,
    removeDir: (dir) => rmResultAsync(dir, "remove a report page folder"),
    sse: DEFAULT_SSE_OPTS,
};

/** The ask user id of each turn: one person owns a local install, and the cli holds no account model. */
const LOCAL_ASK_USER_ID = "local";

/**
 * The source of the frames that the route makes itself: the `text-delta` of the root provider, which carries
 * none, and the terminal frame. A path of one entry is a root frame, which is all that a client reads.
 */
const ROOT_SOURCE: EventSource = { agentId: "chat", callPath: ["chat"] };

/** The body of `POST {A}/chat`. Both values must be non-empty, as in Cortex. */
const chatBody = z.object({ threadId: z.string().min(1), message: z.string().min(1) });

/** The body of `PATCH {T}`. */
const updateThreadBody = z.object({ title: z.string() });

/** The body of `POST {T}/purge`. */
const purgeThreadBody = z.object({ files: z.enum(["keep", "remove"]) });

/** The body of `POST {T}/retract`. */
const retractBody = z.object({ ifOrphan: z.boolean().optional() });

/** The body of `POST {A}/asks/:askId/answer`: an `AskReply`. The feedback limit is the Cortex limit. */
const askReplyBody = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("once") }),
    z.object({ kind: z.literal("always") }),
    z.object({ kind: z.literal("reject"), feedback: z.string().max(2000).optional() }),
]);

/**
 * The routes of draft 2.3 under `/api/v1/analyses`: the threads, the chat turn and the turn registry, and
 * the asks. The thread, chat, and ask routes read Postgres through the runtime, thus they wait for the boot.
 * The turn routes read the registry of this process only.
 */
export function conversationRoutes(boot: ServerBoot, opts: ConversationRouteOpts = DEFAULT_CONVERSATION_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    const runtime = requireRuntime(boot);

    routes.get("/:analysisId/threads", runtime, async (c) => {
        const analysisId = c.req.param("analysisId");
        const type = c.req.query("type");
        if (type !== undefined && type !== "conversation" && type !== "report") {
            return apiError(c, "validation_error", "`type` must be `conversation` or `report`.", { fieldErrors: { type: ["must be conversation or report"] } });
        }
        const parentThreadId = c.req.query("parentThreadId");
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const listed = await opts.threads(c.get("runtime").pool).listThreads({
            analysisId,
            page: page.page,
            perPage: page.perPage,
            includeArchived: c.req.query("includeArchived") === "true",
            ...(type === undefined ? {} : { type }),
            ...(parentThreadId === undefined ? {} : { parentThreadId }),
        });
        return listed.match(
            (result) => c.json<ThreadList>(listEnvelope("threads", result.threads.map(toThreadSummary), result.total, page)),
            (e) => internalError(c, e, "list the threads"),
        );
    });

    routes.get("/:analysisId/threads/:threadId", runtime, async (c) => {
        const { analysisId, threadId } = c.req.param();
        return (await liveThreadOf(opts.threads(c.get("runtime").pool), analysisId, threadId)).match(
            (thread) => (thread === null ? threadNotFound(c) : c.json(toThreadSummary(thread))),
            (e) => internalError(c, e, "read a thread"),
        );
    });

    routes.patch("/:analysisId/threads/:threadId", runtime, async (c) => {
        const { analysisId, threadId } = c.req.param();
        const body = await readBody(c, updateThreadBody);
        if (body.isErr()) return body.error;
        const title = body.value.title.trim();
        if (title === "") return apiError(c, "validation_error", "The title must not be blank.", { fieldErrors: { title: ["must not be blank"] } });
        const store = opts.threads(c.get("runtime").pool);
        const renamed = await liveThreadOf(store, analysisId, threadId).andThen((thread) =>
            thread === null ? ResultAsync.fromSafePromise<Thread | null, DbError>(Promise.resolve(null)) : store.updateTitle(threadId, title),
        );
        return renamed.match(
            (thread) => (thread === null ? threadNotFound(c) : c.json(toThreadSummary(thread))),
            (e) => internalError(c, e, "rename a thread"),
        );
    });

    routes.delete("/:analysisId/threads/:threadId", runtime, async (c) => {
        const { analysisId, threadId } = c.req.param();
        const store = opts.threads(c.get("runtime").pool);
        const archived = await liveThreadOf(store, analysisId, threadId).andThen((thread) =>
            thread === null ? ResultAsync.fromSafePromise<boolean, DbError>(Promise.resolve(false)) : store.archiveThread(threadId).map(() => true),
        );
        return archived.match(
            (done) => (done ? c.json<DeletedThread>({ deleted: true }) : threadNotFound(c)),
            (e) => internalError(c, e, "archive a thread"),
        );
    });

    routes.post("/:analysisId/threads/:threadId/restore", runtime, async (c) => {
        const { analysisId, threadId } = c.req.param();
        const pool = c.get("runtime").pool;
        const store = opts.threads(pool);
        // The live read cannot see an archived row, thus the scope comes from a read that can.
        const restored = await opts
            .threadAnalysisId(pool, threadId)
            .andThen((owner) =>
                owner !== analysisId
                    ? ResultAsync.fromSafePromise<Thread | null, DbError>(Promise.resolve(null))
                    : store.unarchiveThread(threadId).andThen(() => store.getThread(threadId)),
            );
        return restored.match(
            (thread) => (thread === null ? threadNotFound(c) : c.json(toThreadSummary(thread))),
            (e) => internalError(c, e, "restore a thread"),
        );
    });

    routes.post("/:analysisId/threads/:threadId/purge", runtime, async (c) => {
        const { analysisId, threadId } = c.req.param();
        const body = await readBody(c, purgeThreadBody);
        if (body.isErr()) return body.error;
        const store = opts.threads(c.get("runtime").pool);
        const purged = await liveThreadOf(store, analysisId, threadId).andThen((thread) =>
            thread === null ? ResultAsync.fromSafePromise<readonly string[] | null, DbError>(Promise.resolve(null)) : store.purgeThread(threadId),
        );
        if (purged.isErr()) return internalError(c, purged.error, "purge a thread");
        if (purged.value === null) return threadNotFound(c);
        const erased = [...purged.value];
        return c.json<PurgedThread>({ purged: erased, pages: await reclaimReportPages(analysisId, erased, body.value.files, opts) });
    });

    routes.get("/:analysisId/threads/:threadId/messages", runtime, async (c) => {
        const { analysisId, threadId } = c.req.param();
        const pool = c.get("runtime").pool;
        const turns = await liveThreadOf(opts.threads(pool), analysisId, threadId).andThen((thread) =>
            thread === null ? ResultAsync.fromSafePromise<StoredMessage[][] | null, DbError>(Promise.resolve(null)) : opts.loadTurns(pool, threadId),
        );
        return turns.match(
            (loaded) => {
                if (loaded === null) return threadNotFound(c);
                // The Cortex form: the whole transcript, with `total` the count of turns and one page that holds it.
                const messages = storedMessagesToChat(loaded.flat());
                return c.json<MessageList>(listEnvelope("messages", messages, loaded.length, { page: 0, perPage: loaded.length }));
            },
            (e) => internalError(c, e, "read the transcript"),
        );
    });

    routes.post("/:analysisId/threads/:threadId/retract", runtime, async (c) => {
        const { analysisId, threadId } = c.req.param();
        const body = await readBody(c, retractBody);
        if (body.isErr()) return body.error;
        const pool = c.get("runtime").pool;
        const retracted = await liveThreadOf(opts.threads(pool), analysisId, threadId).andThen((thread) =>
            thread === null
                ? ResultAsync.fromSafePromise<RetractResponse | null, DbError>(Promise.resolve(null))
                : opts.retract(pool, threadId, body.value.ifOrphan === true),
        );
        return retracted.match(
            (outcome) => (outcome === null ? threadNotFound(c) : c.json<RetractResponse>(outcome)),
            (e) => internalError(c, e, "retract the tail turn"),
        );
    });

    routes.get("/:analysisId/threads/:threadId/turns", (c) => {
        const { analysisId, threadId } = c.req.param();
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const turns = listThreadTurns(analysisId, threadId);
        const start = page.page * page.perPage;
        return c.json<TurnList>(listEnvelope("turns", turns.slice(start, start + page.perPage), turns.length, page));
    });

    routes.get("/:analysisId/threads/:threadId/turns/:turnId", (c) => {
        const { analysisId, threadId, turnId } = c.req.param();
        const turn = findTurn(turnId);
        if (turn === null || turn.analysisId !== analysisId || turn.threadId !== threadId) return turnNotFound(c);
        return c.json(turn);
    });

    routes.post("/:analysisId/threads/:threadId/turns/:turnId/abort", (c) => {
        const { analysisId, threadId, turnId } = c.req.param();
        const turn = findTurn(turnId);
        if (turn === null || turn.analysisId !== analysisId || turn.threadId !== threadId) return turnNotFound(c);
        const outcome = abortTurn(turnId);
        // The registry dropped the turn between the read and the abort, thus the turn ended.
        return c.json<AbortTurnResponse>({ turnId, outcome: outcome ?? "already_ended" });
    });

    routes.post("/:analysisId/chat", runtime, async (c) => {
        const analysisId = c.req.param("analysisId");
        const body = await readBody(c, chatBody);
        if (body.isErr()) return body.error;
        return startChatTurn(c, analysisId, body.value.threadId, body.value.message, opts);
    });

    routes.get("/:analysisId/asks", runtime, async (c) => {
        const analysisId = c.req.param("analysisId");
        const page = parsePage(c.req.query("page"), c.req.query("perPage"));
        const pending = await ResultAsync.fromPromise(c.get("runtime").askGateway.pending(), (cause) => cause);
        return pending.match(
            (asks) => {
                // The gateway gives each pending ask of the ledger. The set is small, because each pending ask
                // holds a turn open, thus the filter runs here, as in Cortex.
                const ofAnalysis = asks.filter((ask) => ask.analysisId === analysisId);
                const start = page.page * page.perPage;
                return c.json<AskList>(listEnvelope("asks", ofAnalysis.slice(start, start + page.perPage), ofAnalysis.length, page));
            },
            (cause) => internalError(c, cause, "list the pending asks"),
        );
    });

    routes.post("/:analysisId/asks/:askId/answer", runtime, async (c) => {
        const { analysisId, askId } = c.req.param();
        const body = await readBody(c, askReplyBody);
        if (body.isErr()) return body.error;
        const gateway = c.get("runtime").askGateway;
        const answered = await ResultAsync.fromPromise(gateway.pending(), (cause) => cause).andThen((pending) => {
            // An ask of a different analysis is absent for this one. A terminal ask is not in the pending set,
            // thus the gateway answers it with its own outcome.
            const scoped = pending.find((ask) => ask.id === askId);
            if (scoped !== undefined && scoped.analysisId !== analysisId)
                return ResultAsync.fromSafePromise<"not_found", unknown>(Promise.resolve("not_found"));
            return ResultAsync.fromPromise(gateway.answer(askId, body.value), (cause) => cause);
        });
        return answered.match(
            (outcome) => {
                switch (outcome) {
                    case "applied":
                        return c.json<AnswerAskResponse>({ applied: true });
                    case "not_found":
                        return apiError(c, "not_found", "Ask not found.");
                    case "already_terminal":
                        return apiError(c, "conflict", "The ask is already answered.");
                    default: {
                        const exhaustive: never = outcome;
                        throw new Error(`unhandled answer outcome: ${JSON.stringify(exhaustive)}`);
                    }
                }
            },
            (cause) => internalError(c, cause, "answer an ask"),
        );
    });

    return routes;
}

/**
 * Run one chat turn and stream its frames (draft 2.3). The turn runs apart from the request: a client that
 * disconnects stops the delivery of the frames, never the turn, and the end of the turn always reaches the
 * registry.
 *
 * The headers go out when the turn is open, before the first frame. A refusal comes before that moment, thus
 * it is still a JSON error: 404 for a thread of a different analysis, 500 for `prepare_failed` and
 * `agent_unresolved`, as in Cortex. Cortex waits for the first frame instead. That wait would hide the turn id
 * from the sender until the model answers, thus an abort in that window would have no id, and a silent wait
 * longer than 10 s meets the idle timeout of `Bun.serve`. After the headers, the `: ping` of the stream covers
 * a silent model.
 */
async function startChatTurn(c: Context<ServerEnv>, analysisId: string, threadId: string, message: string, opts: ConversationRouteOpts): Promise<Response> {
    // No `await` between this test and `startTurn`, thus a stop that starts after the test waits for this turn.
    if (newTurnsRefused())
        return apiError(c, "draining", "The Inflexa server is stopping and starts no new chat turn. Send the message again after it starts again.");
    const runtime = c.get("runtime");
    const turnId = randomUUIDv7();
    const signal = startTurn({ turnId, threadId, analysisId }, new Date());
    const queue = createFrameQueue();
    let markOpened: () => void = () => undefined;
    const opened = new Promise<null>((resolve) => {
        markOpened = () => resolve(null);
    });

    const settled = opts
        .runTurn({
            pool: runtime.pool,
            agents: runtime.agents,
            chat: (emit) => createStreamingChat(runtime.conversation.provider, (text) => void emit({ type: "text-delta", text })),
            session: buildChatSession(analysisId, threadId),
            emit: (event) => {
                const frame = toChatFrame(event, ROOT_SOURCE);
                if (frame === null) return;
                // In-process `emit` shares mutable references with the agent loop, and a frame waits in the
                // queue until the writer serializes it. Thus the queue keeps a copy taken now.
                cloneFrame(frame).match(
                    (copy) => queue.push(copy),
                    (cause) => getLogger("server").warn({ err: cause, type: frame.type }, "a chat frame was dropped: it could not be copied"),
                );
            },
            signal,
            usageRecorder: runtime.usageRecorder,
            ask: (request, emit) => runtime.askGateway.ask(request, { analysisId, userId: LOCAL_ASK_USER_ID, threadId, signal, emit }),
            analysisId,
            threadId,
            userInput: message,
            onOpened: () => markOpened(),
        })
        // The engine gives each failure as an outcome. A throw past it gives no sign that the opening landed.
        .catch((cause: unknown): TurnOutcome => ({ kind: "failed", opened: false, cause }));

    const early = await Promise.race([opened, settled]);
    if (early !== null) {
        const refusal = refusalOf(c, early);
        if (refusal !== null) {
            forgetTurn(turnId);
            return refusal;
        }
    }

    void settled.then((outcome) => closeTurn(turnId, outcome, queue, opts));
    return sseResponse(
        async (writer) => {
            writer.signal.addEventListener("abort", () => queue.stop(), { once: true });
            for (let frame = await queue.next(); frame !== null; frame = await queue.next()) writer.send(frame);
        },
        { ...opts.sse, headers: { ...opts.sse.headers, [TURN_ID_HEADER]: turnId } },
    );
}

/** The JSON refusal of a turn that ended before it opened, or `null` for a turn that ran. */
function refusalOf(c: Context<ServerEnv>, outcome: TurnOutcome): Response | null {
    switch (outcome.kind) {
        case "prepare_failed":
            return internalError(c, outcome.cause, "prepare the chat turn");
        case "thread_gone":
            return threadNotFound(c);
        case "agent_unresolved":
            return apiError(c, "internal_error", `No agent is registered for "${outcome.threadType}" threads in this build.`);
        case "ok":
        case "filtered":
        case "aborted":
        case "failed":
            return null;
        default: {
            const exhaustive: never = outcome;
            throw new Error(`unhandled turn outcome: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * End a turn that ran: record its summary in the registry, send its one terminal frame, close the stream,
 * and start the sweep of the package adds that the turn queued. A failure of this tail goes to the log only,
 * because no client waits on a reply from it.
 */
async function closeTurn(turnId: string, outcome: TurnOutcome, queue: FrameQueue, opts: ConversationRouteOpts): Promise<void> {
    const end = await ResultAsync.fromPromise(endingOf(outcome, opts), (cause) => cause);
    end.match(
        ({ ending, frame }) => {
            endTurn(turnId, ending, new Date());
            queue.push(frame);
        },
        (cause) => {
            getLogger("server").error({ err: cause, turnId }, "could not record the end of a chat turn");
            endTurn(turnId, { status: "failed", failure: { message: "The server failed to record the end of the turn.", detailLines: [] } }, new Date());
            queue.push({ type: "error", message: "The server failed to record the end of the turn.", source: ROOT_SOURCE });
        },
    );
    queue.close();
    // Each approved `store add` of the turn only queued its package. The sweep covers what the 10 s timer did
    // not take yet, thus no approved add outlives its turn unflushed. An empty queue starts nothing.
    opts.flushPendingAdds();
}

/** The summary fields and the terminal frame of a turn that ran. Cortex sends `finish` for `done` and `aborted`, and `error` for `failed`. */
async function endingOf(outcome: TurnOutcome, opts: ConversationRouteOpts): Promise<{ ending: TurnEnding; frame: ChatFrame }> {
    switch (outcome.kind) {
        case "ok":
            return {
                ending: {
                    status: "done",
                    opened: outcome.opened,
                    ...(outcome.fallbackText === "" ? {} : { fallbackText: outcome.fallbackText }),
                    ...spendOf(outcome),
                },
                frame: finishFrame(outcome),
            };
        case "filtered": {
            // The endpoint's own word is the one detail of a refusal, thus the details view shows it.
            const cause = {
                type: "content_filter",
                ...(outcome.rawFinishReason === undefined ? {} : { rawFinishReason: outcome.rawFinishReason }),
                message: "The model declined this request and stopped the turn.",
            };
            return {
                ending: {
                    status: "filtered",
                    opened: outcome.opened,
                    ...(outcome.fallbackText === "" ? {} : { fallbackText: outcome.fallbackText }),
                    ...spendOf(outcome),
                    failure: { message: cause.message, reason: "content_filter", detailLines: causeDetailLines(cause) },
                },
                frame: finishFrame(outcome),
            };
        }
        case "aborted":
            return { ending: { status: "aborted", opened: outcome.opened, ...spendOf(outcome) }, frame: finishFrame(outcome) };
        case "failed": {
            const failure = await failureOf(outcome.cause, opts);
            return {
                ending: { status: "failed", opened: outcome.opened, ...spendOf(outcome), failure },
                frame: { type: "error", message: failure.message, source: ROOT_SOURCE },
            };
        }
        case "prepare_failed":
        case "thread_gone":
        case "agent_unresolved":
            // A refusal that arrives after the turn opened is not possible, because `openChatTurn` gives each
            // refusal before `onOpened`. A fake turn of a test can still give one, thus it ends as a failure.
            return {
                ending: { status: "failed", opened: false, failure: { message: `The turn did not start (${outcome.kind}).`, detailLines: [] } },
                frame: { type: "error", message: `The turn did not start (${outcome.kind}).`, source: ROOT_SOURCE },
            };
        default: {
            const exhaustive: never = outcome;
            throw new Error(`unhandled turn outcome: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** The usage and the store fault of a turn that ran. An absent rollup leaves no key. */
function spendOf(outcome: Extract<TurnOutcome, { opened: boolean }>): Pick<TurnEnding, "turnUsage" | "storeFailed"> {
    return {
        ...(outcome.turnUsage === undefined ? {} : { turnUsage: { ...outcome.turnUsage } }),
        ...(outcome.appendError === undefined ? {} : { storeFailed: true }),
    };
}

function finishFrame(outcome: Extract<TurnOutcome, { opened: boolean }>): ChatFrame {
    return { type: "finish", source: ROOT_SOURCE, ...(outcome.turnUsage === undefined ? {} : { turnUsage: { ...outcome.turnUsage } }) };
}

/**
 * The failure of a turn, with the remedy when the server knows one. A refused credential has a remedy of its
 * own. A different failure in `cliproxy` mode asks the proxy for its credential state, because a dead login
 * and a rate limit both reach the harness as a retryable provider error, and only the proxy can tell them
 * apart. The read has its own timeout, thus it delays the end of the turn for a bounded time.
 */
async function failureOf(cause: unknown, opts: ConversationRouteOpts): Promise<TurnFailure> {
    const connection = opts.connection();
    const detailLines = causeDetailLines(cause);
    if (findAuthCause(cause) !== null) {
        if (connection.mode === "direct") {
            return {
                // The server reads the key from its own environment at its boot, thus only a new server sees a new key.
                message: `The ${connection.provider} endpoint rejected your API key — check ${MODEL_API_KEY_VAR}, then run \`inflexa server stop\`. The next \`inflexa\` command starts the server with the new key.`,
                detailLines,
                auth: { provider: connection.provider, envVar: MODEL_API_KEY_VAR },
            };
        }
        return { message: deadLoginMessage(connection.provider), detailLines, auth: { provider: connection.provider } };
    }
    const generic: TurnFailure = { message: `The turn failed: ${describeCause(cause)}`, detailLines };
    if (connection.mode !== "cliproxy") return generic;
    const verdict = await opts.readCredentialVerdict();
    if (verdict.isErr()) {
        getLogger("server").debug({ reason: verdict.error.type }, "credential state unavailable");
        return generic;
    }
    const credential: CredentialVerdictView =
        verdict.value.kind === "rate_limited" ? { kind: "rate_limited", retryAt: verdict.value.retryAt.toISOString() } : { kind: verdict.value.kind };
    switch (verdict.value.kind) {
        case "login_dead":
            return { ...generic, message: deadLoginMessage(connection.provider), credential };
        case "rate_limited":
            return {
                ...generic,
                message: `${connection.provider} is rate-limiting this account — the proxy retries after ${verdict.value.retryAt.toLocaleTimeString()}. Try again then.`,
                credential,
            };
        case "unknown":
            return { ...generic, credential };
        default: {
            const exhaustive: never = verdict.value;
            throw new Error(`unhandled CredentialVerdict: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** The `cliproxy` remedy for a dead login: `inflexa up` signs in again and restarts the proxy, thus the server needs no restart. */
function deadLoginMessage(provider: string): string {
    const kind = providerKindForSlug(provider);
    const relogin = kind ? ` (or \`inflexa setup --provider ${kind}\`)` : "";
    return `Your ${provider} login has expired or been revoked — run \`inflexa up\` in a terminal to sign in again${relogin}.`;
}

/** The frames of one turn, from the emit sink of the turn to the SSE writer of its response. */
type FrameQueue = {
    push(frame: ChatFrame): void;
    /** The turn ended: the reader gets each frame that waits, then the end. */
    close(): void;
    /** The client left: the queue drops each frame that waits and each later one, thus it holds no memory. */
    stop(): void;
    /** The next frame, or `null` at the end. */
    next(): Promise<ChatFrame | null>;
};

function createFrameQueue(): FrameQueue {
    const buffer: ChatFrame[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const notify = (): void => {
        const waiter = wake;
        wake = null;
        waiter?.();
    };
    return {
        push(frame) {
            if (ended) return;
            buffer.push(frame);
            notify();
        },
        close() {
            ended = true;
            notify();
        },
        stop() {
            ended = true;
            buffer.length = 0;
            notify();
        },
        async next() {
            for (;;) {
                const frame = buffer.shift();
                if (frame !== undefined) return frame;
                if (ended) return null;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        },
    };
}

/** `structuredClone` throws only for a value that no JSON holds, for example a function. `unknown`: a throw carries anything. */
const cloneFrame = Result.fromThrowable(
    (frame: ChatFrame): ChatFrame => structuredClone(frame),
    (cause): unknown => cause,
);

/** The live thread of the analysis, or `null` when it is absent, archived, or of a different analysis. */
function liveThreadOf(store: ThreadStore, analysisId: string, threadId: string): ResultAsync<Thread | null, DbError> {
    return store.getThread(threadId).map((thread) => (thread !== null && thread.analysisId === analysisId ? thread : null));
}

function threadNotFound(c: Context<ServerEnv>): Response {
    return apiError(c, "not_found", "Thread not found.");
}

function turnNotFound(c: Context<ServerEnv>): Response {
    return apiError(c, "not_found", "Turn not found. The server keeps the newest ended turns only.");
}

/** A thread on the wire. An absent value omits its key, as the Cortex `ThreadPayload` does. */
export function toThreadSummary(thread: Thread): ThreadSummary {
    return {
        id: thread.threadId,
        ...(thread.title === null ? {} : { title: thread.title }),
        resourceId: thread.analysisId,
        threadType: thread.threadType,
        ...(thread.parentThreadId === null ? {} : { parentThreadId: thread.parentThreadId }),
        ...(thread.parentSeq === null ? {} : { parentSeq: thread.parentSeq }),
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
        ...(thread.deletedAt === null ? {} : { archivedAt: thread.deletedAt.toISOString() }),
    };
}

/** The analysis of a thread by its primary key. The thread store reads a live row only, and a restore names an archived one. */
function threadAnalysisId(pool: Pool, threadId: string): ResultAsync<string | null, DbError> {
    return ResultAsync.fromPromise(
        pool.query<{ analysis_id: string }>("SELECT analysis_id FROM cortex_analysis_threads WHERE thread_id = $1", [threadId]),
        (cause): DbError => ({ type: "query_failed", op: "conversation.threadAnalysisId", cause }),
    ).map(({ rows }) => rows[0]?.analysis_id ?? null);
}

/** The workspace root of the analysis on disk. A missing analysis row or a failed read cannot name the tree. */
function workspaceRoot(analysisId: string): WorkspaceRootLookup {
    const analysis = findAnalysesByRef(analysisId)
        .map((found) => found.find((candidate) => candidate.id === analysisId) ?? null)
        .unwrapOr(null);
    if (analysis === null) return { kind: "unlocatable" };
    return locateExistingOutputDir(analysis).match(
        (dir): WorkspaceRootLookup => (dir === null ? { kind: "absent" } : { kind: "root", root: dir }),
        (): WorkspaceRootLookup => ({ kind: "unlocatable" }),
    );
}

/**
 * Remove the report page folder of each erased thread, and report what is still on disk. The removal is
 * forced, thus a thread that owns no page costs one call and reports success.
 */
async function reclaimReportPages(
    analysisId: string,
    erased: readonly string[],
    files: "keep" | "remove",
    opts: ConversationRouteOpts,
): Promise<ReportPageFate> {
    if (files === "keep") return { kind: "kept" };
    const lookup = opts.workspaceRoot(analysisId);
    if (lookup.kind === "absent") return { kind: "removed" };
    if (lookup.kind === "unlocatable") return { kind: "unlocatable" };
    const stayed: string[] = [];
    let unnamed = false;
    for (const threadId of erased) {
        // `reportSessionDir` throws for an id that is not one safe path segment. Each id comes from the purge,
        // which mints its own, thus this guards a future miswire only. Such a page stays, with no name.
        const dir = Result.fromThrowable(
            () => join(lookup.root, reportSessionDir(threadId)),
            () => null,
        )().unwrapOr(null);
        if (dir === null) {
            unnamed = true;
            continue;
        }
        if ((await opts.removeDir(dir)).isErr()) stayed.push(dir);
    }
    if (stayed.length === 0 && !unnamed) return { kind: "removed" };
    return { kind: "stayed", dirs: stayed };
}
