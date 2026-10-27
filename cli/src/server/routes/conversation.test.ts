import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import {
    envelopeDisplayMessages,
    type AnswerOutcome,
    type AskGateway,
    type AskReply,
    type ChatFrame,
    type ChatTurns,
    type DbError,
    type LoadPageOptions,
    type PendingAsk,
    type StoredMessage,
    type Thread,
    type ThreadPage,
    type ThreadStore,
    type TurnPage,
} from "@inflexa-ai/harness";

import type { ServerBootState } from "../../api/server.ts";
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
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { listAnalysisPage } from "../../db/primary_query.ts";
import { asStr256 } from "../../lib/types.ts";
import { freshDb } from "../../test_support/db.ts";
import type { RunChatTurnArgs } from "../../modules/harness/turn.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { conversationThread, FIXTURE_ANALYSIS_ID, reportThread } from "../../test_support/threads.ts";
import { idleBoot } from "../../test_support/server.ts";
import type { ServerBoot } from "../boot.ts";
import { __resetTurnsForTest, hasRunningTurn, refuseNewTurns, startTurn } from "../turns.ts";
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
        listRecentThreads: () => errAsync(UNUSED),
    };
    return Object.assign(store, { listed, purged });
}

/** An ask gateway over a fixed pending set, which records each answer. */
function fakeGateway(pending: PendingAsk[], outcome: AnswerOutcome = "applied"): AskGateway & { answers: { id: string; reply: AskReply }[] } {
    const answers: { id: string; reply: AskReply }[] = [];
    return {
        answers,
        raise: () => Promise.reject(new Error("the routes never raise")),
        expire: () => Promise.reject(new Error("the routes never expire")),
        abort: () => Promise.reject(new Error("the routes never abort")),
        answer: (id, reply) => {
            answers.push({ id, reply });
            return Promise.resolve(outcome);
        },
        pending: () => Promise.resolve(pending),
        sweepExpired: () => Promise.resolve(0),
    };
}

/**
 * A boot whose runtime is ready. The routes read the pool, the chat turns, and the gateway of the runtime, and each
 * fake below ignores the pool. The chat turns answer through the gateway, and a read gives `frames`.
 */
function readyBoot(gateway: AskGateway = fakeGateway([]), frames: readonly ChatFrame[] = []): ServerBoot {
    const chatTurns: Pick<ChatTurns, "answer" | "read"> = {
        answer: (id, reply) => gateway.answer(id, reply),
        async *read() {
            for (const frame of frames) yield frame;
        },
    };
    // The cast is sound for the reason above: no route under test reads another field of the runtime.
    const runtime = {
        pool: {},
        chatTurns,
        askGateway: gateway,
    } as unknown as HarnessRuntime;
    const state: ServerBootState = {
        version: "0.0.0-test",
        apiVersion: 1,
        startedAt: new Date().toISOString(),
        phase: "ready",
        connection: { provider: "anthropic", mode: "cliproxy", model: "m" },
    };
    return { state: () => state, runtime: () => runtime, start: async () => undefined };
}

/** One stored user row that opens turn `index`: its display projection replays as one `user` chat message that reads `turn <index>`. */
function turnRow(index: number): StoredMessage[] {
    const message = { role: "user" as const, content: `turn ${index}` };
    return [
        {
            seq: index,
            envelope: { kind: "ai-sdk-model-message", aiSdkMajor: 7, message },
            message,
            displayEnvelope: envelopeDisplayMessages([{ id: `m${index}`, role: "user", parts: [{ type: "text", text: `turn ${index}` }] }]),
        },
    ];
}

/** The text of a replayed one-part chat message. */
function textOf(message: MessageList["messages"][number]): string {
    const part = message.parts[0];
    return part?.type === "text" ? part.text : "";
}

/**
 * A thread of `count` turns that answers `loadPage` by the contract of the harness: the newest `limit` turns
 * below the cursor, and the opening `seq` of the oldest turn as the next cursor, or `null` at the start. Each
 * call it receives is in `calls`.
 */
