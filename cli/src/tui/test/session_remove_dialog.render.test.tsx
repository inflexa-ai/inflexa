import { describe, expect, test } from "bun:test";

import { deleteSessionFlow } from "../commands.tsx";
import { liveThreadConfirmWorld, sessionDialogFrame, type SessionDialogDrive } from "../../test_support/session_dialogs.tsx";

// The removal confirmation is the one surface in the session flows whose CORRECTNESS IS ITS WORDING.
// `DELETE {T}` writes a tombstone: the row and every message survive, and the thread only stops
// listing. The dialog is nonetheless the app's strongest irreversibility signal — danger chrome plus
// typing the name back — so what it says has to match what the store does, or the ritual teaches users
// to discount it everywhere it IS telling the truth. Notice-text assertions cannot cover that: the
// title, the retention line, and the danger chrome only exist as painted cells.
//
// Rendered rather than asserted on props for a second reason: the retention line is longer than the
// `md` tier's panel is wide, so it is only correct if the panel grows to fit it. A clipped sentence
// would read as a promise the flow does not keep.

const { scope, opts } = liveThreadConfirmWorld();

/** Drive the real removal flow through the mounted dialog host. */
const removeFlow = ({ ws }: SessionDialogDrive) => deleteSessionFlow(ws, opts);

describe("the session-removal confirmation says what the store actually does", () => {
    test("it asks to REMOVE, never to delete", async () => {
        await sessionDialogFrame(scope, removeFlow, (frame) => {
            expect(frame).toContain("Remove session?");
            // The word the copy must not carry: nothing here erases anything.
            expect(frame).not.toContain("Delete session");
        });
    });

    test("it states that the transcript survives, in full — the panel grows rather than clipping it", async () => {
        await sessionDialogFrame(scope, removeFlow, (frame) => {
            // The line wraps inside the `md` panel, so assert its halves rather than the whole sentence:
            // a frame is a grid of cells and the wrap point falls mid-sentence.
            expect(frame).toContain("It stops appearing in this analysis");
            expect(frame).toContain("nothing is erased");
        });
    });

    test("it still gates on typing the conversation's own name", async () => {
        // The retention wording softens the claim; it must not soften the confirmation. A removal the
        // user cannot undo from the UI still earns the type-the-name gate.
        await sessionDialogFrame(scope, removeFlow, (frame) => {
            expect(frame).toContain('Type "Cohort survival questions" to confirm');
        });
    });
});
