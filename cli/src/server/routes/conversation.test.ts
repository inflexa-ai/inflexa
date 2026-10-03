import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { err, errAsync, ok, okAsync, type ResultAsync } from "neverthrow";
import type { AnswerOutcome, AskGateway, AskReply, ChatFrame, DbError, PendingAsk, StoredMessage, Thread, ThreadPage, ThreadStore } from "@inflexa-ai/harness";

import type { ServerState } from "../../api/server.ts";
import {
    TURN_ID_HEADER,
    type AskList,
    type MessageList,
    type PurgedThread,
    type ThreadList,
    type ThreadSummary,
    type TurnList,
    type TurnSummary,
} from "../../api/conversation.ts";
import { readSseFrames } from "../../client/api.ts";
import type { RunChatTurnArgs } from "../../modules/harness/turn.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { conversationThread, FIXTURE_ANALYSIS_ID, reportThread } from "../../test_support/threads.ts";
import { idleBoot } from "../../test_support/server.ts";
import type { ServerBoot } from "../boot.ts";
import { __resetTurnsForTest, hasRunningTurn, refuseNewTurns } from "../turns.ts";
import { conversationRoutes, DEFAULT_CONVERSATION_ROUTE_OPTS, type ConversationRouteOpts } from "./conversation.ts";

// The routes alone, with no app and no bearer check: `app.test.ts` covers those. No cli test reaches Postgres
// or a model, thus each store and the chat turn are fakes that the options inject. Each `as` cast of a body
// below reads JSON that the route under test builds from the same `src/api/` type.

const A = FIXTURE_ANALYSIS_ID;
/** The answer of a store method that no route calls. */
const UNUSED: DbError = { type: "query_failed", op: "test.unused", cause: "no route calls this method" };
const T = "thread-conversation";

/** A thread store over rows in memory: the subset of the harness store that the routes call. */
function memoryStore(rows: Thread[]): ThreadStore & { listed: unknown[]; purged: string[] } {
    const listed: unknown[] = [];
    const purged: string[] = [];
    const live = (id: string): Thread | undefined => rows.find((r) => r.threadId === id && r.deletedAt === null);
    const store: ThreadStore = {
        createThread: () => errAsync(UNUSED),
        setAutoTitle: () => errAsync(UNUSED),
        getThread: (id) => okAsync(live(id) ?? null),
        updateTitle: (id, title) => {
            const row = live(id);
            if (row === undefined) return okAsync(null);
            const renamed = { ...row, title };
            rows.splice(rows.indexOf(row), 1, renamed);
            return okAsync(renamed);
        },
        archiveThread: (id) => {
            const row = live(id);
            if (row !== undefined) rows.splice(rows.indexOf(row), 1, { ...row, deletedAt: new Date("2026-07-09T00:00:00.000Z") });
            return okAsync(undefined);
        },
        unarchiveThread: (id) => {
            const row = rows.find((r) => r.threadId === id);
            if (row !== undefined) rows.splice(rows.indexOf(row), 1, { ...row, deletedAt: null });
            return okAsync(undefined);
        },
        purgeThread: (id) => {
            purged.push(id);
            const erased = rows.filter((r) => r.threadId === id || r.parentThreadId === id).map((r) => r.threadId);
            return okAsync(erased);
        },
        listThreads: (input) => {
            listed.push(input);
            const threads = rows.filter((r) => r.analysisId === input.analysisId && (input.includeArchived === true || r.deletedAt === null));
            const page: ThreadPage = { threads, total: threads.length, page: input.page ?? 0, perPage: input.perPage ?? 100, hasMore: false };
            return okAsync(page);
        },
    };
    return Object.assign(store, { listed, purged });
}

