import { describe, expect, test } from "bun:test";

import { interruptHintFor } from "./app.tsx";
import { interruptHintLabel } from "./keymap.ts";

// The status-bar interrupt hint is derived by the pure `interruptHintFor` (app.tsx) over the live turn
// state, and its wording by the shared `interruptHintLabel` (keymap.ts). Booting the whole chat App to
// pin the gate would drag in a runtime, DB, and providers for what is a one-line derivation, so — as with
// status_bar.render.test.tsx's app-side gate — the derivation is exercised directly. A stand-in key label
// keeps the cases independent of the user's live `app.interrupt` binding.
const KEY = "esc";

describe("interruptHintFor — the interrupt-hint visibility gate", () => {
    test("busy + NORMAL mode → the resting hint is present", () => {
        // The default reachable state: a turn is busy and the stream pane holds focus, so the interrupt
        // binding is live and the hint honestly advertises it.
        expect(interruptHintFor({ busy: true, insertMode: false, armed: false, key: KEY })).toEqual({ label: `${KEY} interrupt`, armed: false });
    });

    test("busy + INSERT mode → no hint (the interrupt binding is unreachable there)", () => {
        // The bug this gate fixes: post-submit the composer is focused (INSERT) and esc only switches modes,
        // so the hint must be absent rather than promise an interrupt.
        expect(interruptHintFor({ busy: true, insertMode: true, armed: false, key: KEY })).toBeUndefined();
    });

    test("idle → no hint regardless of mode", () => {
        expect(interruptHintFor({ busy: false, insertMode: false, armed: false, key: KEY })).toBeUndefined();
        expect(interruptHintFor({ busy: false, insertMode: true, armed: false, key: KEY })).toBeUndefined();
    });

    test("armed → the confirm wording, still only in NORMAL mode", () => {
        expect(interruptHintFor({ busy: true, insertMode: false, armed: true, key: KEY })).toEqual({ label: `${KEY} again to interrupt`, armed: true });
        // Armed does not override the INSERT gate — an armed window while the composer is focused shows nothing.
        expect(interruptHintFor({ busy: true, insertMode: true, armed: true, key: KEY })).toBeUndefined();
    });
});

describe("interruptHintLabel — the single wording source", () => {
    test("resting vs armed phrasing", () => {
        expect(interruptHintLabel(KEY, false)).toBe(`${KEY} interrupt`);
        expect(interruptHintLabel(KEY, true)).toBe(`${KEY} again to interrupt`);
    });
});
