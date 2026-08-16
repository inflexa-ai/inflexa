import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createMockMouse } from "@opentui/core/testing";
import { errAsync, okAsync } from "neverthrow";
import type { DbError, MessagePage, Pool, Thread } from "@inflexa-ai/harness";

import { reportThread, threadPageOf } from "../../test_support/threads.ts";
import { Chat, slotFor } from "./chat.tsx";
import { WorkspaceContext, type Workspace } from "../contexts/workspace.ts";
import { type CortexMsg, loadMessages, type LoadSeams, resetHotState } from "../hooks/conversation.ts";
import { __resetReportChildrenForTest, refreshReportChildren, type ReportChildrenSeams } from "../hooks/report_children.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { MessageRole } from "../../types/session.ts";

// Where a report entry SITS is the whole rule, and a position exists only as painted rows. A props
// assertion or a returned number proves that an arithmetic ran, not that the entry landed between the
// two turns that the reader expects it between. Thus this drives the real `Chat` over the real stores,
// and reads the order off one frame.
//
// One arm of the placement rule needs a LIVE append after the load, which a render over a seeded
// transcript cannot produce. Thus `slotFor` is exported and that arm is pinned as a unit below, while
// each arm the render does reach stays a frame assertion.

const SID = "thread-parent";
const AID = "a1";

// The seams read only `.pool` off the handle and the fakes ignore it, thus a partial stand-in cast keeps
// the case offline.
const fakePool = {} as unknown as Pool;
const fakeRuntime = { pool: fakePool } as unknown as HarnessRuntime;
const dbErr: DbError = { type: "query_failed", op: "test", cause: new Error("boom") };

// `Chat` reads `.id` for the transcript load and `.anchorId` for the welcome block. The anchor id names
// no row, thus the lookup resolves to null and the block renders nothing, which is correct with a
// transcript mounted.
const ANALYSIS = { id: AID, name: "Alpha", anchorId: "anchor-absent", projectId: null } as unknown as Analysis;

// What the entry's open bound, recorded so a click is assertable. Cleared between cases.
const opened: string[] = [];

const ws = {
    analysis: ANALYSIS,
    sessionId: SID,
    workingDir: "/work",
    project: null,
    openDialog: () => {},
    closeDialog: () => {},
    openSession: (threadId: string | null) => {
        if (threadId !== null) opened.push(threadId);
    },
    quit: async () => {},
} as unknown as Workspace;

// Six stored rows, one message each, paired as three turns: a request and then its reply. The pairing is
// the point — the placement rule targets the REPLY of the turn that crosses the spawn point, thus a
// fixture of bare assistant rows would never exercise it. The seq numbers start at 10 because the window
// mounts the newest turns alone, thus a spawn point under 10 names a turn that the transcript does not
// hold.
const ROWS = [
    { seq: 10, role: "user" },
    { seq: 11, role: "assistant" },
    { seq: 12, role: "user" },
    { seq: 13, role: "assistant" },
    { seq: 14, role: "user" },
    { seq: 15, role: "assistant" },
] as const;

/** Page reads and a replay that model the store: one row in, one message of that row's role out. */
function transcriptSeams(): LoadSeams {
    return {
        runtime: () => fakeRuntime,
        loadPage: () =>
            okAsync({
                messages: ROWS as unknown as MessagePage["messages"],
                total: ROWS.length,
                page: 0,
                perPage: 200,
                hasMore: false,
            }),
        toCortex: (rows) =>
            (rows as unknown as { seq: number; role: string }[]).map((r) => ({
                id: `id-${r.seq}`,
                role: r.role,
                parts: [{ type: "text", text: `${r.role} ${r.seq}` }],
            })) as unknown as CortexMsg[],
    };
}

/**
 * The report-children listing. `"unreadable"` is the degrade arm, where the read itself failed.
 *
 * A live page models the store in one more way: the store hides an archived row unless the listing is
 * widened, and this listing never widens it. Thus a case that is about an archived child hands back the
 * live rows alone, exactly as the real read does.
 */
function childrenSeams(page: Thread[] | "unreadable"): ReportChildrenSeams {
    return {
        runtime: () => fakeRuntime,
        listThreads: () => (page === "unreadable" ? errAsync(dbErr) : okAsync(threadPageOf(page))),
    };
}

/** The 0-based frame row that first paints `needle`. Fails the case when nothing painted it. */
function rowOf(frame: string, needle: string): number {
    const at = frame.split("\n").findIndex((line) => line.includes(needle));
    expect(at, `no row painted "${needle}"`).toBeGreaterThanOrEqual(0);
    return at;
}

/** The cell that `needle` starts at, as the mouse addresses it. */
function cellOf(frame: string, needle: string): { x: number; y: number } {
    const y = rowOf(frame, needle);
    return { x: frame.split("\n")[y]!.indexOf(needle), y };
}

