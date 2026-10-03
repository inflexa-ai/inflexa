import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { okAsync } from "neverthrow";

import { useKeymapRoot, __resetKeybindCache } from "./keymap.ts";
import { DialogOverlay, dialogClear, dialogPush } from "./components/dialog/dialog_host.tsx";
import { WorkspaceContext, type Workspace } from "./contexts/workspace.ts";
import { purgeSessionFlow, type SessionOpts } from "./commands.tsx";
import { __setBootStateForTest, __resetBootForTest } from "./hooks/boot.ts";
import { conversationSummary, threadListOf } from "../test_support/threads.ts";
import type { Analysis } from "../types/analysis.ts";
import type { Notice } from "./theme.ts";

// The hard-delete confirmation is the counterpart to the removal one, and the pair is only safe if a
// user can tell them apart from the panel alone: `POST {T}/purge` drops the row AND every message, with
// no restore behind it, while removal keeps all of it. Both dialogs carry the same danger chrome and
// the same type-the-name gate, so the WORDS are the entire difference — and words only exist as
// painted cells, which no notice-text or props assertion reaches.
//
// Rendered for a second reason too: the irreversibility line is longer than the `md` tier's panel is
// wide, so it is correct only if the panel grows to fit it. A sentence clipped before "cannot be
// undone" would understate the one action in the app that cannot be taken back.

afterEach(() => {
    __resetKeybindCache();
    __resetBootForTest();
    dialogClear();
});

const ANALYSIS = { id: "a1", name: "Alpha", projectId: null } as unknown as Analysis;

/** The flow only ever confirms against a LIVE conversation, so the row it reads carries no tombstone. */
const THREAD = conversationSummary({ id: "thread-1", resourceId: ANALYSIS.id });

/** Session options whose server answers stand still: the read gives {@link THREAD}, and each write succeeds. */
function sessionOpts(notices: Notice[]): SessionOpts {
    return {
        ready: () => true,
        listThreads: () => okAsync(threadListOf([])),
        listReportChildren: () => okAsync(threadListOf([])),
        getThread: () => okAsync(THREAD),
        updateTitle: () => okAsync(null),
        listThreadsWithArchived: () => okAsync(threadListOf([])),
        archiveThread: () => okAsync(undefined),
        unarchiveThread: () => okAsync(undefined),
        purgeThread: () => okAsync({ purged: [], pages: { kind: "kept" } }),
        chatBusy: () => false,
        resolveThreadId: async () => "thread-2",
        workingDirFor: () => "/work",
        refreshThread: () => {},
        notify: (n) => notices.push(n),
    };
}

/**
 * Mount the dialog host under a keymap root and drive the real `purgeSessionFlow` through it, so the
 * dialog under assertion is the one production pushes — not a hand-built stand-in that could drift.
 */
async function openDeleteDialog() {
    const notices: Notice[] = [];
    const ws = {
        analysis: ANALYSIS,
        sessionId: "thread-1",
        workingDir: "/work",
        project: null,
        // `openDialog` is the workspace capability App wires to `dialogPush`; the test supplies the
        // same wiring so the mounted dialog is production's.
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
    await purgeSessionFlow(ws, sessionOpts(notices));
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
    const setup = await openDeleteDialog();
    try {
        assert(setup.captureCharFrame());
    } finally {
        setup.renderer.destroy();
    }
}

describe("the session-delete confirmation says what the store actually does", () => {
    test("it asks to DELETE, never to remove", async () => {
        await onFrame((frame) => {
            expect(frame).toContain("Delete session?");
            // The softer word belongs to the action that keeps the transcript; borrowing it here would
            // make the two dialogs read as the same thing.
            expect(frame).not.toContain("Remove session");
        });
    });

    test("it states that the messages are erased and that this cannot be undone", async () => {
        await onFrame((frame) => {
            // The line wraps inside the `md` panel, so assert its halves rather than the whole
            // sentence: a frame is a grid of cells and the wrap point falls mid-sentence.
            expect(frame).toContain("Every message in it is erased");
            expect(frame).toContain("cannot be undone");
            // The claim that would be false: restore is exactly what does not reach a purged thread.
            expect(frame).toContain("Restore session cannot bring it back");
        });
    });

    test("it gates on typing the conversation's own name", async () => {
        await onFrame((frame) => {
            expect(frame).toContain('Type "Cohort survival questions" to confirm');
        });
    });
});
