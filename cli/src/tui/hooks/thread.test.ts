import { afterEach, describe, expect, test } from "bun:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import type { DbError, Pool, Thread, ThreadPage } from "@inflexa-ai/harness";

import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Workspace } from "../contexts/workspace.ts";
import type { Notice } from "../theme.ts";
import type { Analysis } from "../../types/analysis.ts";
import { conversationThread, reportThread } from "../../test_support/threads.ts";
import { __resetBootForTest, __setBootStateForTest, type BootState } from "./boot.ts";
import { setChatStatus } from "./status.ts";
import { __resetOpenThreadForTest, openThread, refreshOpenThread, resolveThreadId, watchOpenThread, type ThreadSeams } from "./thread.ts";

// The open-thread store is a module singleton (one chat screen at a time) and so are the boot phase
// and the chat status the watch reads, so every case resets all three — otherwise an in-flight
// resolution, a bound snapshot, or a left-over `busy` leaks into the next test (the watch seeds its
// down-edge from the status live at mount).
afterEach(() => {
    __resetOpenThreadForTest();
    __resetBootForTest();
    setChatStatus("idle");
});

// The seams read only `.pool` off the handle and the fake listings ignore it, so a partial stand-in
// cast keeps every case offline (no Postgres, no booted runtime). Mirrors `sidebar_live.test.ts`.
const fakeRuntime = { pool: {} } as unknown as HarnessRuntime;
const dbErr: DbError = { type: "query_failed", op: "test", cause: new Error("boom") };

// The watch reads only `analysis.id`, so a partial stand-in cast is sound and keeps the fixture flat.
const ANALYSIS = { id: "analysis-alpha", name: "Alpha", projectId: null } as unknown as Analysis;
// A second analysis, so a case that swaps the open scope can tell "resolved the new one" apart from
// "resolved again".
const OTHER_ANALYSIS = { id: "analysis-beta", name: "Beta", projectId: null } as unknown as Analysis;

// UUIDv7 by construction: version nibble 7 and the RFC 4122 variant bits. `resolveThreadId` mints an
// identity whose VALUE is random, so a fresh mint can only be asserted by SHAPE — and the shape is
// what carries the time-sortable ordering the thread listing depends on.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function threadRow(over: Partial<Thread> = {}): Thread {
    return {
        threadId: "thread-1",
        analysisId: ANALYSIS.id,
        title: "Cohort survival questions",
        threadType: "conversation",
        parentThreadId: null,
        parentSeq: null,
        createdAt: new Date("2026-07-08T00:00:00.000Z"),
        updatedAt: new Date("2026-07-08T01:00:00.000Z"),
        // The resolver and the rail read only live rows, so the fixture carries no tombstone.
        deletedAt: null,
        ...over,
    };
}

function threadPage(threads: Thread[]): ThreadPage {
    return { threads, total: threads.length, page: 0, perPage: 20, hasMore: false };
}

/**
 * Seams plus recorders for every edge the resolution/read drives: the listing calls it saw (pool +
 * analysis id), the row reads, and the notices it raised.
 */
function makeSeams(over: Partial<ThreadSeams> = {}): {
    seams: ThreadSeams;
    listings: { pool: Pool; analysisId: string }[];
    reads: string[];
    notices: Notice[];
} {
    const listings: { pool: Pool; analysisId: string }[] = [];
    const reads: string[] = [];
    const notices: Notice[] = [];
    const base: ThreadSeams = {
        runtime: () => fakeRuntime,
        listThreads: (pool, analysisId) => {
            listings.push({ pool, analysisId });
            return okAsync(threadPage([]));
        },
        getThread: (_pool, threadId) => {
            reads.push(threadId);
            return okAsync(null);
        },
        notify: (n) => {
            notices.push(n);
        },
    };
    // A recording base with per-case overrides: an overridden `listThreads`/`getThread` records
    // nothing, so cases that assert call counts keep the base and vary only what it returns.
    return { seams: { ...base, ...over }, listings, reads, notices };
}