/** An ask gateway over a fixed pending set, which records each answer. */
function fakeGateway(pending: PendingAsk[], outcome: AnswerOutcome = "applied"): AskGateway & { answers: { id: string; reply: AskReply }[] } {
    const answers: { id: string; reply: AskReply }[] = [];
    return {
        answers,
        ask: () => Promise.reject(new Error("the routes never ask")),
        answer: (id, reply) => {
            answers.push({ id, reply });
            return Promise.resolve(outcome);
        },
        pending: () => Promise.resolve(pending),
        sweepExpired: () => Promise.resolve(0),
    };
}

/** A boot whose runtime is ready. The routes read the pool, the agents, the provider, the recorder, and the gateway of the runtime, and each fake below ignores the pool. */
function readyBoot(gateway: AskGateway = fakeGateway([])): ServerBoot {
    // The cast is sound for the reason above: no route under test reads another field of the runtime.
    const runtime = {
        pool: {},
        agents: {},
        conversation: { provider: {}, model: "m" },
        usageRecorder: { record: () => okAsync(undefined) },
        askGateway: gateway,
    } as unknown as HarnessRuntime;
    const state: ServerState = {
        version: "0.0.0-test",
        apiVersion: 1,
        startedAt: new Date().toISOString(),
        phase: "ready",
        connection: { provider: "anthropic", mode: "cliproxy", model: "m" },
    };
    return { state: () => state, runtime: () => runtime, start: async () => undefined };
}

type Options = Partial<ConversationRouteOpts> & { store?: ThreadStore; boot?: ServerBoot };

function routesWith(o: Options = {}): ReturnType<typeof conversationRoutes> {
    const store = o.store ?? memoryStore([conversationThread()]);
    return conversationRoutes(o.boot ?? readyBoot(), {
        ...DEFAULT_CONVERSATION_ROUTE_OPTS,
        threads: () => store,
        loadTurns: () => okAsync([]),
        retract: () => okAsync({ kind: "retracted", messages: 2 }),
        threadAnalysisId: (_pool, id) => okAsync(id === T ? A : null),
        runTurn: () => Promise.resolve({ kind: "ok", opened: true, fallbackText: "" }),
        connection: () => ({ provider: "anthropic", mode: "direct" }),
        readCredentialVerdict: () => Promise.resolve(err({ type: "no_key" })),
        flushPendingAdds: () => undefined,
        workspaceRoot: () => ({ kind: "absent" }),
        removeDir: () => true,
        sse: { pingMs: 60_000, headers: {} },
        ...o,
    });
}