/**
 * Mount the real `Chat`, seed the two stores it reads, and hand back one frame.
 *
 * The seeding comes AFTER the mount, and it must: `Chat` installs `watchReportChildren`, whose first
 * effect run reads through the production seams, and with no booted runtime that run clears the listing.
 * Anything seeded before the mount is wiped by it.
 *
 * The renderer is destroyed in a `finally`. An undisposed renderer outlives its case and corrupts every
 * later render suite in the same process.
 */
async function withChat<T>(
    children: Thread[] | "unreadable",
    body: (setup: Awaited<ReturnType<typeof testRender>>, frame: string) => Promise<T> | T,
): Promise<T> {
    const setup = await testRender(
        () => (
            <WorkspaceContext.Provider value={ws}>
                <box width="100%" height="100%">
                    <Chat onScrollPaneRef={() => {}} />
                </box>
            </WorkspaceContext.Provider>
        ),
        { width: 80, height: 40 },
    );
    try {
        await loadMessages(SID, AID, transcriptSeams());
        await refreshReportChildren(AID, SID, childrenSeams(children));
        // A message body paints through the async markdown renderable, thus one pass can catch the frame
        // before the bodies land. The turn headers and the entries are synchronous either way.
        for (let i = 0; i < 3; i++) {
            await Promise.sleep(20);
            await setup.renderOnce();
        }
        return await body(setup, setup.captureCharFrame());
    } finally {
        setup.renderer.destroy();
    }
}

/** One frame of the mounted transcript, for a case that reads the painted order alone. */
async function frameWith(children: Thread[] | "unreadable"): Promise<string> {
    return withChat(children, (_setup, frame) => frame);
}

describe("the report entries of a mounted transcript", () => {
    afterEach(() => {
        resetHotState();
        __resetReportChildrenForTest();
        opened.length = 0;
    });

    // The message headers carry a running number and paint synchronously, thus they are the stable
    // anchors for an ordering assertion. One turn is a request header and then a reply header, thus the
    // second turn of the fixture runs from `#3` to `#4`.
    const REQUEST_1 = "#1";
    const REPLY_1 = "#2";
    const REQUEST_2 = "#3";
    const REPLY_2 = "#4";
    const REQUEST_3 = "#5";
    const REPLY_3 = "#6";

    test("a reloaded transcript puts the entry after the reply of the turn that crosses the spawn point", async () => {
        // The spawn anchors at row 11, which is the reply of the FIRST turn: the second turn had not
        // appended its own rows when the spawn read the parent. To place the entry at that anchor paints
        // it above the request that asked for the report.
        const frame = await frameWith([reportThread({ threadId: "child-1", title: "Volcano report", parentThreadId: SID, parentSeq: 11 })]);

        expect(rowOf(frame, REQUEST_2)).toBeLessThan(rowOf(frame, "Volcano report"));
        expect(rowOf(frame, REPLY_2)).toBeLessThan(rowOf(frame, "Volcano report"));
        expect(rowOf(frame, "Volcano report")).toBeLessThan(rowOf(frame, REQUEST_3));
        // The entry names what it opens, because a title reads as a conversation title on its own.
        expect(frame).toContain("report session");
    });

    test("two children of one turn share the position, in the order that the listing gave them", async () => {
        // One turn can ask for two reports, and both spawns then anchor at the same row. The two entries
        // belong together under that turn's reply, and neither belongs at the tail.
        const frame = await frameWith([
            reportThread({ threadId: "child-1", title: "Volcano report", parentThreadId: SID, parentSeq: 11 }),
            reportThread({ threadId: "child-2", title: "Pathway report", parentThreadId: SID, parentSeq: 11 }),
        ]);

        expect(rowOf(frame, REPLY_2)).toBeLessThan(rowOf(frame, "Volcano report"));
        expect(rowOf(frame, "Volcano report")).toBeLessThan(rowOf(frame, "Pathway report"));
        expect(rowOf(frame, "Pathway report")).toBeLessThan(rowOf(frame, REQUEST_3));
    });

    test("a click on the entry opens that report session in place", async () => {
        // The entry is the only route into a report session that names the point of the spawn, thus a
        // click that binds nothing leaves the reader with a row that reads as a dead label.
        await withChat([reportThread({ threadId: "child-1", title: "Volcano report", parentThreadId: SID, parentSeq: 11 })], async (setup, frame) => {
            const at = cellOf(frame, "Volcano report");
            await createMockMouse(setup.renderer).pressDown(at.x, at.y);
            expect(opened).toEqual(["child-1"]);
        });
    });

    test("a spawn point past the loaded transcript puts the entry at the END", async () => {
        // The harness can cut a parent tail behind a spawn point, thus the entry must stay reachable.
        const frame = await frameWith([reportThread({ threadId: "child-1", title: "Volcano report", parentThreadId: SID, parentSeq: 99 })]);

        expect(rowOf(frame, REPLY_3)).toBeLessThan(rowOf(frame, "Volcano report"));
    });

    test("a spawn point below the mounted window puts the entry at the TOP", async () => {
        // The transcript mounts the newest turns alone, thus an old spawn point has no mounted message at
        // or below it. To drop the entry would hide a session that the conversation really spawned.
        const frame = await frameWith([reportThread({ threadId: "child-1", title: "Volcano report", parentThreadId: SID, parentSeq: 3 })]);

        expect(rowOf(frame, "Volcano report")).toBeLessThan(rowOf(frame, REQUEST_1));
    });

    test("a failed listing renders no entry, and the transcript stays whole", async () => {
        // The entries are an addition to the transcript, thus their absence costs the reader nothing. A
        // failed read must not take the conversation down with it.
        const frame = await frameWith("unreadable");

        expect(frame).not.toContain("report session");
        expect(rowOf(frame, REQUEST_1)).toBeLessThan(rowOf(frame, REPLY_1));
        expect(rowOf(frame, REPLY_1)).toBeLessThan(rowOf(frame, REQUEST_2));
    });

    test("an archived child leaves the surface, and each other child keeps its own position", async () => {
        // An archive stamps the whole subtree and the listing hides the stamped row, thus the entry goes
        // at the next refresh. What must NOT happen is a shift: the two survivors are placed from their
        // own spawn points, never from a position in the listing.
        const all = [
            reportThread({ threadId: "child-1", title: "Volcano report", parentThreadId: SID, parentSeq: 10 }),
            reportThread({ threadId: "child-2", title: "Pathway report", parentThreadId: SID, parentSeq: 11, deletedAt: new Date("2026-07-09T09:30:00.000Z") }),
            reportThread({ threadId: "child-3", title: "Enrichment report", parentThreadId: SID, parentSeq: 13 }),
        ];
        const frame = await frameWith(all.filter((t) => t.deletedAt === null));

        expect(frame).not.toContain("Pathway report");
        expect(rowOf(frame, REPLY_1)).toBeLessThan(rowOf(frame, "Volcano report"));
        expect(rowOf(frame, "Volcano report")).toBeLessThan(rowOf(frame, REQUEST_2));
        expect(rowOf(frame, REPLY_3)).toBeLessThan(rowOf(frame, "Enrichment report"));
    });
});

