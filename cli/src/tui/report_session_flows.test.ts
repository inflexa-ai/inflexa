import { afterEach, describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { DbError, Pool, Thread } from "@inflexa-ai/harness";

import { conversationThread, reportThread, threadPageOf, FIXTURE_ANALYSIS_ID } from "../test_support/threads.ts";
import { __setBootStateForTest } from "./hooks/boot.ts";
import {
    commands,
    openParentSession,
    openReportSession,
    openSwitchReportSession,
    openSwitchSession,
    realSessionSeams,
    reportSessionItems,
    selectReportSession,
    switchSessionItems,
    type SessionSeams,
} from "./commands.tsx";
import { realThreadSeams } from "./hooks/thread.ts";
import type { Workspace } from "./contexts/workspace.ts";
import type { Notice } from "./theme.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import type { Analysis } from "../types/analysis.ts";

// The three report-session flows reach Postgres, the booted runtime, and the toast channel through
// `SessionSeams`, thus every case here runs offline. Each assertion reads an OUTCOME the user meets:
// which thread the swap bound, whether a dialog opened, and what the notice says. A call count would
// pass on a flow that reads correctly and then acts on the wrong row.

afterEach(() => {
    __setBootStateForTest({ phase: "idle" });
});

describe("report session flows", () => {
    // Only `id` is load-bearing: the flows pass the row through to `openSession` and compare it by id.
    // Thus a partial stand-in cast keeps the fixture flat, as `commands.test.ts` does.
    const ANALYSIS = { id: FIXTURE_ANALYSIS_ID, name: "Alpha", projectId: null } as unknown as Analysis;
    const OTHER = { id: "a2", name: "Beta", projectId: null } as unknown as Analysis;
    // The seams read only `.pool` off the handle and the fakes ignore it, thus a partial stand-in cast
    // keeps every case offline.
    const fakePool = {} as unknown as Pool;
    const fakeRuntime = { pool: fakePool } as unknown as HarnessRuntime;
    const dbErr: DbError = { type: "query_failed", op: "test", cause: new Error("boom") };
    const READY = { phase: "ready", model: "claude-opus-4-8", connection: { provider: "anthropic", mode: "cliproxy" } } as const;

    // The open conversation and the report session it spawned. The back flow reads BOTH rows through the
    // one `getThread` seam, thus a fake that ignores the id could answer the parent read with the child
    // and still look correct.
    const PARENT = conversationThread({ threadId: "thread-parent", title: "Cohort survival questions" });
    const CHILD = reportThread({ threadId: "thread-report-1", parentThreadId: PARENT.threadId, parentSeq: 4 });

    /**
     * A workspace stand-in recording the two writes a flow can make: dialogs and scope swaps.
     *
     * `swapTo` moves the open scope the way the analysis-switch keys of the user would. Each flow reads
     * the scope one time, awaits Postgres, then acts, and nothing is modal across that await. To drive
     * the swap from inside a seam is how a case lands in that window with no timing.
     */
    function sessionScope(
        analysis: Analysis | null,
        sessionId: string | null,
    ): {
        ws: Workspace;
        dialogs: () => number;
        opened: { threadId: string | null; analysisId: string }[];
        swapTo: (next: { analysis?: Analysis; sessionId?: string | null }) => void;
    } {
        const opened: { threadId: string | null; analysisId: string }[] = [];
        let dialogs = 0;
        const scope: { analysis: Analysis | null; sessionId: string | null } = { analysis, sessionId };
        const ws = {
            get analysis() {
                return scope.analysis;
            },
            get sessionId() {
                return scope.sessionId;
            },
            workingDir: "/work",
            project: null,
            openDialog: () => {
                dialogs += 1;
            },
            closeDialog: () => {},
            openSession: (threadId: string | null, _workingDir: string, next: Analysis) => {
                opened.push({ threadId, analysisId: next.id });
            },
            quit: async () => {},
        } as unknown as Workspace;
        return {
            ws,
            dialogs: () => dialogs,
            opened,
            swapTo: (next) => {
                if (next.analysis !== undefined) scope.analysis = next.analysis;
                if (next.sessionId !== undefined) scope.sessionId = next.sessionId;
            },
        };
    }

    /**
     * A `getThread` seam over a fixed set of rows, keyed by thread id as the store keys them. The back
     * flow reads the open thread and then its parent through this one seam, thus an id-blind fake would
     * hand the parent read the child row and hide a wrong lookup.
     */
    function rowsByThreadId(rows: Thread[]): SessionSeams["getThread"] {
        const table = new Map(rows.map((r) => [r.threadId, r]));
        return (_pool, threadId) => okAsync(table.get(threadId) ?? null);
    }

    /** Seams plus a recorder for the notices raised. */
    function makeSeams(over: Partial<SessionSeams> = {}): { seams: SessionSeams; notices: Notice[] } {
        const notices: Notice[] = [];
        const base: SessionSeams = {
            runtime: () => fakeRuntime,
            listThreads: () => okAsync(threadPageOf([])),
            listReportChildren: () => okAsync(threadPageOf([])),
            getThread: () => okAsync(null),
            updateTitle: () => okAsync(null),
            listThreadsWithArchived: () => okAsync(threadPageOf([])),
            archiveThread: () => okAsync<void, DbError>(undefined),
            unarchiveThread: () => okAsync<void, DbError>(undefined),
            purgeThread: () => okAsync<void, DbError>(undefined),
            chatBusy: () => false,
            resolveThreadId: async () => "thread-resolved",
            workingDirFor: () => "/work",
            refreshThread: () => {},
            notify: (n) => {
                notices.push(n);
            },
        };
        return { seams: { ...base, ...over }, notices };
    }

    describe("the back chord", () => {
        test("a report child opens the conversation that spawned it, in place and with no dialog", async () => {
            __setBootStateForTest(READY);
            const t = makeSeams({ getThread: rowsByThreadId([CHILD, PARENT]) });
            const w = sessionScope(ANALYSIS, CHILD.threadId);

            await openParentSession(w.ws, t.seams);

            // The thread moves and the analysis does not: the store refuses a parent link across two
            // analyses, thus the swap has one degree of freedom.
            expect(w.opened).toEqual([{ threadId: PARENT.threadId, analysisId: ANALYSIS.id }]);
            expect(w.dialogs()).toBe(0);
            expect(t.notices).toEqual([]);
        });

        test("a conversation, a thread with no row, and a report row with no parent link all say the same thing", async () => {
            // The spawn writes a report row before that child exists anywhere, thus a bound id with no row
            // is a conversation whose first turn has not landed. Three inputs, one honest answer.
            __setBootStateForTest(READY);
            const orphan = reportThread({ threadId: "thread-orphan", parentThreadId: null });
            const cases: { name: string; seams: SessionSeams["getThread"]; bound: string }[] = [
                { name: "a conversation", seams: rowsByThreadId([PARENT]), bound: PARENT.threadId },
                { name: "no row at all", seams: rowsByThreadId([]), bound: "thread-unwritten" },
                { name: "a report row with no parent link", seams: rowsByThreadId([orphan]), bound: orphan.threadId },
            ];

            for (const c of cases) {
                const t = makeSeams({ getThread: c.seams });
                const w = sessionScope(ANALYSIS, c.bound);

                await openParentSession(w.ws, t.seams);

                expect(w.opened, c.name).toEqual([]);
                expect(t.notices, c.name).toHaveLength(1);
                expect(t.notices[0]?.kind, c.name).toBe("info");
                expect(t.notices[0]?.text, c.name).toContain("no parent");
            }
        });

        test("an unreadable open thread says the read failed, never that the session has no parent", async () => {
            // A `DbError` folded into the no-parent arm would tell a user whose Postgres blinked a fact
            // about the shape of their data that is not true.
            __setBootStateForTest(READY);
            const t = makeSeams({ getThread: () => errAsync(dbErr) });
            const w = sessionScope(ANALYSIS, CHILD.threadId);

            await openParentSession(w.ws, t.seams);

            expect(w.opened).toEqual([]);
            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]?.kind).toBe("error");
            expect(t.notices[0]?.text).toContain("read this session");
            expect(t.notices[0]?.text).not.toContain("no parent");
        });

        test("a parent that resolves to no row names the absence and leaves the user where they are", async () => {
            // A normal state and never a fault: the read hides an archived row, and the chat scope can name
            // a thread that another instance moved.
            __setBootStateForTest(READY);
            const t = makeSeams({ getThread: rowsByThreadId([CHILD]) });
            const w = sessionScope(ANALYSIS, CHILD.threadId);

            await openParentSession(w.ws, t.seams);

            expect(w.opened).toEqual([]);
            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]?.kind).toBe("warn");
            expect(t.notices[0]?.text).toContain("no longer listed");
        });

        test("a failed parent read surfaces the error rather than a claim about the parent", async () => {
            __setBootStateForTest(READY);
            const t = makeSeams({
                getThread: (_pool, threadId) => (threadId === CHILD.threadId ? okAsync(CHILD) : errAsync(dbErr)),
            });
            const w = sessionScope(ANALYSIS, CHILD.threadId);

            await openParentSession(w.ws, t.seams);

            expect(w.opened).toEqual([]);
            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]?.kind).toBe("error");
            expect(t.notices[0]?.text).toContain("the parent conversation");
            expect(t.notices[0]?.text).not.toContain("no longer listed");
        });

        test("dispatched before ready it speaks the boot refusal in both of its forms", async () => {
            // The chord dispatches by id and consults no palette predicate, thus this path IS reachable
            // while the runtime still boots.
            __setBootStateForTest({ phase: "failed", message: "postgres unreachable" });
            const failed = makeSeams({ getThread: rowsByThreadId([CHILD, PARENT]) });
            const wf = sessionScope(ANALYSIS, CHILD.threadId);

            await openParentSession(wf.ws, failed.seams);

            expect(wf.opened).toEqual([]);
            expect(failed.notices).toHaveLength(1);
            expect(failed.notices[0]?.kind).toBe("warn");
            // `failed` is terminal, thus a wait that never ends must not be promised.
            expect(failed.notices[0]?.text).toContain("did not start");
            expect(failed.notices[0]?.text).toContain("report sessions");
            expect(failed.notices[0]?.text).not.toContain("booting");

            __setBootStateForTest({ phase: "booting" });
            const booting = makeSeams({ getThread: rowsByThreadId([CHILD, PARENT]) });
            const wb = sessionScope(ANALYSIS, CHILD.threadId);

            await openParentSession(wb.ws, booting.seams);

            expect(wb.opened).toEqual([]);
            expect(booting.notices).toHaveLength(1);
            expect(booting.notices[0]?.kind).toBe("info");
            expect(booting.notices[0]?.text).toContain("booting");
        });
    });

    describe("the forward chord", () => {
        test("exactly one report child swaps onto it with NO picker", async () => {
            // A picker over one row asks the user to confirm what the keystroke already said.
            __setBootStateForTest(READY);
            const only = reportThread({ threadId: "thread-report-only", parentThreadId: PARENT.threadId });
            const t = makeSeams({ getThread: rowsByThreadId([PARENT]), listReportChildren: () => okAsync(threadPageOf([only])) });
            const w = sessionScope(ANALYSIS, PARENT.threadId);

            await openReportSession(w.ws, t.seams);

            expect(w.opened).toEqual([{ threadId: only.threadId, analysisId: ANALYSIS.id }]);
            expect(w.dialogs()).toBe(0);
            expect(t.notices).toEqual([]);
        });

        test("more than one report child opens the picker and swaps nothing on its own", async () => {
            __setBootStateForTest(READY);
            const first = reportThread({ threadId: "thread-report-1", parentThreadId: PARENT.threadId });
            const second = reportThread({ threadId: "thread-report-2", parentThreadId: PARENT.threadId });
            const t = makeSeams({ getThread: rowsByThreadId([PARENT]), listReportChildren: () => okAsync(threadPageOf([first, second])) });
            const w = sessionScope(ANALYSIS, PARENT.threadId);

            await openReportSession(w.ws, t.seams);

            expect(w.dialogs()).toBe(1);
            // The pick is what swaps, thus the chord binds nothing here.
            expect(w.opened).toEqual([]);
            expect(t.notices).toEqual([]);
        });

        test("a conversation with no report child says so, and a thread with no row answers the same way", async () => {
            // A bound id with no row has no child either, thus the flow answers exactly as an empty set
            // answers and skips the second read.
            __setBootStateForTest(READY);
            const cases: { name: string; seams: SessionSeams["getThread"]; bound: string }[] = [
                { name: "an empty listing", seams: rowsByThreadId([PARENT]), bound: PARENT.threadId },
                { name: "no row at all", seams: rowsByThreadId([]), bound: "thread-unwritten" },
            ];

            for (const c of cases) {
                const t = makeSeams({ getThread: c.seams });
                const w = sessionScope(ANALYSIS, c.bound);

                await openReportSession(w.ws, t.seams);

                expect(w.opened, c.name).toEqual([]);
                expect(w.dialogs(), c.name).toBe(0);
                expect(t.notices, c.name).toHaveLength(1);
                expect(t.notices[0]?.kind, c.name).toBe("info");
                expect(t.notices[0]?.text, c.name).toContain("No report session in this conversation");
            }
        });

        test("an open report session says the tree is flat, rather than reporting no child", async () => {
            // Two different facts about the data of the user. A dead key reads as a broken key, thus each
            // direction speaks its own reason.
            __setBootStateForTest(READY);
            const t = makeSeams({ getThread: rowsByThreadId([CHILD]) });
            const w = sessionScope(ANALYSIS, CHILD.threadId);

            await openReportSession(w.ws, t.seams);

            expect(w.opened).toEqual([]);
            expect(w.dialogs()).toBe(0);
            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]?.kind).toBe("info");
            expect(t.notices[0]?.text).toContain("stays flat");
            expect(t.notices[0]?.text).not.toContain("No report session in this conversation");
        });

        test("an unreadable open thread says the read failed and lists nothing", async () => {
            __setBootStateForTest(READY);
            const t = makeSeams({ getThread: () => errAsync(dbErr), listReportChildren: () => errAsync(dbErr) });
            const w = sessionScope(ANALYSIS, PARENT.threadId);

            await openReportSession(w.ws, t.seams);

            expect(w.dialogs()).toBe(0);
            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]?.kind).toBe("error");
            expect(t.notices[0]?.text).toContain("read this session");
        });

        test("a failed listing warns and opens NO picker, thus no empty state claims there is no child", async () => {
            __setBootStateForTest(READY);
            const t = makeSeams({ getThread: rowsByThreadId([PARENT]), listReportChildren: () => errAsync(dbErr) });
            const w = sessionScope(ANALYSIS, PARENT.threadId);

            await openReportSession(w.ws, t.seams);

            expect(w.dialogs()).toBe(0);
            expect(w.opened).toEqual([]);
            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]?.kind).toBe("warn");
            expect(t.notices[0]?.text).toContain("Could not list the report sessions");
        });

        test("dispatched before ready it speaks the boot refusal in both of its forms", async () => {
            __setBootStateForTest({ phase: "failed", message: "postgres unreachable" });
            const child = reportThread({ parentThreadId: PARENT.threadId });
            const failed = makeSeams({ getThread: rowsByThreadId([PARENT]), listReportChildren: () => okAsync(threadPageOf([child])) });
            const wf = sessionScope(ANALYSIS, PARENT.threadId);

            await openReportSession(wf.ws, failed.seams);

            expect(wf.opened).toEqual([]);
            expect(failed.notices).toHaveLength(1);
            expect(failed.notices[0]?.kind).toBe("warn");
            expect(failed.notices[0]?.text).toContain("did not start");
            expect(failed.notices[0]?.text).not.toContain("booting");

            __setBootStateForTest({ phase: "booting" });
            const booting = makeSeams({ getThread: rowsByThreadId([PARENT]), listReportChildren: () => okAsync(threadPageOf([child])) });
            const wb = sessionScope(ANALYSIS, PARENT.threadId);

            await openReportSession(wb.ws, booting.seams);

            expect(wb.opened).toEqual([]);
            expect(booting.notices).toHaveLength(1);
            expect(booting.notices[0]?.kind).toBe("info");
            expect(booting.notices[0]?.text).toContain("booting");
        });
    });

    describe("the pickers", () => {
        test("the report picker lists exactly the report children and holds no creation row", () => {
            // The agent spawns a report session, thus this picker has no create action that it could
            // honestly offer. The switch picker keeps its pinned row for the opposite reason.
            const first = reportThread({ threadId: "thread-report-1", title: "Volcano plot report" });
            const second = reportThread({ threadId: "thread-report-2", title: "Pathway report" });

            const items = reportSessionItems([first, second]);

            expect(items).toHaveLength(2);
            expect(items.map((i) => i.value)).toEqual([first, second]);
            expect(items[0]?.title).toBe("Volcano plot report");
            // A listed session is a referenced record, thus its last-activity stamp is an absolute local
            // time and not a compact age.
            expect(items[0]?.description).toBe(first.updatedAt.toLocaleString());
            expect(items.filter((i) => i.pinned)).toHaveLength(0);
        });

        test("a report child with no title still gets a readable row", () => {
            // The title is owned by Postgres and seeded from the first message, thus a fresh child can
            // carry none. A blank row would list a session that a user cannot name.
            const items = reportSessionItems([reportThread({ title: null })]);
            expect(items[0]?.title).toBeTruthy();
        });

        test("the switch picker keeps its pinned creation row, which the report picker does not have", () => {
            const conversation = conversationThread({ threadId: "thread-conversation-1" });

            const switchItems = switchSessionItems([conversation]);

            expect(switchItems).toHaveLength(2);
            expect(switchItems.at(-1)?.pinned).toBe(true);
            expect(switchItems.at(-1)?.title).toBe("Start a new session");
        });

        test("each picker draws from its own seam, thus a failure of one leaves the other whole", async () => {
            // The switch picker reads the conversation-narrowed listing and the report picker reads the
            // parent-narrowed one. A flow that consulted both would degrade on a failure that says nothing
            // about the population it lists.
            __setBootStateForTest(READY);
            const child = reportThread({ parentThreadId: PARENT.threadId });
            const reportBroken = makeSeams({ listThreads: () => okAsync(threadPageOf([PARENT])), listReportChildren: () => errAsync(dbErr) });
            const wr = sessionScope(ANALYSIS, PARENT.threadId);

            await openSwitchSession(wr.ws, reportBroken.seams);

            expect(wr.dialogs()).toBe(1);
            expect(reportBroken.notices).toEqual([]);

            const switchBroken = makeSeams({ listThreads: () => errAsync(dbErr), listReportChildren: () => okAsync(threadPageOf([child])) });
            const ws = sessionScope(ANALYSIS, PARENT.threadId);

            await openSwitchReportSession(ws.ws, switchBroken.seams);

            expect(ws.dialogs()).toBe(1);
            expect(switchBroken.notices).toEqual([]);
        });

        test("the palette command always opens the picker, at one child and at none", async () => {
            // This is what makes it different from the forward chord. The chord is a movement, thus one
            // child is the answer that it acts on. The command is a browse, thus the list IS the answer.
            __setBootStateForTest(READY);
            const only = reportThread({ parentThreadId: PARENT.threadId });
            for (const rows of [[only], []]) {
                const t = makeSeams({ listReportChildren: () => okAsync(threadPageOf(rows)) });
                const w = sessionScope(ANALYSIS, PARENT.threadId);

                await openSwitchReportSession(w.ws, t.seams);

                expect(w.dialogs()).toBe(1);
                // Even at one child the pick is what swaps, thus the command binds nothing itself.
                expect(w.opened).toEqual([]);
                expect(t.notices).toEqual([]);
            }
        });

        test("the palette command is offered with no thread bound, and then names the unbound scope", async () => {
            // To hide the command would leave a user who searched for it with no answer at all, thus the
            // gate stays off the bound thread and the flow speaks for itself.
            __setBootStateForTest(READY);
            const entry = commands.find((c) => c.id === "session.report-switch");
            expect(entry).toBeDefined();
            expect(entry?.enabled?.({ analysis: ANALYSIS, sessionId: null } as unknown as Workspace)).toBe(true);

            const t = makeSeams();
            const w = sessionScope(ANALYSIS, null);

            await openSwitchReportSession(w.ws, t.seams);

            expect(w.dialogs()).toBe(0);
            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]?.kind).toBe("info");
            expect(t.notices[0]?.text).toContain("No conversation is open");
        });

        test("a pick closes the dialog and swaps the chat onto that report session", () => {
            // The handler carries the whole behavior of a pick, and nothing reaches it through a mounted
            // dialog. The analysis is the one captured when the picker opened, thus the swap moves the
            // thread alone and never the scope.
            const w = sessionScope(ANALYSIS, PARENT.threadId);

            selectReportSession(w.ws, CHILD, ANALYSIS);

            expect(w.opened).toEqual([{ threadId: CHILD.threadId, analysisId: ANALYSIS.id }]);
            expect(w.dialogs()).toBe(0);
        });
    });

    describe("an analysis that changes across the await", () => {
        // Nothing is modal across a thread read, thus the analysis-switch keys stay live. A swap that
        // landed anyway would bind a thread of the previous analysis beside the working directory of the
        // analysis that is open now: one scope naming two analyses.
        test("the back chord refuses the swap and opens no dialog", async () => {
            __setBootStateForTest(READY);
            const w = sessionScope(ANALYSIS, CHILD.threadId);
            const t = makeSeams({
                getThread: (_pool, threadId) => {
                    if (threadId === CHILD.threadId) return okAsync(CHILD);
                    w.swapTo({ analysis: OTHER });
                    return okAsync(PARENT);
                },
            });

            await openParentSession(w.ws, t.seams);

            expect(w.opened).toEqual([]);
            expect(w.dialogs()).toBe(0);
            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]?.text).toContain("Analysis changed");
        });

        test("the forward chord refuses the swap and opens no dialog", async () => {
            __setBootStateForTest(READY);
            const w = sessionScope(ANALYSIS, PARENT.threadId);
            const only = reportThread({ parentThreadId: PARENT.threadId });
            const t = makeSeams({
                getThread: rowsByThreadId([PARENT]),
                listReportChildren: () => {
                    w.swapTo({ analysis: OTHER });
                    return okAsync(threadPageOf([only]));
                },
            });

            await openReportSession(w.ws, t.seams);

            expect(w.opened).toEqual([]);
            expect(w.dialogs()).toBe(0);
            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]?.text).toContain("Analysis changed");
        });

        test("the palette command refuses the picker it built for the analysis that was left", async () => {
            __setBootStateForTest(READY);
            const w = sessionScope(ANALYSIS, PARENT.threadId);
            const only = reportThread({ parentThreadId: PARENT.threadId });
            const t = makeSeams({
                listReportChildren: () => {
                    w.swapTo({ analysis: OTHER });
                    return okAsync(threadPageOf([only]));
                },
            });

            await openSwitchReportSession(w.ws, t.seams);

            expect(w.dialogs()).toBe(0);
            expect(t.notices).toHaveLength(1);
            expect(t.notices[0]?.text).toContain("Analysis changed");
        });
    });
});

