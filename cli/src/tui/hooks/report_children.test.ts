import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { errAsync, okAsync } from "neverthrow";
import type { Pool, Thread } from "@inflexa-ai/harness";

import { reportThread, threadPageOf, FIXTURE_ANALYSIS_ID } from "../../test_support/threads.ts";
import { __setBootStateForTest, type BootState } from "./boot.ts";
import { __resetReportChildrenForTest, reportChildren, watchReportChildren, type ReportChildrenSeams } from "./report_children.ts";
import { setChatStatus } from "./status.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Workspace } from "../contexts/workspace.ts";
import type { Analysis } from "../../types/analysis.ts";

// Two edges write this listing, and the second one is the whole reason it exists as a watch rather than
// a read at the render: a turn is what spawns a report session, and the open scope does not move when it
// does. Each case here drives one of the two edges and reads the listing that landed.

const ANALYSIS = { id: FIXTURE_ANALYSIS_ID, name: "Alpha", projectId: null } as unknown as Analysis;
const fakeRuntime = { pool: {} as unknown as Pool } as unknown as HarnessRuntime;

/** A NEW object each call, thus re-seeding the phase is an observable signal edge. */
function ready(): BootState {
    return { phase: "ready", model: "claude-test", connection: { provider: "anthropic", mode: "cliproxy" } };
}

/** The scope fields the watch tracks, as a store so a swap is an observable edge. */
function scope(analysis: Analysis | null, sessionId: string | null): { ws: Workspace; bindTo: (next: string | null) => void } {
    const [store, setStore] = createStore({ analysis, sessionId, workingDir: "/work" });
    // The watch reads `analysis` and `sessionId` alone, thus a partial stand-in cast is sound.
    return { ws: store as unknown as Workspace, bindTo: (next) => setStore({ sessionId: next }) };
}

/** Mount the watch in a disposable root, and hand back the dispose. */
function mount(ws: Workspace, seams: ReportChildrenSeams): () => void {
    let dispose!: () => void;
    createRoot((d) => {
        dispose = d;
        watchReportChildren(ws, seams);
    });
    return dispose;
}

/** Let a refresh promise resolve — the effect returns before its listing does. */
async function settle(): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, 0));
}

describe("watchReportChildren", () => {
    afterEach(() => {
        __setBootStateForTest({ phase: "idle" });
        setChatStatus("idle");
        __resetReportChildrenForTest();
    });

    test("a settled turn re-reads, so a session the turn spawned reaches the transcript", async () => {
        // A spawn writes its row under an UNCHANGED bound thread and boot phase. Without this edge the
        // user would ask for a report, watch the turn finish, and find no entry until they left the
        // conversation and came back.
        let rows: Thread[] = [];
        const seams: ReportChildrenSeams = { runtime: () => fakeRuntime, listThreads: () => okAsync(threadPageOf(rows)) };
        const w = scope(ANALYSIS, "thread-parent");
        const dispose = mount(w.ws, seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(reportChildren()).toEqual([]);

            rows = [reportThread({ threadId: "child-1", parentThreadId: "thread-parent" })];
            setChatStatus("busy");
            setChatStatus("idle");
            await settle();

            expect(reportChildren().map((t) => t.threadId)).toEqual(["child-1"]);
        } finally {
            dispose();
        }
    });

    test("a turn that FAILS still re-reads, because the spawn wrote its row before the failure", async () => {
        // Leaving `busy` is the edge, and not reaching `idle`. To key on `idle` would drop the entry of a
        // session whose own turn died after the spawn.
        let rows: Thread[] = [];
        const seams: ReportChildrenSeams = { runtime: () => fakeRuntime, listThreads: () => okAsync(threadPageOf(rows)) };
        const w = scope(ANALYSIS, "thread-parent");
        const dispose = mount(w.ws, seams);
        try {
            __setBootStateForTest(ready());
            await settle();

            rows = [reportThread({ threadId: "child-1", parentThreadId: "thread-parent" })];
            setChatStatus("busy");
            setChatStatus("error");
            await settle();

            expect(reportChildren().map((t) => t.threadId)).toEqual(["child-1"]);
        } finally {
            dispose();
        }
    });

    test("binding a different thread reads that thread's children", async () => {
        const byParent = new Map<string, Thread[]>([
            ["thread-parent", [reportThread({ threadId: "child-1", parentThreadId: "thread-parent" })]],
            ["thread-other", [reportThread({ threadId: "child-2", parentThreadId: "thread-other" })]],
        ]);
        const seams: ReportChildrenSeams = {
            runtime: () => fakeRuntime,
            listThreads: (_pool, _analysisId, parentThreadId) => okAsync(threadPageOf(byParent.get(parentThreadId) ?? [])),
        };
        const w = scope(ANALYSIS, "thread-parent");
        const dispose = mount(w.ws, seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(reportChildren().map((t) => t.threadId)).toEqual(["child-1"]);

            w.bindTo("thread-other");
            // Empty BEFORE the query lands. The transcript resets synchronously at a swap, thus rows held
            // across the round trip would paint over the transcript of the thread the user just opened.
            expect(reportChildren()).toEqual([]);
            await settle();

            expect(reportChildren().map((t) => t.threadId)).toEqual(["child-2"]);
        } finally {
            dispose();
        }
    });

    test("a settled turn keeps the rows on screen while it re-reads them", async () => {
        // The clear is for a swap alone. To blank the entries on each turn would flash them out and back
        // under a reader who never left the conversation.
        const rows = [reportThread({ threadId: "child-1", parentThreadId: "thread-parent" })];
        const seams: ReportChildrenSeams = { runtime: () => fakeRuntime, listThreads: () => okAsync(threadPageOf(rows)) };
        const w = scope(ANALYSIS, "thread-parent");
        const dispose = mount(w.ws, seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(reportChildren().map((t) => t.threadId)).toEqual(["child-1"]);

            setChatStatus("busy");
            setChatStatus("idle");
            expect(reportChildren().map((t) => t.threadId)).toEqual(["child-1"]);
        } finally {
            dispose();
        }
    });

    test("a failed listing degrades to no children and raises no notice", async () => {
        // The entries are an addition to the transcript, thus their absence costs the reader nothing. A
        // toast for each failed read would interrupt the conversation over a surface that carries no
        // message.
        const seams: ReportChildrenSeams = {
            runtime: () => fakeRuntime,
            listThreads: () => errAsync({ type: "query_failed", op: "test", cause: new Error("boom") }),
        };
        const w = scope(ANALYSIS, "thread-parent");
        const dispose = mount(w.ws, seams);
        try {
            __setBootStateForTest(ready());
            await settle();

            expect(reportChildren()).toEqual([]);
        } finally {
            dispose();
        }
    });

    test("before ready the listing stays empty, because no pool answers it", async () => {
        const seams: ReportChildrenSeams = {
            runtime: () => null,
            listThreads: () => okAsync(threadPageOf([reportThread({ parentThreadId: "thread-parent" })])),
        };
        const w = scope(ANALYSIS, "thread-parent");
        const dispose = mount(w.ws, seams);
        try {
            await settle();

            expect(reportChildren()).toEqual([]);
        } finally {
            dispose();
        }
    });
});