describe("resolveThreadId", () => {
    test("picks the most-recently-active thread from the listing page, minting nothing", async () => {
        // `listThreads` orders newest-updated first, so the head of the page IS the resume target; the
        // older row exists so "took the head" is distinguishable from "took whatever single row there was".
        const newest = threadRow({ threadId: "thread-newest", updatedAt: new Date("2026-07-08T09:00:00.000Z") });
        const older = threadRow({ threadId: "thread-older", updatedAt: new Date("2026-07-01T09:00:00.000Z") });
        const t = makeSeams({ listThreads: () => okAsync(threadPage([newest, older])) });

        expect(await resolveThreadId(ANALYSIS.id, t.seams)).toBe("thread-newest");
        expect(t.notices).toEqual([]); // a clean resume is silent
    });

    test("an empty page mints a fresh UUIDv7 identity and asks the store for this analysis", async () => {
        const t = makeSeams();
        const resolved = await resolveThreadId(ANALYSIS.id, t.seams);

        expect(resolved).toMatch(UUID_V7);
        // The listing is scoped to the open analysis and runs against the booted runtime's pool.
        expect(t.listings).toHaveLength(1);
        expect(t.listings[0]?.analysisId).toBe(ANALYSIS.id);
        expect(t.listings[0]?.pool).toBe(fakeRuntime.pool);
        // Minting an identity writes nothing — the row is the first turn's job.
        expect(t.notices).toEqual([]);
    });

    test("two empty-page resolutions mint DIFFERENT ids (an identity, not a constant)", async () => {
        const t = makeSeams();
        const first = await resolveThreadId(ANALYSIS.id, t.seams);
        const second = await resolveThreadId(ANALYSIS.id, t.seams);
        expect(first).not.toBe(second);
    });

    test("an unbooted runtime resolves to null and issues NO listing", async () => {
        const t = makeSeams({ runtime: () => null });
        expect(await resolveThreadId(ANALYSIS.id, t.seams)).toBeNull();
        expect(t.listings).toEqual([]);
    });

    test("a DbError degrades to a fresh mint plus a warn notice, never an error", async () => {
        const t = makeSeams({ listThreads: () => errAsync(dbErr) });
        const resolved = await resolveThreadId(ANALYSIS.id, t.seams);

        // The user still gets a working chat; the unread threads stay recoverable through the picker.
        expect(resolved).toMatch(UUID_V7);
        expect(t.notices).toHaveLength(1);
        expect(t.notices[0]?.kind).toBe("warn");
        expect(t.notices[0]?.text).toContain("new one");
    });

    // A report child rides the same activity clock as a conversation, so a child spawned a moment ago
    // sits at the head of an unnarrowed listing. The narrow itself lives in the real seam, which pushes
    // `type: "conversation"` into the query — the seam takes a pool and an analysis id and nothing else,
    // so an injected one cannot report the filter it applied. The fakes below therefore model the store:
    // the fixture is the analysis's WHOLE thread set and the seam answers with the narrowed slice of it,
    // the same faithful stand-in shape the page slicing in `conversation.test.ts` uses.
    const analysisThreads = (all: Thread[]): ThreadPage => threadPage(all.filter((t) => t.threadType === "conversation"));

    test("an analysis whose newest thread is a report child launches on the newest CONVERSATION", async () => {
        const child = reportThread({ analysisId: ANALYSIS.id, threadId: "thread-report-newest", updatedAt: new Date("2026-07-09T09:00:00.000Z") });
        const newest = conversationThread({ analysisId: ANALYSIS.id, threadId: "thread-newest", updatedAt: new Date("2026-07-08T09:00:00.000Z") });
        const older = conversationThread({ analysisId: ANALYSIS.id, threadId: "thread-older", updatedAt: new Date("2026-07-01T09:00:00.000Z") });
        const t = makeSeams({ listThreads: () => okAsync(analysisThreads([child, newest, older])) });

        // A launch that landed on the child would hand the first message the user types to the report
        // agent, in a chat that names itself the conversation.
        expect(await resolveThreadId(ANALYSIS.id, t.seams)).toBe("thread-newest");
        expect(t.notices).toEqual([]);
    });

    test("an analysis holding report children only starts a fresh conversation, never resumes one of them", async () => {
        const child = reportThread({ analysisId: ANALYSIS.id, threadId: "thread-report-only" });
        const t = makeSeams({ listThreads: () => okAsync(analysisThreads([child])) });

        const resolved = await resolveThreadId(ANALYSIS.id, t.seams);

        expect(resolved).toMatch(UUID_V7);
        expect(resolved).not.toBe(child.threadId);
    });
});

