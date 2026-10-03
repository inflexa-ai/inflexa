import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createMockMouse } from "@opentui/core/testing";
import { errAsync, okAsync } from "neverthrow";
import type { ChatMessage } from "@inflexa-ai/harness/contracts/index.js";

import type { ThreadSummary } from "../../api/conversation.ts";
import type { ClientError } from "../../client/api.ts";
import { reportSummary, threadListOf } from "../../test_support/threads.ts";
import { Chat } from "./chat.tsx";
import { WorkspaceContext, type Workspace } from "../contexts/workspace.ts";
import { loadMessages, type LoadOpts, resetHotState, setError } from "../hooks/conversation.ts";
import { __resetReportChildrenForTest, refreshReportChildren, type ReportChildrenOpts } from "../hooks/report_children.ts";
import type { Analysis } from "../../types/analysis.ts";

// Where a report entry SITS is the whole rule, and a position exists only as painted rows. A props
// assertion proves that a mapping ran, not that the entry landed where the reader expects it. Thus this
// drives the real `Chat` over the real stores, and reads the order off one frame.
//
// The position comes from the persisted `data-child-session-started` part inside the turn that
// spawned the session. The listing stays the authority for the row: the title and the activity stamp
// come from it, and a part whose row the listing does not hold paints nothing. A child that no mounted
// part claims paints at the tail.

const SID = "thread-parent";
const AID = "a1";

// A failed request to the server, which the listing gives instead of rows.
const serverGone: ClientError = { type: "unreachable", reason: "connection_failed", baseUrl: "http://test", cause: new Error("boom") };

// `Chat` reads `.id` for the transcript load. The workspace has no anchor, thus the welcome block names
// no folder, which is correct with a transcript mounted.
const ANALYSIS = { id: AID, name: "Alpha", anchorId: "anchor-absent", projectId: null } as unknown as Analysis;

// What the entry's open bound, recorded so a click is assertable. Cleared between cases.
const opened: string[] = [];

const ws = {
    analysis: ANALYSIS,
    sessionId: SID,
    workingDir: "/work",
    project: null,
    anchor: null,
    openDialog: () => {},
    closeDialog: () => {},
    openSession: (threadId: string | null) => {
        if (threadId !== null) opened.push(threadId);
    },
    quit: async () => {},
} as unknown as Workspace;

/** One stored row of the fixture transcript, with the report sessions that its turn spawned. */
type FixtureRow = {
    seq: number;
    role: "user" | "assistant";
    /** The thread ids of the `data-child-session-started` parts that this row carries. */
    spawns?: string[];
};

// Six stored rows, one message each, paired as three turns: a request and then its reply. A spawn part
// rides the reply of the turn that asked, which is where the harness persists it.
const ROWS: FixtureRow[] = [
    { seq: 10, role: "user" },
    { seq: 11, role: "assistant" },
    { seq: 12, role: "user" },
    { seq: 13, role: "assistant" },
    { seq: 14, role: "user" },
    { seq: 15, role: "assistant" },
];

/** A transcript read that models the server replay: one row in, one message of that row's role out. */
function transcriptRead(rows: FixtureRow[]): LoadOpts {
    const messages = rows.map((r): ChatMessage => ({
        id: `id-${r.seq}`,
        role: r.role,
        parts: [
            { type: "text", text: `${r.role} ${r.seq}` },
            ...(r.spawns ?? []).map((threadId) => ({
                type: "data-child-session-started" as const,
                threadId,
                parentThreadId: SID,
                threadType: "report" as const,
            })),
        ],
    }));
    // One turn carrying every fixture row: the replay reads rows, not turn boundaries.
    return { fetchThread: () => okAsync(null), fetchMessages: () => okAsync({ messages, total: 1, page: 0, perPage: 1, hasMore: false }) };
}

/**
 * The report-children listing. `"unreadable"` is the degrade arm, where the read itself failed.
 *
 * A live page models the server in one more way: the store hides an archived row unless the listing is
 * widened, and this listing never widens it. Thus a case that is about an archived child hands back the
 * live rows alone, exactly as the real read does.
 */