function json(method: string, body: unknown): RequestInit {
    return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** Each frame of an SSE response, until the stream closes. */
async function framesOf(response: Response): Promise<ChatFrame[]> {
    const frames: ChatFrame[] = [];
    // `sseResponse` always gives a stream body.
    for await (const item of readSseFrames<ChatFrame>(response.body!, "http://test")) frames.push(item._unsafeUnwrap());
    return frames;
}

/** A gate that a fake turn awaits, and that the test opens. */
function gate(): { wait: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { wait, open };
}

beforeEach(() => {
    __resetTurnsForTest();
});

afterEach(() => {
    __resetTurnsForTest();
});

describe("the thread routes", () => {
    test("GET {A}/threads gives the envelope of thread summaries, and passes the filters to the store", async () => {
        const store = memoryStore([conversationThread({ title: null }), reportThread({ deletedAt: new Date("2026-07-09T00:00:00.000Z") })]);
        const response = await routesWith({ store }).request(`/${A}/threads?type=conversation&parentThreadId=p1&includeArchived=true&perPage=5`);
        expect(response.status).toBe(200);
        const list = (await response.json()) as ThreadList;
        expect(list).toMatchObject({ total: 2, page: 0, perPage: 5, hasMore: false });
        const [conversation, report] = list.threads as [ThreadSummary, ThreadSummary];
        // An absent title omits its key, as the Cortex payload does.
        expect(conversation).toEqual({
            id: T,
            resourceId: A,
            threadType: "conversation",
            createdAt: "2026-07-08T00:00:00.000Z",
            updatedAt: "2026-07-08T01:00:00.000Z",
        });
        expect(report).toMatchObject({ id: "thread-report", parentThreadId: T, parentSeq: 2, archivedAt: "2026-07-09T00:00:00.000Z" });
        expect(store.listed).toEqual([{ analysisId: A, page: 0, perPage: 5, includeArchived: true, type: "conversation", parentThreadId: "p1" }]);
    });

    test("GET {A}/threads refuses a type outside the closed set with 400 `validation_error`", async () => {
        const response = await routesWith().request(`/${A}/threads?type=draft`);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error", details: { fieldErrors: { type: expect.any(Array) } } });
    });

    test("GET {T} gives the live thread, and 404 for a thread of a different analysis or with no row", async () => {
        const routes = routesWith();
        expect(((await (await routes.request(`/${A}/threads/${T}`)).json()) as ThreadSummary).title).toBe("Cohort survival questions");
        for (const path of [`/other/threads/${T}`, `/${A}/threads/missing`]) {
            const response = await routes.request(path);
            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({ error: "not_found", message: "Thread not found." });
        }
    });

    test("PATCH {T} trims the title, refuses a blank one, and gives 404 for a thread that is gone", async () => {
        const routes = routesWith();
        const renamed = await routes.request(`/${A}/threads/${T}`, json("PATCH", { title: "  New name " }));
        expect(renamed.status).toBe(200);
        expect(((await renamed.json()) as ThreadSummary).title).toBe("New name");

        const blank = await routes.request(`/${A}/threads/${T}`, json("PATCH", { title: "   " }));
        expect(blank.status).toBe(400);
        expect(await blank.json()).toMatchObject({ error: "validation_error" });

        expect((await routes.request(`/${A}/threads/missing`, json("PATCH", { title: "x" }))).status).toBe(404);
    });

    test("DELETE {T} archives the thread; it then reads as absent until POST {T}/restore brings it back", async () => {
        const routes = routesWith();
        const deleted = await routes.request(`/${A}/threads/${T}`, { method: "DELETE" });
        expect(await deleted.json()).toEqual({ deleted: true });
        expect((await routes.request(`/${A}/threads/${T}`)).status).toBe(404);
        expect((await routes.request(`/${A}/threads/${T}`, { method: "DELETE" })).status).toBe(404);

        const restored = await routes.request(`/${A}/threads/${T}/restore`, { method: "POST" });
        expect(restored.status).toBe(200);
        expect(((await restored.json()) as ThreadSummary).id).toBe(T);
        expect((await routes.request(`/${A}/threads/${T}`)).status).toBe(200);
    });

    test("POST {T}/restore gives 404 for a thread of a different analysis", async () => {
        const response = await routesWith().request(`/other/threads/${T}/restore`, { method: "POST" });
        expect(response.status).toBe(404);
    });

    test("POST {T}/purge erases the subtree and keeps the page folders when asked", async () => {
        const store = memoryStore([conversationThread(), reportThread()]);
        const removed: string[] = [];
        const routes = routesWith({ store, removeDir: (dir) => removed.push(dir) > 0 });
        const response = await routes.request(`/${A}/threads/${T}/purge`, json("POST", { files: "keep" }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ purged: [T, "thread-report"], pages: { kind: "kept" } });
        expect(store.purged).toEqual([T]);
        expect(removed).toEqual([]);
    });

    test("POST {T}/purge removes the page folder of each erased thread, and names each folder that stayed", async () => {
        const store = memoryStore([conversationThread(), reportThread()]);
        const routes = routesWith({ store, workspaceRoot: () => ({ kind: "root", root: "/ws" }), removeDir: (dir) => !dir.endsWith("thread-report") });
        const body = (await (await routes.request(`/${A}/threads/${T}/purge`, json("POST", { files: "remove" }))).json()) as PurgedThread;
        expect(body.pages).toEqual({ kind: "stayed", dirs: [join("/ws", "report-sessions", "thread-report")] });
    });

    test("POST {T}/purge reports a workspace that does not resolve, and refuses a body with no `files`", async () => {
        const unlocatable = routesWith({ workspaceRoot: () => ({ kind: "unlocatable" }) });
        const body = (await (await unlocatable.request(`/${A}/threads/${T}/purge`, json("POST", { files: "remove" }))).json()) as PurgedThread;
        expect(body.pages).toEqual({ kind: "unlocatable" });
        expect((await routesWith().request(`/${A}/threads/${T}/purge`, json("POST", {}))).status).toBe(400);
    });

    test("GET {T}/messages gives the whole transcript, with `total` the count of turns, and 404 for a thread with no row", async () => {
        const turn: StoredMessage[] = [];
        const routes = routesWith({ loadTurns: () => okAsync([turn, turn]) });
        const list = (await (await routes.request(`/${A}/threads/${T}/messages`)).json()) as MessageList;
        expect(list).toEqual({ messages: [], total: 2, page: 0, perPage: 2, hasMore: false });
        expect((await routes.request(`/${A}/threads/missing/messages`)).status).toBe(404);
    });

    test("GET {T}/messages gives 500 `internal_error` when the read fails", async () => {
        const failed: DbError = { type: "query_failed", op: "test", cause: new Error("db down") };
        const routes = routesWith({ loadTurns: () => okAsync([]).andThen(() => err(failed)) as ResultAsync<StoredMessage[][], DbError> });
        const response = await routes.request(`/${A}/threads/${T}/messages`);
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: "internal_error" });
    });

    test("POST {T}/retract passes `ifOrphan` to the store and gives its outcome", async () => {
        const calls: boolean[] = [];
        const routes = routesWith({
            retract: (_pool, _id, ifOrphan) => {
                calls.push(ifOrphan);
                return okAsync(ifOrphan ? { kind: "not-orphaned" } : { kind: "retracted", messages: 3 });
            },
        });
        expect(await (await routes.request(`/${A}/threads/${T}/retract`, json("POST", {}))).json()).toEqual({ kind: "retracted", messages: 3 });
        expect(await (await routes.request(`/${A}/threads/${T}/retract`, json("POST", { ifOrphan: true }))).json()).toEqual({ kind: "not-orphaned" });
        expect(calls).toEqual([false, true]);
        expect((await routes.request(`/${A}/threads/missing/retract`, json("POST", {}))).status).toBe(404);
    });

    test("a thread route gives 503 `unavailable` until the runtime is ready", async () => {
        const response = await routesWith({ boot: idleBoot() }).request(`/${A}/threads`);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "unavailable", details: { phase: "starting" } });
    });
});

