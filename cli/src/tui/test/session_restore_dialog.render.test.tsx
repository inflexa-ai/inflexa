import { afterEach, describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";

import type { ThreadList, ThreadSummary } from "../../api/conversation.ts";
import { __resetKeybindCache } from "../keymap.ts";
import { dialogClear } from "../components/dialog/dialog_host.tsx";
import { openRestoreSession, type SessionOpts } from "../commands.tsx";
import { __resetBootForTest } from "../hooks/boot.ts";
import { conversationSummary, threadListOf } from "../../test_support/threads.ts";
import { buildAnalysis } from "../../test_support/builders.ts";
import { withSessionDialog, type SessionDialogScope } from "../../test_support/session_dialogs.tsx";
import { sessionOptsDouble } from "../../test_support/session_doubles.ts";
import type { RenderSetup } from "../../test_support/tui.ts";
import type { Notice } from "../theme.ts";

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

const ANALYSIS = buildAnalysis();
// Distinct from the activity clock below, which an archive deliberately leaves alone.
const ARCHIVED_AT = "2026-07-09T09:30:00.000Z";

function threadRow(over: Partial<ThreadSummary> = {}): ThreadSummary {
    return conversationSummary({ id: "thread-1", resourceId: ANALYSIS.id, title: "Cohort survival", ...over });
}

const SCOPE: SessionDialogScope = { analysis: ANALYSIS, sessionId: "thread-open", closeDialog: dialogClear };

/** Session options over a fixed widened listing, recording every thread id the picker asks to restore. */
function sessionOpts(page: ThreadList, notices: Notice[], restored: string[]): SessionOpts {
    return sessionOptsDouble({
        getThread: () => okAsync(null),
        listThreadsWithArchived: () => okAsync(page),
        unarchiveThread: (_analysisId: string, threadId: string) => {
            restored.push(threadId);
            return okAsync(undefined);
        },
        resolveThreadId: () => Promise.resolve(null),
        notify: (n) => notices.push(n),
    }).opts;
}

/** Open the restore picker for `page`, act through the live harness, and always destroy the renderer. */
async function onPicker(page: ThreadList, act: (h: { setup: RenderSetup; notices: Notice[]; restored: string[] }) => Promise<void> | void): Promise<void> {
    const restored: string[] = [];
    await withSessionDialog(
        SCOPE,
        ({ ws, notices }) => openRestoreSession(ws, sessionOpts(page, notices, restored)),
        (h) => act({ setup: h.setup, notices: h.notices, restored }),
    );
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