describe("slotFor — the arms a seeded render cannot reach", () => {
    // The marks describe the LOADED transcript. A live turn appends past them and mints none, thus a
    // mounted count larger than the marks is the state these cases are about. The four loaded rows pair
    // as two turns, a request and then its reply.
    const MARKS = [
        { seq: 10, afterMessageId: "m10" },
        { seq: 11, afterMessageId: "m11" },
        { seq: 12, afterMessageId: "m12" },
        { seq: 13, afterMessageId: "m13" },
    ];
    const LOADED = new Map([
        ["m10", 0],
        ["m11", 1],
        ["m12", 2],
        ["m13", 3],
    ]);
    const ROLES: MessageRole[] = ["user", "assistant", "user", "assistant"];
    const positionOf = (id: string): number | undefined => LOADED.get(id);
    const roleAt = (at: number): MessageRole | undefined => ROLES[at];
    // The two messages that a live turn appended past the loaded four.
    const MOUNTED = 6;

    test("a session the newest turn spawned lands BELOW that turn, and not at its spawn point", () => {
        // The spawn reads the parent before the turn that asked for it appends, thus the spawn point sits
        // under the request. To place the entry there paints it above the words that asked for the report.
        expect(slotFor(13, MARKS, positionOf, roleAt, MOUNTED)).toBe(MOUNTED);
    });

    test("a spawn point past the loaded transcript lands at the TRUE tail, not at the loaded end", () => {
        expect(slotFor(99, MARKS, positionOf, roleAt, MOUNTED)).toBe(MOUNTED);
    });

    test("a spawn point inside the transcript lands after the REPLY of the turn that crosses it", () => {
        // The first mark above the spawn point is the request of the second turn, at position 2. The reply
        // that answers it is at position 3, thus the entry takes position 4 and a later turn appends below
        // it rather than moving it.
        expect(slotFor(11, MARKS, positionOf, roleAt, MOUNTED)).toBe(4);
    });

    test("a crossing turn that has not answered yet puts the entry at the END", () => {
        // Nothing after the request is a reply, thus there is no position that sits below the request and
        // above a later turn. The tail is the one honest answer.
        expect(slotFor(11, MARKS, positionOf, () => "user", MOUNTED)).toBe(MOUNTED);
    });

    test("a crossing mark whose message left the window reads as a position below it", () => {
        // The trailing cap drops a message off the front as a live turn appends. The id then resolves to
        // nothing, which is the same answer as a spawn point older than the window.
        expect(slotFor(10, MARKS, () => undefined, roleAt, MOUNTED)).toBe(0);
    });

    test("a spawn point below every mark takes the TOP", () => {
        expect(slotFor(3, MARKS, positionOf, roleAt, MOUNTED)).toBe(0);
    });

    test("a row with no spawn point takes the tail, because it names no place", () => {
        expect(slotFor(null, MARKS, positionOf, roleAt, MOUNTED)).toBe(MOUNTED);
    });
});
