import { describe, expect, test } from "bun:test";

import { interruptHintFor } from "./app.tsx";
import { interruptHintLabel } from "./keymap.ts";

// The footer interrupt hint is derived by the pure `interruptHintFor` (app.tsx) over the live turn state,
// and its wording by the shared `interruptHintLabel` (keymap.ts). Booting the whole chat App to pin the
// gate would drag in a runtime, DB, and providers for what is a one-line derivation, so — as with
// status_bar.render.test.tsx's app-side gate — the derivation is exercised directly. Distinct stand-in key
// labels keep the NORMAL (esc) and INSERT (abort-chord) variants independent of the user's live bindings
// and let each case assert which key the hint actually names.
const ESC = "esc";
const ABORT = "ctrl+c";

/** Busy turn, stream pane focused (NORMAL), nothing stacked: where the double-press esc interrupt is live. */
const NORMAL = { busy: true, insertMode: false, dialogOpen: false, askDocked: false, armed: false, interruptKey: ESC, abortKey: ABORT };

describe("interruptHintFor — the footer interrupt-hint derivation", () => {
    test("busy + NORMAL → the resting esc hint", () => {
        expect(interruptHintFor(NORMAL)).toEqual({ label: `${ESC} interrupt`, armed: false });
    });

    test("busy + NORMAL + armed → the confirm wording, still marked armed", () => {
        expect(interruptHintFor({ ...NORMAL, armed: true })).toEqual({ label: `${ESC} again to interrupt`, armed: true });
    });

    test("busy + INSERT → the one-press abort-chord hint, never armed", () => {
        // esc only switches modes in INSERT, so the footer advertises the ctrl+c chord that interrupts
        // while typing. A single press fires it, so it stays the muted resting form and names the abort key.
        expect(interruptHintFor({ ...NORMAL, insertMode: true })).toEqual({ label: `${ABORT} interrupt`, armed: false });
        // Even mid-arm (a NORMAL-only concept) the INSERT variant never adopts the confirm form.
        expect(interruptHintFor({ ...NORMAL, insertMode: true, armed: true })).toEqual({ label: `${ABORT} interrupt`, armed: false });
    });

    test("a stacked dialog → no hint in either mode (the dialog owns esc)", () => {
        expect(interruptHintFor({ ...NORMAL, dialogOpen: true })).toBeUndefined();
        expect(interruptHintFor({ ...NORMAL, insertMode: true, dialogOpen: true })).toBeUndefined();
    });

    test("a docked ask → no hint in either mode (the prompt owns esc)", () => {
        expect(interruptHintFor({ ...NORMAL, askDocked: true })).toBeUndefined();
        expect(interruptHintFor({ ...NORMAL, insertMode: true, askDocked: true })).toBeUndefined();
    });

    test("idle → no hint regardless of mode or arming", () => {
        expect(interruptHintFor({ ...NORMAL, busy: false })).toBeUndefined();
        expect(interruptHintFor({ ...NORMAL, busy: false, insertMode: true })).toBeUndefined();
        expect(interruptHintFor({ ...NORMAL, busy: false, armed: true })).toBeUndefined();
    });
});

describe("interruptHintLabel — the single wording source", () => {
    test("resting vs armed phrasing", () => {
        expect(interruptHintLabel(ESC, false)).toBe(`${ESC} interrupt`);
        expect(interruptHintLabel(ESC, true)).toBe(`${ESC} again to interrupt`);
    });
});