describe("refreshOpenThread — the snapshot ladder", () => {
    test("a live row loads, carrying the pg-owned title", async () => {
        const t = makeSeams({ getThread: () => okAsync(threadRow({ title: "Variant burden sweep" })) });
        await refreshOpenThread("thread-1", t.seams);

        const snap = openThread();
        expect(snap.kind).toBe("loaded");
        if (snap.kind === "loaded") expect(snap.thread.title).toBe("Variant burden sweep");
    });

    test("a bound id with no row is absent — a minted identity awaiting its first turn", async () => {
        const t = makeSeams();
        await refreshOpenThread("thread-1", t.seams);
        expect(openThread().kind).toBe("absent");
        expect(t.reads).toEqual(["thread-1"]);
    });

    test("a DbError degrades to unavailable, never a crash", async () => {
        const t = makeSeams({ getThread: () => errAsync(dbErr) });
        await refreshOpenThread("thread-1", t.seams);
        expect(openThread().kind).toBe("unavailable");
    });

    test("a null thread id resets to unresolved and issues no query", async () => {
        const loadedSeams = makeSeams({ getThread: () => okAsync(threadRow()) });
        await refreshOpenThread("thread-1", loadedSeams.seams);
        expect(openThread().kind).toBe("loaded");

        const t = makeSeams();
        await refreshOpenThread(null, t.seams);
        expect(openThread().kind).toBe("unresolved");
        expect(t.reads).toEqual([]);
    });

    test("an unbooted runtime resets to unresolved and issues no query", async () => {
        const t = makeSeams({ runtime: () => null });
        await refreshOpenThread("thread-1", t.seams);
        expect(openThread().kind).toBe("unresolved");
        expect(t.reads).toEqual([]);
    });

    test("an older read that lands LAST does not clobber the newer one", async () => {
        // A rapid session swap interleaves the row reads and the OLDER can resolve last; the generation
        // token must make the newest read STARTED win.
        let releaseOld!: () => void;
        const oldGate = new Promise<void>((r) => {
            releaseOld = r;
        });
        const oldSeams = makeSeams({
            getThread: () => ResultAsync.fromSafePromise(oldGate.then(() => threadRow({ threadId: "thread-old", title: "Older thread" }))),
        });
        const newSeams = makeSeams({ getThread: () => okAsync(threadRow({ threadId: "thread-new", title: "Newer thread" })) });

        const oldRead = refreshOpenThread("thread-old", oldSeams.seams); // parks on its gate
        await refreshOpenThread("thread-new", newSeams.seams); // starts later, settles first

        releaseOld();
        await oldRead;

        const snap = openThread();
        expect(snap.kind).toBe("loaded");
        if (snap.kind === "loaded") expect(snap.thread.title).toBe("Newer thread");
    });

    test("a read for a DIFFERENT thread blanks the rail synchronously, before the new row lands", async () => {
        // The read is a full pg round-trip. Without a synchronous reset the SESSION rail would keep
        // painting the thread the user swapped (or deleted) away from for that entire window.
        const loaded = makeSeams({ getThread: () => okAsync(threadRow({ threadId: "thread-a", title: "Alpha conversation" })) });
        await refreshOpenThread("thread-a", loaded.seams);
        expect(openThread().kind).toBe("loaded");

        let releaseNext!: () => void;
        const gate = new Promise<void>((r) => {
            releaseNext = r;
        });
        const gated = makeSeams({
            getThread: () => ResultAsync.fromSafePromise(gate.then(() => threadRow({ threadId: "thread-b", title: "Beta conversation" }))),
        });

        const pending = refreshOpenThread("thread-b", gated.seams);
        // Deliberately NOT awaited: the reset has to land in the same turn the swap is requested.
        expect(openThread().kind).toBe("unresolved");

        releaseNext();
        await pending;
        const snap = openThread();
        expect(snap.kind).toBe("loaded");
        if (snap.kind === "loaded") expect(snap.thread.title).toBe("Beta conversation");
    });

    test("a re-read of the SAME thread leaves the loaded row standing — no placeholder flicker", async () => {
        // The rename poke and the post-turn re-read both target the bound thread; blanking there would
        // flash "runtime not ready" over a row that is still correct.
        const loaded = makeSeams({ getThread: () => okAsync(threadRow({ threadId: "thread-a", title: "Alpha conversation" })) });
        await refreshOpenThread("thread-a", loaded.seams);

        let releaseRename!: () => void;
        const gate = new Promise<void>((r) => {
            releaseRename = r;
        });
        const gated = makeSeams({
            getThread: () => ResultAsync.fromSafePromise(gate.then(() => threadRow({ threadId: "thread-a", title: "Renamed conversation" }))),
        });

        const pending = refreshOpenThread("thread-a", gated.seams);
        const during = openThread();
        expect(during.kind).toBe("loaded");
        if (during.kind === "loaded") expect(during.thread.title).toBe("Alpha conversation");

        releaseRename();
        await pending;
        const after = openThread();
        expect(after.kind).toBe("loaded");
        if (after.kind === "loaded") expect(after.thread.title).toBe("Renamed conversation");
    });

    // The report child and the conversation it was spawned from. The refresh reads BOTH through the one
    // `getThread` seam, so a fake that ignored the id could answer the parent read with the child row
    // and still look correct — every case below drives an id-keyed table for that reason.
    const PARENT = threadRow({ threadId: "thread-parent", title: "Cohort survival questions" });
    const CHILD = reportThread({ analysisId: ANALYSIS.id, threadId: "thread-report", parentThreadId: PARENT.threadId });

    /** A `getThread` seam over a fixed row set, keyed by thread id as the store keys it, recording each read. */
    function rowsByThreadId(rows: Thread[], reads: string[]): ThreadSeams["getThread"] {
        const table = new Map(rows.map((r) => [r.threadId, r]));
        return (_pool, threadId) => {
            reads.push(threadId);
            return okAsync(table.get(threadId) ?? null);
        };
    }

    test("a report child carries the conversation it was spawned from", async () => {
        const reads: string[] = [];
        const t = makeSeams({ getThread: rowsByThreadId([CHILD, PARENT], reads) });
        await refreshOpenThread(CHILD.threadId, t.seams);

        const snap = openThread();
        expect(snap.kind).toBe("loaded");
        if (snap.kind === "loaded") {
            expect(snap.thread.threadId).toBe(CHILD.threadId);
            expect(snap.parent).toEqual({ threadId: PARENT.threadId, title: PARENT.title });
        }
        // The second read is by the PARENT's id, so a lookup aimed at the wrong row cannot pass here.
        expect(reads).toEqual([CHILD.threadId, PARENT.threadId]);
    });

    test("a conversation issues no second read at all", async () => {
        const reads: string[] = [];
        const t = makeSeams({ getThread: rowsByThreadId([PARENT], reads) });
        await refreshOpenThread(PARENT.threadId, t.seams);

        const snap = openThread();
        expect(snap.kind).toBe("loaded");
        if (snap.kind === "loaded") expect(snap.parent).toBeUndefined();
        expect(reads).toEqual([PARENT.threadId]);
    });

    test("a report row whose parent link is gone reads no parent", async () => {
        // The store writes the link and the spawn point together, so a row carrying neither names
        // nothing to read — and the rail renders the kind alone rather than waiting on a query.
        const reads: string[] = [];
        const orphan = reportThread({ analysisId: ANALYSIS.id, threadId: "thread-orphan", parentThreadId: null, parentSeq: null });
        const t = makeSeams({ getThread: rowsByThreadId([orphan], reads) });
        await refreshOpenThread(orphan.threadId, t.seams);

        const snap = openThread();
        expect(snap.kind).toBe("loaded");
        if (snap.kind === "loaded") expect(snap.parent).toBeUndefined();
        expect(reads).toEqual([orphan.threadId]);
    });

    test("a failed parent read keeps the loaded row and leaves the parent empty", async () => {
        // Which session is open stays true whether or not its parent resolved, so a blinking Postgres
        // must cost the context line and nothing else.
        const t = makeSeams({ getThread: (_pool, threadId) => (threadId === CHILD.threadId ? okAsync(CHILD) : errAsync(dbErr)) });
        await refreshOpenThread(CHILD.threadId, t.seams);

        const snap = openThread();
        expect(snap.kind).toBe("loaded");
        if (snap.kind === "loaded") {
            expect(snap.thread.threadId).toBe(CHILD.threadId);
            expect(snap.parent).toBeUndefined();
        }
    });

    test("a parent that resolves to no row keeps the loaded row", async () => {
        // A normal state, never a fault: the read hides an archived row, and another instance can move
        // a thread the scope still names.
        const reads: string[] = [];
        const t = makeSeams({ getThread: rowsByThreadId([CHILD], reads) });
        await refreshOpenThread(CHILD.threadId, t.seams);

        const snap = openThread();
        expect(snap.kind).toBe("loaded");
        if (snap.kind === "loaded") expect(snap.parent).toBeUndefined();
        expect(reads).toEqual([CHILD.threadId, PARENT.threadId]);
    });

    test("the loaded row lands BEFORE the parent read settles", async () => {
        // The parent is a second round trip. Holding the row until it lands would blank the rail for
        // that whole window; publishing first gives a titleless kind line and then fills it in.
        let releaseParent!: () => void;
        const gate = new Promise<void>((r) => {
            releaseParent = r;
        });
        const t = makeSeams({
            getThread: (_pool, threadId) => (threadId === CHILD.threadId ? okAsync(CHILD) : ResultAsync.fromSafePromise(gate.then(() => PARENT))),
        });

        const pending = refreshOpenThread(CHILD.threadId, t.seams);
        await settle();
        const during = openThread();
        expect(during.kind).toBe("loaded");
        if (during.kind === "loaded") expect(during.parent).toBeUndefined();

        releaseParent();
        await pending;
        const after = openThread();
        expect(after.kind).toBe("loaded");
        if (after.kind === "loaded") expect(after.parent?.title).toBe(PARENT.title);
    });

    test("a re-read of the SAME thread keeps the parent across the round trip", async () => {
        // The post-turn refresh and the rename poke both re-read a thread the snapshot already
        // describes. Dropping the parent until the second read lands would blank the rail's context
        // line on every turn — the blink the same-id rule keeps off the row itself.
        const settled = makeSeams({ getThread: rowsByThreadId([CHILD, PARENT], []) });
        await refreshOpenThread(CHILD.threadId, settled.seams);

        let releaseParent!: () => void;
        const gate = new Promise<void>((r) => {
            releaseParent = r;
        });
        const again = makeSeams({
            getThread: (_pool, threadId) => (threadId === CHILD.threadId ? okAsync(CHILD) : ResultAsync.fromSafePromise(gate.then(() => PARENT))),
        });
        const pending = refreshOpenThread(CHILD.threadId, again.seams);
        await settle();

        const during = openThread();
        expect(during.kind).toBe("loaded");
        if (during.kind === "loaded") expect(during.parent?.title).toBe(PARENT.title);

        releaseParent();
        await pending;
    });

    test("a row that left its parent drops the carried one rather than naming the conversation it left", async () => {
        // The carry is keyed on the link the FRESH row states, so a re-read that finds the child under
        // a different parent — or under none — never describes it by the one it no longer belongs to.
        const settled = makeSeams({ getThread: rowsByThreadId([CHILD, PARENT], []) });
        await refreshOpenThread(CHILD.threadId, settled.seams);

        const orphaned = { ...CHILD, parentThreadId: null, parentSeq: null };
        const after = makeSeams({ getThread: rowsByThreadId([orphaned], []) });
        await refreshOpenThread(CHILD.threadId, after.seams);

        const snap = openThread();
        expect(snap.kind).toBe("loaded");
        if (snap.kind === "loaded") expect(snap.parent).toBeUndefined();
    });

    test("a swap during the parent read discards that parent, exactly as it discards a row", async () => {
        // Both writes ride one generation token, so the newest refresh STARTED still wins — otherwise a
        // slow parent would land on the conversation the user swapped to and name it a report.
        let releaseParent!: () => void;
        const gate = new Promise<void>((r) => {
            releaseParent = r;
        });
        const stale = makeSeams({
            getThread: (_pool, threadId) => (threadId === CHILD.threadId ? okAsync(CHILD) : ResultAsync.fromSafePromise(gate.then(() => PARENT))),
        });

        const pending = refreshOpenThread(CHILD.threadId, stale.seams);
        await settle(); // the child row has landed; the parent read is parked on its gate

        const next = makeSeams({ getThread: () => okAsync(threadRow({ threadId: "thread-next", title: "Newer conversation" })) });
        await refreshOpenThread("thread-next", next.seams);

        releaseParent();
        await pending;

        const snap = openThread();
        expect(snap.kind).toBe("loaded");
        if (snap.kind === "loaded") {
            expect(snap.thread.threadId).toBe("thread-next");
            expect(snap.parent).toBeUndefined();
        }
    });

    test("a swap to an unbound scope is not later overwritten by the previous scope's slow read", async () => {
        // The unresolved path bumps the generation BEFORE its guards, so an in-flight older read that
        // resolves afterwards cannot repaint the rail with the thread the user just swapped away from.
        let releaseOld!: () => void;
        const oldGate = new Promise<void>((r) => {
            releaseOld = r;
        });
        const oldSeams = makeSeams({ getThread: () => ResultAsync.fromSafePromise(oldGate.then(() => threadRow({ title: "Swapped away" }))) });

        const oldRead = refreshOpenThread("thread-old", oldSeams.seams);
        await refreshOpenThread(null, makeSeams().seams);
        expect(openThread().kind).toBe("unresolved");

        releaseOld();
        await oldRead;
        expect(openThread().kind).toBe("unresolved");
    });
});

