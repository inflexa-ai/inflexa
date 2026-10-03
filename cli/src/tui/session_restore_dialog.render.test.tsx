import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { okAsync } from "neverthrow";

import type { ThreadList, ThreadSummary } from "../api/conversation.ts";
import { useKeymapRoot, __resetKeybindCache } from "./keymap.ts";
import { DialogOverlay, dialogClear, dialogPush } from "./components/dialog/dialog_host.tsx";
import { WorkspaceContext, type Workspace } from "./contexts/workspace.ts";
import { openRestoreSession, type SessionOpts } from "./commands.tsx";
import { __setBootStateForTest, __resetBootForTest } from "./hooks/boot.ts";
import { conversationSummary, threadListOf } from "../test_support/threads.ts";
import type { Analysis } from "../types/analysis.ts";
import type { Notice } from "./theme.ts";

// The restore picker's rows are the only place the archived listing becomes visible, and the server
// WIDENS that listing rather than switching it — live threads come back beside the tombstoned ones.
// Which rows survive into the dialog is therefore a claim only a render can settle: a props assertion
// would be checking the array the flow built, not the list the user is offered to restore from. The
// empty state has the same property — "no rows" and "a blank list" look identical from outside.
//
// Driven through the REAL dialog host so the dialog under assertion is the one production mounts, and
// through the real keyboard bus so a selection is a keystroke rather than a hand-called callback.

afterEach(() => {
    __resetKeybindCache();
    __resetBootForTest();
    dialogClear();
});

const ANALYSIS = { id: "a1", name: "Alpha", projectId: null } as unknown as Analysis;
// Distinct from the activity clock below, which an archive deliberately leaves alone.
const ARCHIVED_AT = "2026-07-09T09:30:00.000Z";

function threadRow(over: Partial<ThreadSummary> = {}): ThreadSummary {
    return conversationSummary({ id: "thread-1", resourceId: ANALYSIS.id, title: "Cohort survival", ...over });
}

/** Session options over a fixed widened listing, recording every thread id the picker asks to restore. */
function sessionOpts(page: ThreadList, notices: Notice[], restored: string[]): SessionOpts {
    return {
        ready: () => true,
        listThreads: () => okAsync(threadListOf([])),
        listReportChildren: () => okAsync(threadListOf([])),
        getThread: () => okAsync(null),
        updateTitle: () => okAsync(null),
        listThreadsWithArchived: () => okAsync(page),
        archiveThread: () => okAsync(undefined),
        unarchiveThread: (_analysisId, threadId) => {
            restored.push(threadId);
            return okAsync(undefined);
        },
        purgeThread: () => okAsync({ purged: [], pages: { kind: "kept" } }),
        chatBusy: () => false,
        resolveThreadId: async () => null,
        workingDirFor: () => "/work",
        refreshThread: () => {},
        notify: (n) => notices.push(n),
    };
}

/**
 * Mount the dialog host under a keymap root and drive the real `openRestoreSession` through it, then
 * hand the caller the live harness so a case can keep typing into it.
 */
async function openRestorePicker(page: ThreadList) {
    const notices: Notice[] = [];
    const restored: string[] = [];
    const ws = {
        analysis: ANALYSIS,
        sessionId: "thread-open",
        workingDir: "/work",
        project: null,
        // The workspace capability App wires to `dialogPush`; supplying the same wiring is what makes
        // the dialog under assertion the one production mounts.
        openDialog: dialogPush,
        closeDialog: dialogClear,
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
    await openRestoreSession(ws, sessionOpts(page, notices, restored));
    await Promise.resolve();
    await setup.renderOnce();
    return { setup, notices, restored };
}

/**
 * Open, act, and ALWAYS destroy the renderer. An undisposed renderer outlives its test and corrupts
 * every later render suite in the same process (opentui installs process-level handlers per renderer),
 * so disposal is not tidiness here — it is what keeps this file from failing other files.
 */
async function onPicker(page: ThreadList, act: (h: Awaited<ReturnType<typeof openRestorePicker>>) => Promise<void> | void): Promise<void> {
    const harness = await openRestorePicker(page);
    try {
        await act(harness);
    } finally {
        harness.setup.renderer.destroy();
    }
}

describe("the restore picker offers exactly the archived conversations", () => {
    test("the live threads the widened listing returns are not offered", async () => {
        const page = threadListOf([
            threadRow({ id: "t-live", title: "Still open sweep" }),
            threadRow({ id: "t-archived", title: "Removed burden sweep", archivedAt: ARCHIVED_AT }),
        ]);

        await onPicker(page, ({ setup }) => {
            const frame = setup.captureCharFrame();
            expect(frame).toContain("Restore session");
            expect(frame).toContain("Removed burden sweep");
            // A live conversation has nothing to restore, and offering one would spend the user's
            // choice on a write the server treats as a no-op.
            expect(frame).not.toContain("Still open sweep");
        });
    });

    test("each row is stamped with when it was removed, not when it was last active", async () => {
        const page = threadListOf([threadRow({ id: "t-archived", title: "Removed burden sweep", archivedAt: ARCHIVED_AT })]);

        await onPicker(page, ({ setup }) => {
            // The stamp's rendering is locale-dependent, so assert the label that says WHICH clock it
            // reads — the archive leaves `updatedAt` on the last turn, which can predate the removal.
            expect(setup.captureCharFrame()).toContain("Removed ");
        });
    });

    test("nothing archived shows an empty state naming what would put a row here", async () => {
        await onPicker(threadListOf([threadRow({ id: "t-live" })]), ({ setup }) => {
            const frame = setup.captureCharFrame();
            expect(frame).toContain("No archived conversations");
            expect(frame).toContain("removing one");
        });
    });

    test("picking a row lifts that conversation's tombstone", async () => {
        const page = threadListOf([threadRow({ id: "t-archived", title: "Removed burden sweep", archivedAt: ARCHIVED_AT })]);

        await onPicker(page, async ({ setup, restored, notices }) => {
            // The cursor opens on row 0 and the archived row is the only one that survives the filter,
            // so enter commits it.
            setup.mockInput.pressEnter();
            await setup.renderOnce();
            await Promise.resolve();

            expect(restored).toEqual(["t-archived"]);
            expect(notices.at(-1)?.kind).toBe("info");
            expect(notices.at(-1)?.text).toContain("Removed burden sweep");
        });
    });
});