// The narrowing lives in the seam REALIZATIONS and nowhere above them, thus an injected fake shows
// what the fake was told rather than what the real one passes. These cases drive the real realizations
// over a fake pool and read the predicate that reached the store.
describe("the narrowing each realization applies", () => {
    /**
     * A pool that records every statement and answers the two the listing runs: a count, then a page.
     * The store builds one scope fragment and binds every value as a parameter, thus the recorded
     * params ARE the filter.
     */
    function recordingPool(): { pool: Pool; calls: { text: string; values: unknown[] }[] } {
        const calls: { text: string; values: unknown[] }[] = [];
        const query = (text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
            calls.push({ text, values });
            return Promise.resolve({ rows: text.includes("COUNT(") ? [{ count: "0" }] : [] });
        };
        // The store reads `query` alone off the pool, and a real `Pool` carries a surface no test can
        // build. The cast is sound because every statement below arrives at this one function.
        return { pool: { query } as unknown as Pool, calls };
    }

    test("the switch listing asks the store for conversations", async () => {
        const { pool, calls } = recordingPool();
        (await realSessionSeams.listThreads(pool, FIXTURE_ANALYSIS_ID))._unsafeUnwrap();
        expect(calls).not.toHaveLength(0);
        for (const call of calls) {
            expect(call.text).toContain("thread_type = $2");
            expect(call.values.slice(0, 2)).toEqual([FIXTURE_ANALYSIS_ID, "conversation"]);
        }
    });

    test("the report listing asks the store for one parent's report children", async () => {
        const { pool, calls } = recordingPool();
        (await realSessionSeams.listReportChildren(pool, FIXTURE_ANALYSIS_ID, "thread-parent"))._unsafeUnwrap();
        expect(calls).not.toHaveLength(0);
        for (const call of calls) {
            expect(call.text).toContain("thread_type = $2");
            expect(call.text).toContain("parent_thread_id = $3");
            expect(call.values.slice(0, 3)).toEqual([FIXTURE_ANALYSIS_ID, "report", "thread-parent"]);
        }
    });

    test("neither listing widens to the archived rows", async () => {
        const { pool, calls } = recordingPool();
        (await realSessionSeams.listThreads(pool, FIXTURE_ANALYSIS_ID))._unsafeUnwrap();
        (await realSessionSeams.listReportChildren(pool, FIXTURE_ANALYSIS_ID, "thread-parent"))._unsafeUnwrap();
        for (const call of calls) expect(call.text).toContain("deleted_at IS NULL");
    });

    test("the launch listing asks the store for conversations", async () => {
        const { pool, calls } = recordingPool();
        (await realThreadSeams.listThreads(pool, FIXTURE_ANALYSIS_ID))._unsafeUnwrap();
        expect(calls).not.toHaveLength(0);
        for (const call of calls) {
            expect(call.text).toContain("thread_type = $2");
            expect(call.values.slice(0, 2)).toEqual([FIXTURE_ANALYSIS_ID, "conversation"]);
        }
    });
});