function turnStore(count: number): {
    calls: LoadPageOptions[];
    loadPage: (pool: unknown, threadId: string, options: LoadPageOptions) => ResultAsync<TurnPage, DbError>;
} {
    const calls: LoadPageOptions[] = [];
    const all = Array.from({ length: count }, (_, i) => turnRow(i));
    return {
        calls,
        loadPage: (_pool, _threadId, options) => {
            calls.push(options);
            const upper = options.before ?? count;
            const turns = all.slice(Math.max(0, upper - options.limit), upper);
            const oldest = turns[0]?.[0]?.seq ?? 0;
            return okAsync({ turns, before: oldest > 0 ? oldest : null });
        },
    };
}

type Options = Partial<ConversationRouteOpts> & { store?: ThreadStore; boot?: ServerBoot };

function routesWith(o: Options = {}): ReturnType<typeof conversationRoutes> {
    const store = o.store ?? memoryStore([conversationThread()]);
    return conversationRoutes(o.boot ?? readyBoot(), {
        ...DEFAULT_CONVERSATION_ROUTE_OPTS,
        threads: () => store,
        loadPage: () => okAsync({ turns: [], before: null }),
        retract: () => okAsync({ kind: "retracted", messages: 2 }),
        threadAnalysisId: (_pool, id) => okAsync(id === T ? A : null),
        runTurn: () => Promise.resolve({ kind: "ok", opened: true, fallbackText: "" }),
        connection: () => ({ provider: "anthropic", mode: "direct" }),
        readCredentialVerdict: () => Promise.resolve(err({ type: "no_key" })),
        flushPendingAdds: () => undefined,
        workspaceRoot: async () => ({ kind: "absent" }),
        removeDir: () => okAsync(undefined),
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
            runningTurnId: null,
            pendingAsks: 0,
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

    describe("the turn and ask fields of a thread", () => {
        const openAsk = (id: string, threadId: string | null): PendingAsk => ({
            id,
            analysisId: A,
            userId: "local",
            threadId,
            title: "Run a command",
            command: "ls",
            detail: null,
            createdAt: "2026-10-02T10:00:00.000Z",
        });
        const ledgerDown = (): AskGateway => ({ ...fakeGateway([]), pending: () => Promise.reject(new Error("ledger down")) });

        test("a thread with a running turn and open asks carries the turn id and the count, and an idle thread carries none", async () => {
            startTurn({ turnId: "turn-old", threadId: T, analysisId: A }, new Date("2026-10-02T10:00:00.000Z"), new AbortController());
            startTurn({ turnId: "turn-new", threadId: T, analysisId: A }, new Date("2026-10-02T10:05:00.000Z"), new AbortController());
            const store = memoryStore([conversationThread(), conversationThread({ threadId: "thread-idle" })]);
            const asks = [openAsk("k1", T), openAsk("k2", T), openAsk("k3", "thread-idle-other"), openAsk("k4", null)];
            const routes = routesWith({ store, boot: readyBoot(fakeGateway(asks)) });

            const list = (await (await routes.request(`/${A}/threads`)).json()) as ThreadList;
            const byId = new Map(list.threads.map((thread) => [thread.id, thread]));
            expect(byId.get(T)).toMatchObject({ runningTurnId: "turn-new", pendingAsks: 2 });
            expect(byId.get("thread-idle")).toMatchObject({ runningTurnId: null, pendingAsks: 0 });

            const single = (await (await routes.request(`/${A}/threads/${T}`)).json()) as ThreadSummary;
            expect(single).toMatchObject({ runningTurnId: "turn-new", pendingAsks: 2 });
        });

        test("PATCH {T} and POST {T}/restore carry the fields too", async () => {
            startTurn({ turnId: "turn-1", threadId: T, analysisId: A }, new Date("2026-10-02T10:00:00.000Z"), new AbortController());
            const store = memoryStore([conversationThread()]);
            const routes = routesWith({ store, boot: readyBoot(fakeGateway([openAsk("k1", T)])) });

            const renamed = (await (await routes.request(`/${A}/threads/${T}`, json("PATCH", { title: "New" }))).json()) as ThreadSummary;
            expect(renamed).toMatchObject({ title: "New", runningTurnId: "turn-1", pendingAsks: 1 });

            await routes.request(`/${A}/threads/${T}`, { method: "DELETE" });
            const restored = (await (await routes.request(`/${A}/threads/${T}/restore`, { method: "POST" })).json()) as ThreadSummary;
            expect(restored).toMatchObject({ id: T, runningTurnId: "turn-1", pendingAsks: 1 });
        });

        test("the list reads the asks one time, whatever the count of threads", async () => {
            const rows = Array.from({ length: 20 }, (_, i) => conversationThread({ threadId: `thread-${i}` }));
            let reads = 0;
            const gateway: AskGateway = {
                ...fakeGateway([]),
                pending: () => {
                    reads += 1;
                    return Promise.resolve([]);
                },
            };

            const response = await routesWith({ store: memoryStore(rows), boot: readyBoot(gateway) }).request(`/${A}/threads`);

            expect(((await response.json()) as ThreadList).threads).toHaveLength(20);
            expect(reads).toBe(1);
        });

        test("a rejected ask read gives 500 on each route that gives a thread, and PATCH changes no title", async () => {
            const store = memoryStore([conversationThread()]);
            const routes = routesWith({ store, boot: readyBoot(ledgerDown()) });

            for (const response of [await routes.request(`/${A}/threads`), await routes.request(`/${A}/threads/${T}`)]) {
                expect(response.status).toBe(500);
                expect(await response.json()).toMatchObject({ error: "internal_error" });
            }

            const patched = await routes.request(`/${A}/threads/${T}`, json("PATCH", { title: "Changed" }));
            expect(patched.status).toBe(500);
            expect(await patched.json()).toMatchObject({ error: "internal_error" });
            expect((await store.getThread(T))._unsafeUnwrap()?.title).toBe("Cohort survival questions");
        });

        test("a rejected ask read leaves an archived thread archived on POST {T}/restore", async () => {
            const store = memoryStore([conversationThread({ deletedAt: new Date("2026-07-09T00:00:00.000Z") })]);

            const response = await routesWith({ store, boot: readyBoot(ledgerDown()) }).request(`/${A}/threads/${T}/restore`, { method: "POST" });

            expect(response.status).toBe(500);
            expect((await store.getThread(T))._unsafeUnwrap()).toBeNull();
        });
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
        const routes = routesWith({
            store,
            removeDir: (dir) => {
                removed.push(dir);
                return okAsync(undefined);
            },
        });
        const response = await routes.request(`/${A}/threads/${T}/purge`, json("POST", { files: "keep" }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ purged: [T, "thread-report"], pages: { kind: "kept" } });
        expect(store.purged).toEqual([T]);
        expect(removed).toEqual([]);
    });

    test("POST {T}/purge removes the page folder of each erased thread, and names each folder that stayed", async () => {
        const store = memoryStore([conversationThread(), reportThread()]);
        const routes = routesWith({
            store,
            workspaceRoot: async () => ({ kind: "root", root: "/ws" }),
            removeDir: (dir) => (dir.endsWith("thread-report") ? errAsync({ type: "io_failed", op: "test", cause: "EACCES" }) : okAsync(undefined)),
        });
        const body = (await (await routes.request(`/${A}/threads/${T}/purge`, json("POST", { files: "remove" }))).json()) as PurgedThread;
        expect(body.pages).toEqual({ kind: "stayed", dirs: [join("/ws", "report-sessions", "thread-report")] });
    });

    test("POST {T}/purge waits for a slow remove of a page folder, and holds no other request meanwhile", async () => {
        const store = memoryStore([conversationThread(), reportThread()]);
        let release = (): void => undefined;
        const removing = new Promise<void>((resolve) => {
            release = resolve;
        });
        const routes = routesWith({
            store,
            workspaceRoot: async () => ({ kind: "root", root: "/ws" }),
            removeDir: () => ResultAsync.fromSafePromise(removing),
        });
        let purged = false;
        const purging = Promise.resolve(routes.request(`/${A}/threads/${T}/purge`, json("POST", { files: "remove" }))).then((response) => {
            purged = true;
            return response;
        });

        expect((await routes.request(`/${A}/threads/${T}/turns`)).status).toBe(200);
        await Promise.sleep(20);
        expect(purged).toBe(false);

        release();
        expect(((await (await purging).json()) as PurgedThread).pages).toEqual({ kind: "removed" });
    });

    test("POST {T}/purge reports a workspace that does not resolve, and refuses a body with no `files`", async () => {
        const unlocatable = routesWith({ workspaceRoot: async () => ({ kind: "unlocatable" }) });
        const body = (await (await unlocatable.request(`/${A}/threads/${T}/purge`, json("POST", { files: "remove" }))).json()) as PurgedThread;
        expect(body.pages).toEqual({ kind: "unlocatable" });
        expect((await routesWith().request(`/${A}/threads/${T}/purge`, json("POST", {}))).status).toBe(400);
    });

    test("GET {T}/messages gives the newest turns, in chat order, with a cursor for the next older page", async () => {
        const thread = turnStore(30);
        const response = await routesWith({ loadPage: thread.loadPage }).request(`/${A}/threads/${T}/messages`);
        expect(response.status).toBe(200);
        const list = (await response.json()) as MessageList;
        expect(list.messages.map(textOf)).toEqual(Array.from({ length: 20 }, (_, i) => `turn ${i + 10}`));
        expect(list).toMatchObject({ total: 20, page: 0, perPage: 20, hasMore: true, before: "10" });
    });

    test("GET {T}/messages with the cursor of a page gives the turns before it, and the last page has a null cursor", async () => {
        const thread = turnStore(30);
        const routes = routesWith({ loadPage: thread.loadPage });
        const first = (await (await routes.request(`/${A}/threads/${T}/messages`)).json()) as MessageList;
        const last = (await (await routes.request(`/${A}/threads/${T}/messages?before=${first.before}`)).json()) as MessageList;
        expect(last.messages.map(textOf)).toEqual(Array.from({ length: 10 }, (_, i) => `turn ${i}`));
        expect(last).toMatchObject({ total: 10, page: 0, perPage: 20, hasMore: false, before: null });
    });

    test("GET {T}/messages gives a short thread in one page", async () => {
        const list = (await (await routesWith({ loadPage: turnStore(3).loadPage }).request(`/${A}/threads/${T}/messages`)).json()) as MessageList;
        expect(list.messages.map(textOf)).toEqual(["turn 0", "turn 1", "turn 2"]);
        expect(list).toMatchObject({ total: 3, hasMore: false, before: null });
    });

    test("GET {T}/messages gives a page of no turns for a thread that holds none", async () => {
        const list = (await (await routesWith().request(`/${A}/threads/${T}/messages`)).json()) as MessageList;
        expect(list).toEqual({ messages: [], total: 0, page: 0, perPage: 20, hasMore: false, before: null });
    });

    test("GET {T}/messages gives the store a limit of 20 by default, caps it at 100, and falls back to 20 for a bad value", async () => {
        const thread = turnStore(500);
        const routes = routesWith({ loadPage: thread.loadPage });
        const perPageOf = async (query: string): Promise<number> =>
            ((await (await routes.request(`/${A}/threads/${T}/messages${query}`)).json()) as MessageList).perPage;
        expect(await perPageOf("")).toBe(20);
        expect(await perPageOf("?limit=500")).toBe(100);
        expect(await perPageOf("?limit=abc")).toBe(20);
        expect(await perPageOf("?limit=0")).toBe(20);
        expect(await perPageOf("?limit=7")).toBe(7);
        expect(thread.calls.map((call) => call.limit)).toEqual([20, 100, 20, 20, 7]);
    });

    test("GET {T}/messages reads the turns of the page only: the store gets the cursor as a number, and no cursor as no key", async () => {
        const thread = turnStore(500);
        const routes = routesWith({ loadPage: thread.loadPage });
        await routes.request(`/${A}/threads/${T}/messages?limit=20`);
        await routes.request(`/${A}/threads/${T}/messages?limit=20&before=480`);
        await routes.request(`/${A}/threads/${T}/messages?before=0`);
        expect(thread.calls).toEqual([{ limit: 20 }, { limit: 20, before: 480 }, { limit: 20, before: 0 }]);
        expect(thread.calls.every((call) => !("before" in call) || typeof call.before === "number")).toBe(true);
    });

    test("GET {T}/messages refuses a cursor that is not a decimal safe integer with 400 `validation_error`, and reads no turn", async () => {
        const thread = turnStore(30);
        const routes = routesWith({ loadPage: thread.loadPage });
        for (const bad of ["abc", "", "-1", "1.5", "1e3", "0x10", "9007199254740993"]) {
            const response = await routes.request(`/${A}/threads/${T}/messages?before=${bad}`);
            expect({ bad, status: response.status }).toEqual({ bad, status: 400 });
            const body = (await response.json()) as { error: string; details: { fieldErrors: Record<string, string[]> } };
            expect(body.error).toBe("validation_error");
            expect(body.details.fieldErrors.before).toBeDefined();
        }
        expect(thread.calls).toEqual([]);
    });

    test("GET {T}/messages gives 404 `not_found` for a thread with no row, and reads no turn", async () => {
        const thread = turnStore(30);
        const routes = routesWith({ loadPage: thread.loadPage });
        const response = await routes.request(`/${A}/threads/missing/messages`);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_found" });
        expect((await routes.request(`/other/threads/${T}/messages`)).status).toBe(404);
        expect(thread.calls).toEqual([]);
    });

    test("GET {T}/messages gives 500 `internal_error` when the read fails", async () => {
        const failed: DbError = { type: "query_failed", op: "test", cause: new Error("db down") };
        const routes = routesWith({ loadPage: () => errAsync(failed) });
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
                args.onOpened?.(crypto.randomUUID());
                args.emit({ type: "text-delta", text: "Hello", source: { agentId: "chat", callPath: ["chat"] } });
                args.emit({ type: "iteration", source: { agentId: "planner", callPath: ["chat", "planner"] } });
                return { kind: "ok", opened: true, fallbackText: "Hello", turnUsage: { inputTokens: 10, outputTokens: 2 } };
            },
        });
        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("text/event-stream");
        const turnId = response.headers.get(TURN_ID_HEADER);
        expect(turnId).not.toBeNull();

        // The TUI draws the thinking line of a sub-agent from the frame of its `iteration`.
        expect(await framesOf(response)).toEqual([
            { type: "text-delta", text: "Hello", source: { agentId: "chat", callPath: ["chat"] } },
            { type: "iteration", source: { agentId: "planner", callPath: ["chat", "planner"] } },
            { type: "finish", source: { agentId: "chat", callPath: ["chat"] }, turnUsage: { inputTokens: 10, outputTokens: 2 } },
        ]);
        const summary = (await (await routes.request(`/${A}/threads/${T}/turns/${turnId}`)).json()) as TurnSummary;
        expect(summary).toMatchObject({ turnId, threadId: T, analysisId: A, status: "done", opened: true, fallbackText: "Hello" });
        expect(summary.durationMs).toBeGreaterThanOrEqual(0);
        expect(flushed).toBe(1);
        expect(hasRunningTurn(A)).toBe(false);
    });

    test("gives the turn the chat turns of the runtime and the session of the thread", async () => {
        let seen: RunChatTurnArgs | null = null;
        const boot = readyBoot();
        const routes = routesWith({
            boot,
            runTurn: (args) => {
                seen = args;
                args.onOpened?.(crypto.randomUUID());
                return Promise.resolve({ kind: "ok", opened: true, fallbackText: "" });
            },
        });
        await framesOf(await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hello" })));
        // The chat turns of the runtime carry its recorder and its gateway. Without them, the calls of the
        // conversation agent never reach the ledger, and its asks never reach the surface.
        const args = seen as RunChatTurnArgs | null;
        expect(args?.chatTurns).toBe(boot.runtime()!.chatTurns);
        expect(args?.session.scope).toEqual({ kind: "analysis", analysisId: A, threadId: T });
        expect(args).toMatchObject({ analysisId: A, threadId: T, userInput: "hello" });
    });

    test("keeps the frames of a sub-agent, with their source", async () => {
        const routes = routesWith({
            runTurn: async (args) => {
                args.onOpened?.(crypto.randomUUID());
                args.emit({ type: "tool-started", source: { agentId: "planner", callPath: ["chat", "planner"] }, toolUseId: "u1", name: "bash" });
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

    test("409 `conflict` for a thread with a turn that runs, and the registry holds no turn", async () => {
        const response = await routesWith({ runTurn: () => Promise.resolve({ kind: "turn_in_progress" }) }).request(
            `/${A}/chat`,
            json("POST", { threadId: T, message: "hi" }),
        );

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: "conflict" });
        expect(hasRunningTurn(A)).toBe(false);
    });

    test("400 `validation_error` for an empty message", async () => {
        const response = await routesWith().request(`/${A}/chat`, json("POST", { threadId: T, message: "" }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error" });
    });

    test("a failed turn ends with one `error` frame, and its summary carries the remedy and the detail lines", async () => {
        const routes = routesWith({
            runTurn: (args) => {
                args.onOpened?.(crypto.randomUUID());
                return Promise.resolve({ kind: "failed", opened: true, reason: "The model endpoint refused the credential.", code: "credential" });
            },
        });
        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        const turnId = response.headers.get(TURN_ID_HEADER);
        // A detached server holds the port, thus `inflexa serve` cannot start a second one: the remedy stops the
        // server, and the next command starts one that reads the key again.
        const message =
            "The anthropic endpoint rejected your API key — check INFLEXA_MODEL_API_KEY, then run `inflexa server stop`. The next `inflexa` command starts the server with the new key.";
        expect(await framesOf(response)).toEqual([{ type: "error", message, source: { agentId: "chat", callPath: ["chat"] } }]);
        const summary = (await (await routes.request(`/${A}/threads/${T}/turns/${turnId}`)).json()) as TurnSummary;
        expect(summary.status).toBe("failed");
        expect(summary.failure).toMatchObject({ message, auth: { provider: "anthropic", envVar: "INFLEXA_MODEL_API_KEY" } });
        expect(summary.failure?.detailLines.length).toBeGreaterThan(0);
    });

    test("a refused `cliproxy` login names `inflexa up`, the command that signs in, and not `inflexa serve`", async () => {
        const routes = routesWith({
            connection: () => ({ provider: "anthropic", mode: "cliproxy" }),
            runTurn: (args) => {
                args.onOpened?.(crypto.randomUUID());
                return Promise.resolve({ kind: "failed", opened: true, reason: "The model endpoint refused the credential.", code: "credential" });
            },
        });
        const frames = await framesOf(await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" })));
        const error = frames.find((frame) => frame.type === "error");
        const text = error?.type === "error" ? error.message : "";
        expect(text).toContain("run `inflexa up` in a terminal to sign in again");
        expect(text).not.toContain("inflexa serve");
    });

    test("a failed `cliproxy` turn names a rate limit that the proxy reports", async () => {
        const routes = routesWith({
            connection: () => ({ provider: "anthropic", mode: "cliproxy" }),
            readCredentialVerdict: () => Promise.resolve(ok({ kind: "rate_limited", retryAt: new Date("2026-10-02T12:00:00.000Z") })),
            runTurn: (args) => {
                args.onOpened?.(crypto.randomUUID());
                return Promise.resolve({ kind: "failed", opened: true, reason: "The model request failed.", code: "outage" });
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
                args.onOpened?.(crypto.randomUUID());
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
                args.onOpened?.(crypto.randomUUID());
                args.emit({ type: "text-delta", text: "first", source: { agentId: "chat", callPath: ["chat"] } });
                await proceed.wait;
                aborted = args.signal.aborted;
                args.emit({ type: "text-delta", text: "second", source: { agentId: "chat", callPath: ["chat"] } });
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

    test("GET {T}/turns/:turnId/stream reads the frames of a turn again, and a turn of a different thread gives 404", async () => {
        const source = { agentId: "chat", callPath: ["chat"] };
        const stored: ChatFrame[] = [
            { type: "text-delta", text: "Hello", source },
            { type: "finish", source },
        ];
        const routes = routesWith({ boot: readyBoot(fakeGateway([]), stored) });
        startTurn({ turnId: "turn-1", threadId: T, analysisId: A }, new Date(), new AbortController());

        const again = await routes.request(`/${A}/threads/${T}/turns/turn-1/stream`);

        expect(again.status).toBe(200);
        expect(await framesOf(again)).toEqual(stored);
        expect((await routes.request(`/${A}/threads/other/turns/turn-1/stream`)).status).toBe(404);
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

describe("the activity time of the analysis", () => {
    const SEEDED = 1_000;

    beforeEach(() => {
        freshDb();
        insertAnchor({ id: "anchor-1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/a", markerWritten: false, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis({ id: A, createdAt: SEEDED, updatedAt: SEEDED, name: asStr256("a"), slug: "a", anchorId: "anchor-1", projectId: null })._unsafeUnwrap();
    });

    function activityAt(): number {
        return listAnalysisPage({ projectId: null, sort: "created", limit: 10, offset: 0 })
            ._unsafeUnwrap()
            .items.find((item) => item.analysis.id === A)!.lastActivityAt;
    }

    const pendingAsk: PendingAsk = {
        id: "k1",
        analysisId: A,
        userId: "local",
        threadId: T,
        title: "Run a command",
        command: "rm -rf scratch",
        detail: null,
        createdAt: "2026-10-02T10:00:00.000Z",
    };

    test("a turn raises it when the turn opens and again when the turn ends", async () => {
        const release = gate();
        const routes = routesWith({
            runTurn: async (args) => {
                args.onOpened?.(crypto.randomUUID());
                await release.wait;
                return { kind: "ok", opened: true, fallbackText: "" };
            },
        });

        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));
        const opened = activityAt();
        expect(opened).toBeGreaterThan(SEEDED);

        await Bun.sleep(5);
        release.open();
        await framesOf(response);
        expect(activityAt()).toBeGreaterThan(opened);
    });

    test("a refused turn changes nothing", async () => {
        const routes = routesWith({ runTurn: () => Promise.resolve({ kind: "thread_gone" }) });

        const response = await routes.request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));

        expect(response.status).toBe(404);
        expect(activityAt()).toBe(SEEDED);
    });

    test("a turn that the draining server refuses changes nothing", async () => {
        refuseNewTurns();

        const response = await routesWith().request(`/${A}/chat`, json("POST", { threadId: T, message: "hi" }));

        expect(response.status).toBe(503);
        expect(activityAt()).toBe(SEEDED);
    });

    test("an applied answer raises it", async () => {
        const response = await routesWith({ boot: readyBoot(fakeGateway([pendingAsk])) }).request(`/${A}/asks/k1/answer`, json("POST", { kind: "once" }));

        expect(response.status).toBe(200);
        expect(activityAt()).toBeGreaterThan(SEEDED);
    });

    test("an answer that is not applied changes nothing", async () => {
        for (const outcome of ["already_terminal", "not_found"] as const) {
            const response = await routesWith({ boot: readyBoot(fakeGateway([], outcome)) }).request(`/${A}/asks/k1/answer`, json("POST", { kind: "once" }));
            expect(response.status).not.toBe(200);
        }
        const foreign = await routesWith({ boot: readyBoot(fakeGateway([{ ...pendingAsk, analysisId: "other" }])) }).request(
            `/${A}/asks/k1/answer`,
            json("POST", { kind: "once" }),
        );
        expect(foreign.status).toBe(404);

        expect(activityAt()).toBe(SEEDED);
    });
});