describe("POST {A}/chat", () => {
    test("a server that stops refuses a new turn with 503 `draining`, and starts no turn", async () => {
        let turns = 0;
        const routes = routesWith({
            runTurn: () => {
                turns++;
                return Promise.resolve({ kind: "ok", opened: true, fallbackText: "" });
            },
        });
        refuseNewTurns();
        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: "draining" });
        expect(turns).toBe(0);
        expect(hasRunningTurn(A)).toBe(false);
    });

    test("streams the frames of the turn under the turn id, ends with one `finish`, and records the summary", async () => {
        let flushed = 0;
        const routes = routesWith({
            flushPendingAdds: () => void flushed++,
            runTurn: async (args) => {
                args.onOpened?.();
                await args.emit({ type: "text-delta", text: "Hello" });
                await args.emit({ type: "iteration", source: { agentId: "chat", callPath: ["chat"] }, index: 0, final: true } as Parameters<
                    RunChatTurnArgs["emit"]
                >[0]);
                return { kind: "ok", opened: true, fallbackText: "Hello", turnUsage: { inputTokens: 10, outputTokens: 2 } };
            },
        });
        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("text/event-stream");
        const turnId = response.headers.get(TURN_ID_HEADER);
        expect(turnId).not.toBeNull();

        // `iteration` gives no frame, as `toChatFrame` decides.
        expect(await framesOf(response)).toEqual([
            { type: "text-delta", text: "Hello", source: { agentId: "chat", callPath: ["chat"] } },
            { type: "finish", source: { agentId: "chat", callPath: ["chat"] }, turnUsage: { inputTokens: 10, outputTokens: 2 } },
        ]);
        const summary = (await (await routes.request(`/${A}/threads/${T}/turns/${turnId}`)).json()) as TurnSummary;
        expect(summary).toMatchObject({ turnId, threadId: T, analysisId: A, status: "done", opened: true, fallbackText: "Hello" });
        expect(summary.durationMs).toBeGreaterThanOrEqual(0);
        expect(flushed).toBe(1);
        expect(hasRunningTurn(A)).toBe(false);
    });

    test("gives the turn the recorder of the runtime, the session of the thread, and an ask binding", async () => {
        let seen: RunChatTurnArgs | null = null;
        const boot = readyBoot();
        const routes = routesWith({
            boot,
            runTurn: (args) => {
                seen = args;
                args.onOpened?.();
                return Promise.resolve({ kind: "ok", opened: true, fallbackText: "" });
            },
        });
        await framesOf(await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hello" })));
        // Without the recorder of the runtime, the calls of the conversation agent never reach the ledger.
        const args = seen as RunChatTurnArgs | null;
        expect(args?.usageRecorder).toBe(boot.runtime()!.usageRecorder);
        expect(args?.session.scope).toEqual({ kind: "analysis", analysisId: A, threadId: T });
        expect(args).toMatchObject({ analysisId: A, threadId: T, userInput: "hello" });
        expect(typeof args?.ask).toBe("function");
    });

    test("keeps the frames of a sub-agent, with their source", async () => {
        const routes = routesWith({
            runTurn: async (args) => {
                args.onOpened?.();
                await args.emit({
                    type: "tool-started",
                    source: { agentId: "planner", callPath: ["chat", "planner"] },
                    toolUseId: "u1",
                    name: "bash",
                    input: {},
                });
                return { kind: "ok", opened: true, fallbackText: "" };
            },
        });
        const frames = await framesOf(await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" })));
        expect(frames[0]).toEqual({ type: "tool-started", toolUseId: "u1", name: "bash", source: { agentId: "planner", callPath: ["chat", "planner"] } });
    });

    test("a refusal before the turn opens is JSON: 404 for a thread of a different analysis, and the registry forgets the turn", async () => {
        const routes = routesWith({ runTurn: () => Promise.resolve({ kind: "thread_gone" }) });
        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        expect(response.status).toBe(404);
        expect(response.headers.get(TURN_ID_HEADER)).toBeNull();
        expect(await response.json()).toEqual({ error: "not_found", message: "Thread not found." });
        expect(((await (await routes.request(`/${A}/threads/${T}/turns`)).json()) as TurnList).turns).toEqual([]);
    });

    test("500 `internal_error` for a thread type with no agent, and for a turn that could not prepare", async () => {
        const unresolved = await routesWith({ runTurn: () => Promise.resolve({ kind: "agent_unresolved", threadType: "report" }) }).request(
            `/${A}/chat`,
            json("POST", { threadId: T, message: "hi" }),
        );
        expect(unresolved.status).toBe(500);
        expect(await unresolved.json()).toEqual({ error: "internal_error", message: 'No agent is registered for "report" threads in this build.' });

        const prepare = await routesWith({ runTurn: () => Promise.resolve({ kind: "prepare_failed", cause: new Error("pg down") }) }).request(
            `/${A}/chat`,
            json("POST", { threadId: T, message: "hi" }),
        );
        expect(prepare.status).toBe(500);
        expect(await prepare.json()).toEqual({ error: "internal_error", message: "The server failed to handle the request." });
    });

    test("400 `validation_error` for an empty message", async () => {
        const response = await routesWith().request(`/${A}/chat`, json("POST", { threadId: T, message: "" }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error" });
    });

    test("a failed turn ends with one `error` frame, and its summary carries the remedy and the detail lines", async () => {
        const authFailure = { type: "auth", retryable: false, message: "invalid x-api-key" };
        const routes = routesWith({
            runTurn: (args) => {
                args.onOpened?.();
                return Promise.resolve({ kind: "failed", opened: true, cause: authFailure });
            },
        });
        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        const turnId = response.headers.get(TURN_ID_HEADER);
        const message = "The anthropic endpoint rejected your API key — check INFLEXA_MODEL_API_KEY, then restart the server (`inflexa serve`).";
        expect(await framesOf(response)).toEqual([{ type: "error", message, source: { agentId: "chat", callPath: ["chat"] } }]);
        const summary = (await (await routes.request(`/${A}/threads/${T}/turns/${turnId}`)).json()) as TurnSummary;
        expect(summary.status).toBe("failed");
        expect(summary.failure).toMatchObject({ message, auth: { provider: "anthropic", envVar: "INFLEXA_MODEL_API_KEY" } });
        expect(summary.failure?.detailLines.length).toBeGreaterThan(0);
    });

    test("a failed `cliproxy` turn names a rate limit that the proxy reports", async () => {
        const routes = routesWith({
            connection: () => ({ provider: "anthropic", mode: "cliproxy" }),
            readCredentialVerdict: () => Promise.resolve(ok({ kind: "rate_limited", retryAt: new Date("2026-10-02T12:00:00.000Z") })),
            runTurn: (args) => {
                args.onOpened?.();
                return Promise.resolve({ kind: "failed", opened: true, cause: new Error("overloaded") });
            },
        });
        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        const turnId = response.headers.get(TURN_ID_HEADER);
        await framesOf(response);
        const summary = (await (await routes.request(`/${A}/threads/${T}/turns/${turnId}`)).json()) as TurnSummary;
        expect(summary.failure?.credential).toEqual({ kind: "rate_limited", retryAt: "2026-10-02T12:00:00.000Z" });
        expect(summary.failure?.message).toStartWith("anthropic is rate-limiting this account");
    });
});

describe("the turn registry routes", () => {
    test("POST {T}/turns/:turnId/abort stops the turn through its signal; the turn ends `aborted` with a `finish` frame", async () => {
        let sawAbort = false;
        const routes = routesWith({
            runTurn: async (args) => {
                args.onOpened?.();
                await new Promise<void>((resolve) => args.signal.addEventListener("abort", () => resolve(), { once: true }));
                sawAbort = args.signal.aborted;
                return { kind: "aborted", opened: true };
            },
        });
        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        const turnId = response.headers.get(TURN_ID_HEADER)!;

        const running = (await (await routes.request(`/${A}/threads/${T}/turns`)).json()) as TurnList;
        expect(running.turns.map((t) => [t.turnId, t.status])).toEqual([[turnId, "running"]]);
        expect(hasRunningTurn(A)).toBe(true);

        const aborted = await routes.request(`/${A}/threads/${T}/turns/${turnId}/abort`, { method: "POST" });
        expect(await aborted.json()).toEqual({ turnId, outcome: "aborting" });
        expect((await framesOf(response)).map((f) => f.type)).toEqual(["finish"]);
        expect(sawAbort).toBe(true);
        expect(((await (await routes.request(`/${A}/threads/${T}/turns/${turnId}`)).json()) as TurnSummary).status).toBe("aborted");

        const again = await routes.request(`/${A}/threads/${T}/turns/${turnId}/abort`, { method: "POST" });
        expect(await again.json()).toEqual({ turnId, outcome: "already_ended" });
    });

    test("a turn id that the registry does not hold, or of a different thread, gives 404", async () => {
        const routes = routesWith();
        expect((await routes.request(`/${A}/threads/${T}/turns/nope`)).status).toBe(404);
        expect((await routes.request(`/${A}/threads/${T}/turns/nope/abort`, { method: "POST" })).status).toBe(404);

        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        const turnId = response.headers.get(TURN_ID_HEADER)!;
        await framesOf(response);
        expect((await routes.request(`/${A}/threads/other/turns/${turnId}`)).status).toBe(404);
    });

    test("a client disconnect does not stop the turn: it runs to its end, and the registry records it", async () => {
        const proceed = gate();
        const finished = gate();
        let aborted = false;
        const routes = routesWith({
            flushPendingAdds: () => finished.open(),
            runTurn: async (args) => {
                args.onOpened?.();
                await args.emit({ type: "text-delta", text: "first" });
                await proceed.wait;
                aborted = args.signal.aborted;
                await args.emit({ type: "text-delta", text: "second" });
                return { kind: "ok", opened: true, fallbackText: "first second" };
            },
        });
        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        const turnId = response.headers.get(TURN_ID_HEADER)!;
        // The client reads the first frame, then leaves.
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel();

        proceed.open();
        await finished.wait;
        expect(aborted).toBe(false);
        const summary = (await (await routes.request(`/${A}/threads/${T}/turns/${turnId}`)).json()) as TurnSummary;
        expect(summary).toMatchObject({ status: "done", fallbackText: "first second" });
        expect(hasRunningTurn(A)).toBe(false);
    });

    test("the turn routes need no runtime: they read the registry of the process", async () => {
        const response = await routesWith({ boot: idleBoot() }).request(`/${A}/threads/${T}/turns`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ turns: [], total: 0, page: 0, perPage: 100, hasMore: false });
    });
});

describe("the ask routes", () => {
    const ask = (id: string, analysisId: string): PendingAsk => ({
        id,
        analysisId,
        userId: "local",
        threadId: T,
        title: "Run a command",
        command: "rm -rf scratch",
        detail: null,
        createdAt: "2026-10-02T10:00:00.000Z",
    });

    test("GET {A}/asks gives the pending asks of the analysis alone", async () => {
        const routes = routesWith({ boot: readyBoot(fakeGateway([ask("k1", A), ask("k2", "other")])) });
        const list = (await (await routes.request(`/${A}/asks`)).json()) as AskList;
        expect(list.asks.map((a) => a.id)).toEqual(["k1"]);
        expect(list.total).toBe(1);
    });

    test("POST {A}/asks/:askId/answer applies the reply", async () => {
        const gateway = fakeGateway([ask("k1", A)]);
        const response = await routesWith({ boot: readyBoot(gateway) }).request(`/${A}/asks/k1/answer`, json("POST", { kind: "reject", feedback: "not now" }));
        expect(await response.json()).toEqual({ applied: true });
        expect(gateway.answers).toEqual([{ id: "k1", reply: { kind: "reject", feedback: "not now" } }]);
    });

    test("an answered ask gives 409 `conflict`, an unknown or foreign ask gives 404, and a bad reply gives 400", async () => {
        const terminal = await routesWith({ boot: readyBoot(fakeGateway([], "already_terminal")) }).request(
            `/${A}/asks/k1/answer`,
            json("POST", { kind: "once" }),
        );
        expect(terminal.status).toBe(409);
        expect(await terminal.json()).toEqual({ error: "conflict", message: "The ask is already answered." });

        const unknown = await routesWith({ boot: readyBoot(fakeGateway([], "not_found")) }).request(`/${A}/asks/k1/answer`, json("POST", { kind: "once" }));
        expect(unknown.status).toBe(404);

        const gateway = fakeGateway([ask("k2", "other")]);
        const foreign = await routesWith({ boot: readyBoot(gateway) }).request(`/${A}/asks/k2/answer`, json("POST", { kind: "always" }));
        expect(foreign.status).toBe(404);
        expect(gateway.answers).toEqual([]);

        const bad = await routesWith().request(`/${A}/asks/k1/answer`, json("POST", { kind: "maybe" }));
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ error: "validation_error" });
    });
});
