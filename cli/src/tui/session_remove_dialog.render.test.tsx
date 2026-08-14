import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { okAsync } from "neverthrow";
import type { DbError, Pool, Thread } from "@inflexa-ai/harness";

import { useKeymapRoot, __resetKeybindCache } from "./keymap.ts";
import { DialogOverlay, dialogClear, dialogPush } from "./components/dialog/dialog_host.tsx";
import { WorkspaceContext, type Workspace } from "./contexts/workspace.ts";
import { deleteSessionFlow, type SessionSeams } from "./commands.tsx";
import { __setBootStateForTest, __resetBootForTest } from "./hooks/boot.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import type { Analysis } from "../types/analysis.ts";
import type { Notice } from "./theme.ts";

// The removal confirmation is the one surface in the session flows whose CORRECTNESS IS ITS WORDING.
// `archiveThread` writes a tombstone: the row and every message survive, and the thread only stops
// listing. The dialog is nonetheless the app's strongest irreversibility signal — danger chrome plus
// typing the name back — so what it says has to match what the store does, or the ritual teaches users
// to discount it everywhere it IS telling the truth. Notice-text assertions cannot cover that: the
// title, the retention line, and the danger chrome only exist as painted cells.
//
// Rendered rather than asserted on props for a second reason: the retention line is longer than the
// `md` tier's panel is wide, so it is only correct if the panel grows to fit it. A clipped sentence
// would read as a promise the flow does not keep.

afterEach(() => {
    __resetKeybindCache();
    __resetBootForTest();
    dialogClear();
});

const ANALYSIS = { id: "a1", name: "Alpha", projectId: null } as unknown as Analysis;
const fakePool = {} as unknown as Pool;
const fakeRuntime = { pool: fakePool } as unknown as HarnessRuntime;

function threadRow(): Thread {
    return {
        threadId: "thread-1",
        analysisId: ANALYSIS.id,
        title: "Cohort survival questions",
        threadType: "conversation",
        parentThreadId: null,
        parentSeq: null,
        createdAt: new Date("2026-07-08T00:00:00.000Z"),
        updatedAt: new Date("2026-07-08T01:00:00.000Z"),
        // The flow only ever confirms against a LIVE conversation, so the row it reads carries no
        // tombstone.
        deletedAt: null,
    };
}

function seams(notices: Notice[]): SessionSeams {
    return {
        runtime: () => fakeRuntime,
        listThreads: () => okAsync({ threads: [], total: 0, page: 0, perPage: 20, hasMore: false }),
        listReportChildren: () => okAsync({ threads: [], total: 0, page: 0, perPage: 20, hasMore: false }),
        getThread: () => okAsync(threadRow()),
        updateTitle: () => okAsync(null),
        listThreadsWithArchived: () => okAsync({ threads: [], total: 0, page: 0, perPage: 20, hasMore: false }),
        archiveThread: () => okAsync<void, DbError>(undefined),
        unarchiveThread: () => okAsync<void, DbError>(undefined),
        purgeThread: () => okAsync<readonly string[], DbError>([]),
        workspaceRootFor: () => ({ kind: "unlocatable" }),
        removeReportSessionDir: async () => true,
        chatBusy: () => false,
        resolveThreadId: async () => "thread-2",
        workingDirFor: () => "/work",
        refreshThread: () => {},
        notify: (n) => notices.push(n),
    };
}

/**
 * Mount the dialog host under a keymap root and drive the real `deleteSessionFlow` through it, so the
 * dialog is the one production pushes — not a hand-built stand-in that could drift from it.
 */
async function openRemoveDialog() {
    const notices: Notice[] = [];
    const ws = {
        analysis: ANALYSIS,
        sessionId: "thread-1",
        workingDir: "/work",
        project: null,
        // The flow's `openDialog` is the workspace capability App wires to `dialogPush`; the test
        // supplies that same wiring, so the dialog under assertion is the one production mounts.
        openDialog: dialogPush,
        closeDialog: () => {},
        openSession: () => {},
        quit: async () => {},
    } as unknown as Workspace;

    const setup = await testRender(
        () => {
            useKeymapRoot();
            return (
                <WorkspaceContext.Provider value={ws}>
                    <box width="100%" height="100%">
                        <DialogOverlay />
                    </box>
                </WorkspaceContext.Provider>
            );
        },
        { width: 90, height: 30 },
    );

    __setBootStateForTest({ phase: "ready", model: "claude-test", connection: { provider: "anthropic", mode: "cliproxy" } });
    await deleteSessionFlow(ws, seams(notices));
    await Promise.resolve();
    await setup.renderOnce();
    return setup;
}

/**
 * Mount, capture one frame, assert against it, and ALWAYS destroy the renderer. An undisposed renderer
 * outlives its test and corrupts every later render suite in the same process (opentui installs
 * process-level handlers per renderer), so disposal is not tidiness here — it is what keeps this file
 * from failing other files.
 */
async function onFrame(assert: (frame: string) => void): Promise<void> {
    const setup = await openRemoveDialog();
    try {
        assert(setup.captureCharFrame());
    } finally {
        setup.renderer.destroy();
    }
}

describe("the session-removal confirmation says what the store actually does", () => {
    test("it asks to REMOVE, never to delete", async () => {
        await onFrame((frame) => {
            expect(frame).toContain("Remove session?");
            // The word the copy must not carry: nothing here erases anything.
            expect(frame).not.toContain("Delete session");
        });
    });

    test("it states that the transcript survives, in full — the panel grows rather than clipping it", async () => {
        await onFrame((frame) => {
            // The line wraps inside the `md` panel, so assert its halves rather than the whole sentence:
            // a frame is a grid of cells and the wrap point falls mid-sentence.
            expect(frame).toContain("It stops appearing in this analysis");
            expect(frame).toContain("nothing is erased");
        });
    });

    test("it still gates on typing the conversation's own name", async () => {
        // The retention wording softens the claim; it must not soften the confirmation. A removal the
        // user cannot undo from the UI still earns the type-the-name gate.
        await onFrame((frame) => {
            expect(frame).toContain('Type "Cohort survival questions" to confirm');
        });
    });
});
