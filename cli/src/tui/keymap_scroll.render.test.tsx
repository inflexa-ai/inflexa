import { afterEach, describe, expect, test } from "bun:test";
import { For, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";

import { useKeymapRoot, useBindings, MODE_BASE, KEYS, __resetKeybindCache } from "./keymap.ts";

// End-to-end verification of the vim scroll-mode keybinds (gg / G / focus-input / esc-blur) through
// the REAL engine: mockInput drives opentui's keyboard bus → useKeymapRoot's useKeyboard →
// dispatchKey → the binding layers → a REAL ScrollBoxRenderable. Unit tests cover chord matching in
// isolation; this proves the parts compose — that focus actually gates the layer, that esc blurs,
// that scrollTo/scrollBy actually move the viewport, and that shift+g is distinct from g. It mirrors
// app.tsx's binding shapes (the App itself needs the whole workspace/DB/conversation stack to mount,
// which is out of scope here — tsc covers App's JSX wiring).

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i}`);

afterEach(() => __resetKeybindCache());

function Harness(props: { onRefs: (sb: ScrollBoxRenderable, ta: TextareaRenderable) => void }) {
    useKeymapRoot();
    // The scroll layer's gate. Driven by the textarea's focused/blurred events (wired below); the
    // "G while focused does not scroll" assertion is what proves this gate actually engages.
    const [inputFocused, setInputFocused] = createSignal(true);

    let sb: ScrollBoxRenderable | null = null;
    let ta: TextareaRenderable | null = null;

    // esc blurs the focused input → NORMAL scroll mode (mirrors app.tsx's target-gated layer).
    useBindings(() => ({
        mode: MODE_BASE,
        target: ta,
        bindings: [{ chord: KEYS.escape, run: () => ta?.blur() }],
    }));

    // Scroll keys, live only while the input is blurred (the gate under test).
    useBindings(() => ({
        mode: MODE_BASE,
        enabled: !inputFocused(),
        bindings: [
            { chord: [{ key: "g" }, { key: "g" }], run: () => sb?.scrollTo(0) },
            { chord: { key: "g", shift: true }, run: () => sb && sb.scrollTo(sb.scrollHeight) },
            { chord: { key: "i" }, run: () => ta?.focus() },
        ],
    }));

    return (
        <box flexDirection="column" height={10}>
            <scrollbox ref={(r: ScrollBoxRenderable) => (sb = r)} flexGrow={1} scrollY>
                <For each={LINES}>{(l) => <text>{l}</text>}</For>
            </scrollbox>
            <textarea
                ref={(r: TextareaRenderable) => {
                    ta = r;
                    r.on("focused", () => setInputFocused(true));
                    r.on("blurred", () => setInputFocused(false));
                    queueMicrotask(() => r.focus());
                    props.onRefs(sb!, r);
                }}
            />
        </box>
    );
}

describe("scroll-mode keybinds (rendered, real keyboard bus)", () => {
    test("esc blurs → G/gg scroll the viewport → i refocuses → typing is gated", async () => {
        let sb!: ScrollBoxRenderable;
        let ta!: TextareaRenderable;
        const setup = await testRender(() => <Harness onRefs={(s, t) => ((sb = s), (ta = t))} />, { width: 30, height: 10 });

        // A lone ESC byte is an ambiguous escape-sequence prefix: opentui's StdinParser holds it for
        // timeoutMs (20ms, armTimeouts on a real clock) before flushing it as a standalone "escape"
        // key. So we must yield real time, not just spin renderOnce, for esc to reach the dispatcher.
        const settle = async (): Promise<void> => {
            await new Promise((r) => setTimeout(r, 35));
            await setup.renderOnce();
            await setup.renderOnce();
        };

        try {
            await settle();
            // The textarea grabs focus on mount (queueMicrotask), so we start in INSERT mode.
            expect(ta.focused).toBe(true);
            // The content (40 lines) is taller than the ~8-row viewport, so it is scrollable.
            expect(sb.scrollHeight).toBeGreaterThan(sb.height);

            // esc → blur → NORMAL mode.
            setup.mockInput.pressEscape();
            await settle();
            expect(ta.focused).toBe(false);

            // G (shift+g) scrolls to the bottom.
            setup.mockInput.pressKey("g", { shift: true });
            await settle();
            expect(sb.scrollTop).toBeGreaterThan(0);

            // g g scrolls to the top.
            setup.mockInput.pressKey("g");
            setup.mockInput.pressKey("g");
            await settle();
            expect(sb.scrollTop).toBe(0);

            // i refocuses the input → back to INSERT.
            setup.mockInput.pressKey("i");
            await settle();
            expect(ta.focused).toBe(true);

            // GATE: with the input focused, G must NOT scroll (it types instead) — scrollTop stays 0.
            setup.mockInput.pressKey("g", { shift: true });
            await settle();
            expect(sb.scrollTop).toBe(0);
        } finally {
            setup.renderer.destroy();
        }
    });
});
