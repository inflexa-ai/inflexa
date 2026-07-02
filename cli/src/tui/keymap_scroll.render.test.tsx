import { afterEach, describe, expect, test } from "bun:test";
import { For, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";

import { useKeymapRoot, useBindings, MODE_BASE, KEYS, __resetKeybindCache } from "./keymap.ts";
import { ScrollPane } from "./components/scroll_pane.tsx";
import { DialogOverlay, dialogPush, dialogClear } from "./components/dialog/dialog_host.tsx";

// End-to-end verification of the REAL ScrollPane through the REAL engine: mockInput drives
// opentui's keyboard bus → useKeymapRoot's useKeyboard → dispatchKey → ScrollPane's internal
// focus-target-gated layer → a REAL ScrollBoxRenderable. This is the single behavioral source for
// scroll-key coverage (hosts add no per-host scroll tests). The harness mirrors app.tsx's chat
// wiring — esc focuses the pane, i refocuses the textarea — which is exactly the focus-gating
// contract under test: keys live iff the pane is focused. (The App itself needs the whole
// workspace/DB/conversation stack to mount, which is out of scope here — tsc covers App's wiring.)

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i}`);

afterEach(() => {
    __resetKeybindCache();
    dialogClear();
});

function Harness(props: { sticky?: boolean; lines?: () => string[]; onRefs: (sb: ScrollBoxRenderable, ta: TextareaRenderable) => void }) {
    useKeymapRoot();

    let sb: ScrollBoxRenderable | null = null;
    let ta: TextareaRenderable | null = null;

    // Mirrors app.tsx: esc (textarea-targeted) FOCUSES the pane — never a bare blur — and the
    // pane-targeted companion layer returns to the input. The scroll keys themselves come from
    // ScrollPane's internal layer, not from this harness.
    useBindings(() => ({
        mode: MODE_BASE,
        target: ta,
        bindings: [{ chord: KEYS.escape, run: () => sb?.focus() }],
    }));
    useBindings(() => ({
        mode: MODE_BASE,
        target: sb,
        bindings: [{ chord: { key: "i" }, run: () => ta?.focus() }],
    }));

    return (
        <box flexDirection="column" height={10}>
            <ScrollPane
                focusOnMount={false}
                flexGrow={1}
                stickyScroll={props.sticky}
                stickyStart={props.sticky ? "bottom" : undefined}
                onRef={(r: ScrollBoxRenderable) => (sb = r)}
            >
                <For each={props.lines ? props.lines() : LINES}>{(l) => <text>{l}</text>}</For>
            </ScrollPane>
            <textarea
                ref={(r: TextareaRenderable) => {
                    ta = r;
                    queueMicrotask(() => r.focus());
                    props.onRefs(sb!, r);
                }}
            />
            <DialogOverlay />
        </box>
    );
}

// A lone ESC byte is an ambiguous escape-sequence prefix: opentui's StdinParser holds it for
// timeoutMs (20ms, armTimeouts on a real clock) before flushing it as a standalone "escape" key.
// So we must yield real time, not just spin renderOnce, for esc to reach the dispatcher.
function makeSettle(setup: { renderOnce: () => Promise<void> }): () => Promise<void> {
    return async () => {
        await new Promise((r) => setTimeout(r, 35));
        await setup.renderOnce();
        await setup.renderOnce();
    };
}

describe("ScrollPane (rendered, real keyboard bus)", () => {
    test("esc focuses the pane → canonical key steps → i refocuses → typing is gated", async () => {
        let sb!: ScrollBoxRenderable;
        let ta!: TextareaRenderable;
        const setup = await testRender(() => <Harness onRefs={(s, t) => ((sb = s), (ta = t))} />, { width: 30, height: 10 });
        const settle = makeSettle(setup);

        try {
            await settle();
            // The textarea grabs focus on mount (queueMicrotask), so we start in INSERT mode.
            expect(ta.focused).toBe(true);
            // The content (40 lines) is taller than the ~8-row viewport, so it is scrollable.
            expect(sb.scrollHeight).toBeGreaterThan(sb.height);

            // GATE: with the input focused, G must NOT scroll (it types instead) — scrollTop stays 0.
            setup.mockInput.pressKey("g", { shift: true });
            await settle();
            expect(sb.scrollTop).toBe(0);

            // esc → the pane is FOCUSED (never a blur-to-nothing) → NORMAL mode.
            setup.mockInput.pressEscape();
            await settle();
            expect(ta.focused).toBe(false);
            expect(sb.focused).toBe(true);

            // j scrolls exactly one line; k scrolls back.
            setup.mockInput.pressKey("j");
            await settle();
            expect(sb.scrollTop).toBe(1);
            setup.mockInput.pressKey("k");
            await settle();
            expect(sb.scrollTop).toBe(0);

            // Arrow down is bound at the SAME 1-line step (the native handler's 1/5-viewport step
            // would differ) — proving ScrollPane's layer shadows the native focused-scrollbox keys.
            setup.mockInput.pressArrow("down");
            await settle();
            expect(sb.scrollTop).toBe(1);
            setup.mockInput.pressArrow("up");
            await settle();
            expect(sb.scrollTop).toBe(0);

            // ctrl+d: half a viewport — more than a line-step, at most the viewport height.
            setup.mockInput.pressKey("d", { ctrl: true });
            await settle();
            const half = sb.scrollTop;
            expect(half).toBeGreaterThan(1);
            expect(half).toBeLessThanOrEqual(sb.height);
            // ctrl+u undoes it.
            setup.mockInput.pressKey("u", { ctrl: true });
            await settle();
            expect(sb.scrollTop).toBe(0);

            // pgdn/pgup: a full viewport (≥ the half step). No KeyCodes entry exists for the page
            // keys, so send the raw xterm sequences (\x1b[5~ / \x1b[6~) through the parser.
            setup.mockInput.pressKey("\u001b[6~");
            await settle();
            const page = sb.scrollTop;
            expect(page).toBeGreaterThanOrEqual(half);
            setup.mockInput.pressKey("\u001b[5~");
            await settle();
            expect(sb.scrollTop).toBe(0);

            // G (shift+g) scrolls to the bottom: a further j cannot go deeper (clamped at max).
            setup.mockInput.pressKey("g", { shift: true });
            await settle();
            const bottom = sb.scrollTop;
            expect(bottom).toBeGreaterThan(half);
            setup.mockInput.pressKey("j");
            await settle();
            expect(sb.scrollTop).toBe(bottom);

            // g g scrolls to the top; end/home mirror G/gg.
            setup.mockInput.pressKey("g");
            setup.mockInput.pressKey("g");
            await settle();
            expect(sb.scrollTop).toBe(0);
            // "END"/"HOME" are KeyCodes names (a lowercase string would be sent as literal letters).
            setup.mockInput.pressKey("END");
            await settle();
            expect(sb.scrollTop).toBe(bottom);
            setup.mockInput.pressKey("HOME");
            await settle();
            expect(sb.scrollTop).toBe(0);

            // i refocuses the input → back to INSERT; scroll keys go dead again.
            setup.mockInput.pressKey("i");
            await settle();
            expect(ta.focused).toBe(true);
            setup.mockInput.pressKey("j");
            await settle();
            expect(sb.scrollTop).toBe(0);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("G re-engages sticky bottom — the view follows appends without further keys", async () => {
        let sb!: ScrollBoxRenderable;
        const [lines, setLines] = createSignal(LINES);
        const setup = await testRender(() => <Harness sticky lines={lines} onRefs={(s) => (sb = s)} />, { width: 30, height: 10 });
        const settle = makeSettle(setup);

        try {
            await settle();
            setup.mockInput.pressEscape();
            await settle();

            // Scrolling to the top disengages stickiness: appended lines do NOT move the viewport.
            setup.mockInput.pressKey("g");
            setup.mockInput.pressKey("g");
            await settle();
            expect(sb.scrollTop).toBe(0);
            setLines((l) => [...l, "appended 1"]);
            await settle();
            expect(sb.scrollTop).toBe(0);

            // G jumps to the bottom AND re-engages stickiness: the next append is followed.
            setup.mockInput.pressKey("g", { shift: true });
            await settle();
            const bottom = sb.scrollTop;
            expect(bottom).toBeGreaterThan(0);
            setLines((l) => [...l, "appended 2", "appended 3"]);
            await settle();
            expect(sb.scrollTop).toBeGreaterThan(bottom);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("dialog close restores focus to the NORMAL-mode pane", async () => {
        let sb!: ScrollBoxRenderable;
        const setup = await testRender(() => <Harness onRefs={(s) => (sb = s)} />, { width: 30, height: 10 });
        const settle = makeSettle(setup);

        try {
            await settle();
            setup.mockInput.pressEscape();
            await settle();
            expect(sb.focused).toBe(true);

            // Opening a dialog blurs the pane (the overlay saves it as the focus to restore).
            dialogPush(() => (
                <box>
                    <text>dialog</text>
                </box>
            ));
            await settle();
            expect(sb.focused).toBe(false);

            // Closing restores the pane — no fallback branch involved — and its keys are live again.
            dialogClear();
            await settle();
            expect(sb.focused).toBe(true);
            setup.mockInput.pressKey("j");
            await settle();
            expect(sb.scrollTop).toBe(1);
        } finally {
            setup.renderer.destroy();
        }
    });
});