// The thread id the workspace scope carries, plus the analysis it belongs to — the only fields
// `watchOpenThread` reads or writes. A real `createStore` (not a plain object) so the bind effect
// re-runs when the scope changes, exactly as the live workspace store drives it.
type ScopeStore = {
    analysis: Analysis | null;
    sessionId: string | null;
    workingDir: string;
    openSession: Workspace["openSession"];
};

/**
 * A reactive workspace stand-in whose `openSession` writes the scope and records the bound ids.
 *
 * `setAnalysis` writes the analysis WITHOUT binding a thread — a state production never reaches
 * (every `openSession` under `ready` carries a non-null id), so it exists only to drive the watch's
 * in-flight marker into the interleaving that invariant currently rules out.
 */
function reactiveWorkspace(
    analysis: Analysis | null,
    sessionId: string | null,
): { ws: Workspace; bound: (string | null)[]; setAnalysis: (next: Analysis) => void } {
    const bound: (string | null)[] = [];
    // The method references `setStore` from this destructuring — created now, invoked only later, the
    // same shape `createWorkspace` uses for its sole scope writer.
    const [store, setStore] = createStore<ScopeStore>({
        analysis,
        sessionId,
        workingDir: "/work",
        openSession(threadId, workingDir, next) {
            bound.push(threadId);
            setStore({ analysis: next, sessionId: threadId, workingDir });
        },
    });
    // The watch reads `analysis`/`sessionId` and calls `openSession`; the rest of `Workspace` is
    // dialog/quit capability it never touches, so a partial stand-in cast is sound.
    return { ws: store as unknown as Workspace, bound, setAnalysis: (next) => setStore({ analysis: next }) };
}

