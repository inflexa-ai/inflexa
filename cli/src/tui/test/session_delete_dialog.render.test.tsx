import { describe, expect, test } from "bun:test";

import { purgeSessionFlow } from "../commands.tsx";
import { liveThreadConfirmWorld, sessionDialogFrame, type SessionDialogDrive } from "../../test_support/session_dialogs.tsx";

// The hard-delete confirmation is the counterpart to the removal one, and the pair is only safe if a
// user can tell them apart from the panel alone: `POST {T}/purge` drops the row AND every message, with
// no restore behind it, while removal keeps all of it. Both dialogs carry the same danger chrome and
// the same type-the-name gate, so the WORDS are the entire difference — and words only exist as
// painted cells, which no notice-text or props assertion reaches.
//
// Rendered for a second reason too: the irreversibility line is longer than the `md` tier's panel is
// wide, so it is correct only if the panel grows to fit it. A sentence clipped before "cannot be
// undone" would understate the one action in the app that cannot be taken back.

const { scope, opts } = liveThreadConfirmWorld();

/** Drive the real purge flow through the mounted dialog host. */
const purgeFlow = ({ ws }: SessionDialogDrive) => purgeSessionFlow(ws, opts);

describe("the session-delete confirmation says what the store actually does", () => {
    test("it asks to DELETE, never to remove", async () => {
        await sessionDialogFrame(scope, purgeFlow, (frame) => {
            expect(frame).toContain("Delete session?");
            // The softer word belongs to the action that keeps the transcript; borrowing it here would
            // make the two dialogs read as the same thing.
            expect(frame).not.toContain("Remove session");
        });
    });

    test("it states that the messages are erased and that this cannot be undone", async () => {
        await sessionDialogFrame(scope, purgeFlow, (frame) => {
            // The line wraps inside the `md` panel, so assert its halves rather than the whole
            // sentence: a frame is a grid of cells and the wrap point falls mid-sentence.
            expect(frame).toContain("Every message in it is erased");
            expect(frame).toContain("cannot be undone");
            // The claim that would be false: restore is exactly what does not reach a purged thread.
            expect(frame).toContain("Restore session cannot bring it back");
        });
    });

    test("it gates on typing the conversation's own name", async () => {
        await sessionDialogFrame(scope, purgeFlow, (frame) => {
            expect(frame).toContain('Type "Cohort survival questions" to confirm');
        });
    });
});
