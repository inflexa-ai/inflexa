import { describe, expect, test } from "bun:test";

import { interruptHintFor } from "./app.tsx";
import { interruptHintLabel } from "./keymap.ts";

// The status-bar interrupt hint is derived by the pure `interruptHintFor` (app.tsx) over the live turn
// state, and its wording by the shared `interruptHintLabel` (keymap.ts). Booting the whole chat App to
// pin the gate would drag in a runtime, DB, and providers for what is a one-line derivation, so — as with
// status_bar.render.test.tsx's app-side gate — the derivation is exercised directly. A stand-in key label
// keeps the cases independent of the user's live `app.interrupt` binding.
const KEY = "esc";

/** The one state where the interrupt binding is genuinely live: busy turn, stream pane focused, nothing stacked. */
const REACHABLE = { busy: true, insertMode: false, dialogOpen: false, askDocked: false, armed: false, key: KEY };

describe("interruptHintFor — the interrupt-hint visibility gate", () => {
    test("busy + NORMAL mode → the resting hint is present", () => {
        // The default reachable state: a turn is busy and the stream pane holds focus, so the interrupt
        // binding is live and the hint honestly advertises it.
        expect(interruptHintFor(REACHABLE)).toEqual({ label: `${KEY} interrupt`, armed: false });
    });

    test("busy + INSERT mode → no hint (the interrupt binding is unreachable there)", () => {
        // Post-submit the composer is focused (INSERT) and esc only switches modes, so the hint must be
        // absent rather than promise an interrupt.
        expect(interruptHintFor({ ...REACHABLE, insertMode: true })).toBeUndefined();
    });

    test("busy + a stacked dialog → no hint (the dialog owns esc)", () => {
        // A dialog takes focus off the composer, so the INSERT gate alone would let the hint through — but
        // the interrupt layer is inert under a modal and esc cancels the dialog instead.
        expect(interruptHintFor({ ...REACHABLE, dialogOpen: true })).toBeUndefined();
    });

    test("busy + a docked ask → no hint (the prompt owns esc)", () => {
        // Same shape as the dialog case: an active approval prompt focuses itself, so the composer is
        // unfocused while esc belongs to the prompt (back-to-choices), not the interrupt.
        expect(interruptHintFor({ ...REACHABLE, askDocked: true })).toBeUndefined();
    });

    test("idle → no hint regardless of where focus sits", () => {
        expect(interruptHintFor({ ...REACHABLE, busy: false })).toBeUndefined();
        expect(interruptHintFor({ ...REACHABLE, busy: false, insertMode: true })).toBeUndefined();
        expect(interruptHintFor({ ...REACHABLE, busy: false, dialogOpen: true })).toBeUndefined();
    });

    test("armed → the confirm wording, and armed never overrides a reachability gate", () => {
        expect(interruptHintFor({ ...REACHABLE, armed: true })).toEqual({ label: `${KEY} again to interrupt`, armed: true });
        // An armed window is still only advertised where the second press can actually land.
        expect(interruptHintFor({ ...REACHABLE, armed: true, insertMode: true })).toBeUndefined();
        expect(interruptHintFor({ ...REACHABLE, armed: true, dialogOpen: true })).toBeUndefined();
        expect(interruptHintFor({ ...REACHABLE, armed: true, askDocked: true })).toBeUndefined();
    });
});

describe("interruptHintLabel — the single wording source", () => {
    test("resting vs armed phrasing", () => {
        expect(interruptHintLabel(KEY, false)).toBe(`${KEY} interrupt`);
        expect(interruptHintLabel(KEY, true)).toBe(`${KEY} again to interrupt`);
    });
});