/** Mount `watchOpenThread` in a disposable reactive root; returns the dispose so the test tears it down. */
function mountWatch(ws: Workspace, seams: ThreadSeams): () => void {
    let dispose!: () => void;
    createRoot((d) => {
        dispose = d;
        watchOpenThread(ws, seams);
    });
    return dispose;
}

/** Let the ready-edge resolution's promise chain settle (the effect returns before its listing resolves). */
async function settle(): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, 0));
}

/** A fresh `ready` boot state — a NEW object each call, so re-seeding it is an observable signal edge. */
function ready(): BootState {
    return { phase: "ready", model: "claude-test", connection: { provider: "anthropic", mode: "cliproxy" } };
}

describe("watchOpenThread — the ready-edge bind", () => {
    test("ready + an open analysis + no bound thread resolves exactly once into the scope", async () => {
        const t = makeSeams({ listThreads: () => okAsync(threadPage([threadRow({ threadId: "thread-resumed" })])) });
        const w = reactiveWorkspace(ANALYSIS, null);
        const dispose = mountWatch(w.ws, t.seams);
        try {
            expect(w.bound).toEqual([]); // boot idle at mount → nothing resolved

            __setBootStateForTest(ready());
            await settle();

            expect(w.bound).toEqual(["thread-resumed"]);
            expect(w.ws.sessionId).toBe("thread-resumed");
        } finally {
            dispose();
        }
    });

    test("a thread already bound at the ready edge is left alone — no listing is even issued", async () => {
        const t = makeSeams({ listThreads: () => okAsync(threadPage([threadRow({ threadId: "thread-from-store" })])) });
        const w = reactiveWorkspace(ANALYSIS, "thread-palette-bound");
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();

            expect(w.bound).toEqual([]);
            expect(w.ws.sessionId).toBe("thread-palette-bound");
        } finally {
            dispose();
        }
    });

    test("a thread bound WHILE the resolution is in flight is not overwritten by it", async () => {
        // The listing is a Postgres round-trip; a palette swap can bind a thread inside that window, and
        // writing the stale resolution on top would swap the user off the chat they just opened.
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const t = makeSeams({
            listThreads: () => ResultAsync.fromSafePromise(gate.then(() => threadPage([threadRow({ threadId: "thread-stale" })]))),
        });
        const w = reactiveWorkspace(ANALYSIS, null);
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(w.ws.sessionId).toBeNull(); // still parked on the gated listing

            w.ws.openSession("thread-palette-bound", "/work", ANALYSIS); // the palette binds its own

            release();
            await settle();

            expect(w.ws.sessionId).toBe("thread-palette-bound");
            expect(w.bound).toEqual(["thread-palette-bound"]); // the stale resolution never landed
        } finally {
            dispose();
        }
    });

    test("a ready flap during the resolution does not start a second one", async () => {
        // Two concurrent resolutions would each mint, and the loser's id would be silently replaced.
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        let listings = 0;
        const t = makeSeams({
            listThreads: () => {
                listings += 1;
                return ResultAsync.fromSafePromise(gate.then(() => threadPage([threadRow({ threadId: "thread-once" })])));
            },
        });
        const w = reactiveWorkspace(ANALYSIS, null);
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(listings).toBe(1);

            __setBootStateForTest({ phase: "booting" });
            __setBootStateForTest(ready());
            await settle();
            expect(listings).toBe(1); // the in-flight marker swallowed the flap

            release();
            await settle();

            expect(w.bound).toEqual(["thread-once"]);
        } finally {
            dispose();
        }
    });

    test("a settling resolution releases only its OWN in-flight marker", async () => {
        // The marker is a single slot. An unconditional clear would let analysis A's resolution drop a
        // marker a later effect run had re-taken for B, and B could then resolve twice — two mints
        // racing, the loser's id silently replaced. Production cannot reach this interleaving (the scope
        // is never left unbound while `ready`, because the runtime handle is set before the phase flips),
        // but that invariant lives in `hooks/boot.ts`, so the guard is pinned here rather than inherited.
        const gates = new Map<string, () => void>();
        const listed: string[] = [];
        const t = makeSeams({
            listThreads: (_pool, analysisId) => {
                listed.push(analysisId);
                return ResultAsync.fromSafePromise(
                    new Promise<void>((r) => gates.set(analysisId, r)).then(() => threadPage([threadRow({ threadId: `thread-${analysisId}` })])),
                );
            },
        });
        const w = reactiveWorkspace(ANALYSIS, null);
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(listed).toEqual([ANALYSIS.id]);

            // The open analysis changes before its listing lands, with no thread bound — so the effect
            // re-fires and the marker is re-taken for the new analysis.
            w.setAnalysis(OTHER_ANALYSIS);
            await settle();
            expect(listed).toEqual([ANALYSIS.id, OTHER_ANALYSIS.id]);

            gates.get(ANALYSIS.id)!(); // the stale resolution settles
            await settle();

            // Any repaint while the live resolution is still in flight must find the marker intact.
            __setBootStateForTest({ phase: "booting" });
            __setBootStateForTest(ready());
            await settle();
            expect(listed).toEqual([ANALYSIS.id, OTHER_ANALYSIS.id]);

            gates.get(OTHER_ANALYSIS.id)!();
            await settle();
            expect(w.bound).toEqual([`thread-${OTHER_ANALYSIS.id}`]);
        } finally {
            dispose();
        }
    });

    test("a resolution that THROWS does not wedge the analysis — the next ready edge tries again", async () => {
        // The store's expected failures ride the Result channel, so a rejection is an unexpected throw
        // out of it. The in-flight marker must still clear: were it left set, every later ready edge
        // would read this analysis as already resolving and skip, stranding the chat unbound forever.
        let attempts = 0;
        const t = makeSeams({
            listThreads: () => {
                attempts += 1;
                return attempts === 1
                    ? ResultAsync.fromSafePromise<ThreadPage, DbError>(Promise.reject(new Error("the pool blew up")))
                    : okAsync(threadPage([threadRow({ threadId: "thread-second-try" })]));
            },
        });
        const w = reactiveWorkspace(ANALYSIS, null);
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(attempts).toBe(1);
            expect(w.bound).toEqual([]); // nothing to bind — the throw carried no id

            __setBootStateForTest({ phase: "booting" });
            __setBootStateForTest(ready());
            await settle();

            expect(attempts).toBe(2);
            expect(w.bound).toEqual(["thread-second-try"]);
        } finally {
            dispose();
        }
    });

    test("ready with no analysis open binds nothing", async () => {
        const t = makeSeams({ listThreads: () => okAsync(threadPage([threadRow()])) });
        const w = reactiveWorkspace(null, null);
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(w.bound).toEqual([]);
            expect(t.listings).toEqual([]);
        } finally {
            dispose();
        }
    });

    test("a null resolution (no pool behind the ready phase) leaves the scope unbound", async () => {
        const t = makeSeams({ runtime: () => null });
        const w = reactiveWorkspace(ANALYSIS, null);
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(w.bound).toEqual([]);
            expect(w.ws.sessionId).toBeNull();
        } finally {
            dispose();
        }
    });
});