function childrenRead(page: ThreadSummary[] | "unreadable"): ReportChildrenOpts {
    return {
        ready: () => true,
        listThreads: () => (page === "unreadable" ? errAsync(serverGone) : okAsync(threadListOf(page))),
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
 * effect run reads through the production options, and with no ready server that run clears the listing.
 * Anything seeded before the mount is wiped by it.
 *
 * The renderer is destroyed in a `finally`. An undisposed renderer outlives its case and corrupts every
 * later render suite in the same process.
 */
async function withChat<T>(
    rows: FixtureRow[],
    children: ThreadSummary[] | "unreadable",
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
        await loadMessages(AID, SID, transcriptRead(rows));
        await refreshReportChildren(AID, SID, childrenRead(children));
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
async function frameWith(rows: FixtureRow[], children: ThreadSummary[] | "unreadable"): Promise<string> {
    return withChat(rows, children, (_setup, frame) => frame);
}

/** The fixture rows with the given spawns on the row that `seq` names. */
function rowsWithSpawns(seq: number, spawns: string[]): FixtureRow[] {
    return ROWS.map((r) => (r.seq === seq ? { ...r, spawns } : r));
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
    const REQUEST_2 = "#3";
    const REPLY_2 = "#4";
    const REQUEST_3 = "#5";
    const REPLY_3 = "#6";

    test("the entry paints inside the turn that carries the spawn part", async () => {
        // The part persists at the position of the spawn, thus the entry sits in the reply that asked
        // for the report, above the turn that follows it.
        const frame = await frameWith(rowsWithSpawns(13, ["child-1"]), [reportSummary({ id: "child-1", title: "Volcano report", parentThreadId: SID })]);

        expect(rowOf(frame, REQUEST_2)).toBeLessThan(rowOf(frame, "Volcano report"));
        expect(rowOf(frame, REPLY_2)).toBeLessThan(rowOf(frame, "Volcano report"));
        expect(rowOf(frame, "Volcano report")).toBeLessThan(rowOf(frame, REQUEST_3));
        // The entry names what it opens, because a title reads as a conversation title on its own.
        expect(frame).toContain("report session");
    });

    test("two spawns of one turn paint in part order, at that turn", async () => {
        const frame = await frameWith(rowsWithSpawns(13, ["child-1", "child-2"]), [
            reportSummary({ id: "child-1", title: "Volcano report", parentThreadId: SID }),
            reportSummary({ id: "child-2", title: "Pathway report", parentThreadId: SID }),
        ]);

        expect(rowOf(frame, REPLY_2)).toBeLessThan(rowOf(frame, "Volcano report"));
        expect(rowOf(frame, "Volcano report")).toBeLessThan(rowOf(frame, "Pathway report"));
        expect(rowOf(frame, "Pathway report")).toBeLessThan(rowOf(frame, REQUEST_3));
    });

    test("the entry title comes from the listing, thus the part alone paints nothing", async () => {
        // The part carries the thread id and no display fields. The listing is the authority for the
        // row, thus a part whose row the listing does not hold — an archived child — renders nothing.
        const frame = await frameWith(rowsWithSpawns(13, ["child-archived"]), [
            reportSummary({ id: "child-live", title: "Volcano report", parentThreadId: SID }),
        ]);

        expect(frame).not.toContain("child-archived");
        // The live row has no claiming part, thus it paints at the tail — reachable either way.
        expect(rowOf(frame, REPLY_3)).toBeLessThan(rowOf(frame, "Volcano report"));
    });

    test("a child that no mounted part claims paints at the tail", async () => {
        // A session spawned before the part became durable has no part to sit at. The tail keeps it
        // reachable, below the newest turn.
        const frame = await frameWith(ROWS, [reportSummary({ id: "child-1", title: "Volcano report", parentThreadId: SID })]);

        expect(rowOf(frame, REPLY_3)).toBeLessThan(rowOf(frame, "Volcano report"));
        expect(frame).toContain("report session");
    });

    test("a click on the entry opens that report session in place", async () => {
        await withChat(
            rowsWithSpawns(13, ["child-1"]),
            [reportSummary({ id: "child-1", title: "Volcano report", parentThreadId: SID })],
            async (setup, frame) => {
                const at = cellOf(frame, "Volcano report");
                await createMockMouse(setup.renderer).pressDown(at.x, at.y);
                expect(opened).toEqual(["child-1"]);
            },
        );
    });

    test("a failed listing renders no entry, and the transcript stays whole", async () => {
        // The entries are an addition to the transcript, thus their absence costs the reader nothing. A
        // failed read must not take the conversation down with it.
        const frame = await frameWith(rowsWithSpawns(13, ["child-1"]), "unreadable");

        expect(frame).not.toContain("report session");
        expect(rowOf(frame, REQUEST_2)).toBeLessThan(rowOf(frame, REPLY_2));
        expect(rowOf(frame, REPLY_2)).toBeLessThan(rowOf(frame, REQUEST_3));
    });

    test("an archived child leaves the surface, and each other child keeps its own position", async () => {
        // An archive stamps the whole subtree and the listing hides the stamped row, thus the entry goes
        // at the next refresh. The survivors keep their own anchors: one at its part, one at the tail.
        const rows = rowsWithSpawns(11, ["child-1"]).map((r) => (r.seq === 13 ? { ...r, spawns: ["child-2"] } : r));
        const all = [
            reportSummary({ id: "child-1", title: "Volcano report", parentThreadId: SID }),
            reportSummary({ id: "child-2", title: "Pathway report", parentThreadId: SID, archivedAt: "2026-07-09T09:30:00.000Z" }),
            reportSummary({ id: "child-3", title: "Enrichment report", parentThreadId: SID }),
        ];
        const frame = await frameWith(
            rows,
            all.filter((t) => t.archivedAt === undefined),
        );

        expect(frame).not.toContain("Pathway report");
        expect(rowOf(frame, "Volcano report")).toBeLessThan(rowOf(frame, REQUEST_2));
        expect(rowOf(frame, REPLY_3)).toBeLessThan(rowOf(frame, "Enrichment report"));
    });
});

// The banner under the stream carries the remedy of a failed turn. A remedy is the part of the message that
// says what to do, and it comes last, thus a banner cut to one row loses exactly that part.
describe("the error banner of the chat", () => {
    afterEach(() => resetHotState());

    test("a message longer than one row wraps, thus the remedy at its end stays on screen", async () => {
        const setup = await testRender(
            () => (
                <WorkspaceContext.Provider value={ws}>
                    <box width="100%" height="100%">
                        <Chat onScrollPaneRef={() => {}} />
                    </box>
                </WorkspaceContext.Provider>
            ),
            { width: 60, height: 20 },
        );
        try {
            setError(
                "Could not start the turn: No Inflexa server answers at http://127.0.0.1:8436. The next inflexa command that needs one starts it, and `inflexa server status` shows it.",
            );
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("Could not start the turn");
            expect(frame).toContain("shows it.");
        } finally {
            setup.renderer.destroy();
        }
    });
});