describe("watchOpenThread — the row tracker", () => {
    test("the bound thread's row lands in the snapshot once boot is ready", async () => {
        const t = makeSeams({
            listThreads: () => okAsync(threadPage([threadRow({ threadId: "thread-resumed", title: "Pathway enrichment" })])),
            getThread: () => okAsync(threadRow({ threadId: "thread-resumed", title: "Pathway enrichment" })),
        });
        const w = reactiveWorkspace(ANALYSIS, null);
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();

            const snap = openThread();
            expect(snap.kind).toBe("loaded");
            if (snap.kind === "loaded") expect(snap.thread.title).toBe("Pathway enrichment");
        } finally {
            dispose();
        }
    });

    test("a completed turn re-reads the row, so the row the FIRST turn created reaches the rail", async () => {
        // The first turn creates the row (and seeds its title from the message) under an unchanged bound
        // id and boot phase — no other edge fires — so without the turn-completion re-read the SESSION
        // section would read "new conversation" for the rest of the session.
        let row: Thread | null = null;
        const t = makeSeams({ getThread: () => okAsync(row) });
        const w = reactiveWorkspace(ANALYSIS, "thread-1");
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(openThread().kind).toBe("absent"); // the identity is bound; its row does not exist yet

            row = threadRow({ threadId: "thread-1", title: "Kinase inhibitor screen" });
            setChatStatus("busy");
            setChatStatus("idle");
            await settle();

            const snap = openThread();
            expect(snap.kind).toBe("loaded");
            if (snap.kind === "loaded") expect(snap.thread.title).toBe("Kinase inhibitor screen");
        } finally {
            dispose();
        }
    });

    test("a turn that FAILS still re-reads: the row it created is the one the rail is missing", async () => {
        // The thread row and its title are written up front, before the agent runs, so a turn that fails
        // afterwards has still created exactly what this refresh collects — and it settles on `error`,
        // never `idle`. Keying the edge on `idle` alone leaves a chat whose FIRST turn failed reading
        // "new conversation" for the rest of the session, with a real titled row sitting in Postgres.
        // An overridden `getThread` records nothing in the base recorder, so count here.
        let reads = 0;
        const t = makeSeams({
            getThread: () => {
                reads += 1;
                return okAsync(threadRow({ title: "Seeded by the failed turn" }));
            },
        });
        const w = reactiveWorkspace(ANALYSIS, "thread-1");
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            const afterBind = reads;
            expect(afterBind).toBeGreaterThan(0);

            setChatStatus("busy");
            setChatStatus("error");
            await settle();

            expect(reads).toBe(afterBind + 1);
            const snap = openThread();
            expect(snap.kind).toBe("loaded");
            if (snap.kind === "loaded") expect(snap.thread.title).toBe("Seeded by the failed turn");
        } finally {
            dispose();
        }
    });

    test("only the busy→idle DOWN-edge re-reads, and only with a thread bound", async () => {
        let reads = 0;
        const t = makeSeams({
            getThread: () => {
                reads += 1;
                return okAsync(threadRow());
            },
        });
        // No analysis in scope, so the ready edge binds nothing and the scope stays genuinely unbound.
        const w = reactiveWorkspace(null, null);
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(reads).toBe(0);

            // Unbound scope: a finished turn has no row to read, so the edge must issue no query.
            setChatStatus("busy");
            setChatStatus("idle");
            await settle();
            expect(reads).toBe(0);

            w.ws.openSession("thread-1", "/work", ANALYSIS);
            await settle();
            const afterBind = reads;
            expect(afterBind).toBeGreaterThan(0);

            // The rising edge is not a completion — the turn's writes have not happened yet.
            setChatStatus("busy");
            await settle();
            expect(reads).toBe(afterBind);
        } finally {
            dispose();
        }
    });

    test("dropping back out of ready collapses the snapshot rather than showing a stale row", async () => {
        const t = makeSeams({ getThread: () => okAsync(threadRow({ title: "Pathway enrichment" })) });
        const w = reactiveWorkspace(ANALYSIS, "thread-1");
        const dispose = mountWatch(w.ws, t.seams);
        try {
            __setBootStateForTest(ready());
            await settle();
            expect(openThread().kind).toBe("loaded");

            // Pre-`ready` there is no pool to read the row from, so the rail must fall back to its
            // placeholder rather than keep a previous boot's metadata on screen.
            __setBootStateForTest({ phase: "failed", message: "postgres unreachable" });
            await settle();
            expect(openThread().kind).toBe("unresolved");
        } finally {
            dispose();
        }
    });
});
