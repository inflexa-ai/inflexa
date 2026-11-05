import { afterEach, describe, expect, test } from "bun:test";
import { For } from "solid-js";
import { testRender, useRenderer } from "@opentui/solid";
import type { ScrollBoxRenderable, TextRenderable, TextareaRenderable } from "@opentui/core";

import { useBindings, useKeymapRoot, __resetKeybindCache } from "../keymap.ts";
import { selectionClearLayer } from "../app.tsx";
import { ScrollPane } from "../components/scroll_pane.tsx";
import { DialogOverlay, dialogPush, dialogClear, dialogIsOpen } from "../components/dialog/dialog_host.tsx";
import { usePaneFocusCompanions } from "../../test_support/keymap_harness.tsx";
import { makeSettle } from "../../test_support/tui.ts";

// End-to-end verification of app.tsx's "esc clears the active text selection" layer through the
// REAL engine: a headless selection over selectable text arms the layer, then mockInput drives
// opentui's keyboard bus → useKeymapRoot → dispatchKey → the winning layer. The App itself needs
// the whole workspace/DB/conversation stack to mount (out of scope here — tsc covers App's wiring),
// so the Harness registers the ACTUAL layer under test — app.tsx's exported `selectionClearLayer`
// factory — instead of a hand-copied replica, so the test can never drift from app.tsx's real config.
// Only the destinations esc competes with are minimal stand-ins: the textarea-targeted esc→pane
// (INSERT→NORMAL) fall-through and the dialog host's structural esc (via DialogOverlay), which give
// esc's other jobs a real place to land.

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i}`);

afterEach(() => {
    __resetKeybindCache();
    dialogClear();
});

type Refs = { text: TextRenderable; ta: TextareaRenderable; sb: ScrollBoxRenderable };

function Harness(props: { onRefs: (refs: Refs) => void }) {
    useKeymapRoot();
    const renderer = useRenderer();

    let text: TextRenderable | null = null;
    let ta: TextareaRenderable | null = null;
    let sb: ScrollBoxRenderable | null = null;
    const publish = (): void => {
        if (text && ta && sb) props.onRefs({ text, ta, sb });
    };

    // The REAL layer under test: app.tsx's exported factory, registered here over the same renderer so
    // the test exercises app.tsx's actual config (arm-on-selected-text, priority 50, clear-only) rather
    // than a copy that could drift.
    useBindings(() => selectionClearLayer(renderer));

    // app.tsx's INSERT→NORMAL fall-through is what the "no selection → esc flips to NORMAL" case
    // needs a real destination for.
    usePaneFocusCompanions(
        () => sb,
        () => ta,
    );

    return (
        <box flexDirection="column" width="100%" height="100%">
            <text
                ref={(r: TextRenderable) => {
                    text = r;
                    publish();
                }}
            >
                {"SELECTABLE-CHAT-TEXT-0123456789"}
            </text>
            <ScrollPane focusOnMount={false} flexGrow={1} onRef={(r: ScrollBoxRenderable) => ((sb = r), publish())}>
                <For each={LINES}>{(l) => <text>{l}</text>}</For>
            </ScrollPane>
            <textarea
                ref={(r: TextareaRenderable) => {
                    ta = r;
                    queueMicrotask(() => r.focus());
                    publish();
                }}
            />
            <DialogOverlay />
        </box>
    );
}

type Setup = Awaited<ReturnType<typeof testRender>>;

// Create a persistent, non-empty selection across the selectable text via the renderer's own
// selection API (the same calls a mouse drag makes), captured at the text's computed screen box so
// the coordinates always cover it. Direct API rather than a mock drag: it fires no mouseUp, so it
// leaves a selection standing to the esc press without any copy-on-select interaction.
function selectText(setup: Setup, text: TextRenderable): Promise<void> {
    setup.renderer.startSelection(text, text.x, text.y);
    setup.renderer.updateSelection(text, text.x + text.width, text.y, { finishDragging: true });
    return setup.renderOnce();
}

const selectedText = (setup: Setup): string => setup.renderer.getSelection()?.getSelectedText() ?? "";

describe("esc clears the active text selection (rendered, real keyboard bus)", () => {
    test("selection + open dialog: esc clears the selection and leaves the dialog open; a second esc closes it", async () => {
        let refs!: Refs;
        const setup = await testRender(() => <Harness onRefs={(r) => (refs = r)} />, { width: 80, height: 24 });
        const settle = makeSettle(setup, 35);
        try {
            await settle();

            dialogPush(() => (
                <box>
                    <text>dialog body</text>
                </box>
            ));
            await settle();
            expect(dialogIsOpen()).toBe(true);

            await selectText(setup, refs.text);
            expect(selectedText(setup)).toContain("SELECTABLE-CHAT-TEXT");

            // First esc: the priority-50 clear-selection layer wins over the dialog host's esc.
            setup.mockInput.pressEscape();
            await settle();
            expect(selectedText(setup)).toBe("");
            expect(dialogIsOpen()).toBe(true);

            // Second esc: no selection now, so the clear layer is inert and esc falls to the dialog.
            setup.mockInput.pressEscape();
            await settle();
            expect(dialogIsOpen()).toBe(false);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("selection + focused textarea: esc clears the selection and the textarea keeps focus (stays INSERT)", async () => {
        let refs!: Refs;
        const setup = await testRender(() => <Harness onRefs={(r) => (refs = r)} />, { width: 80, height: 24 });
        const settle = makeSettle(setup, 35);
        try {
            await settle();
            // Textarea holds focus on mount = INSERT; the pane is not focused.
            expect(refs.ta.focused).toBe(true);
            expect(refs.sb.focused).toBe(false);

            await selectText(setup, refs.text);
            expect(selectedText(setup)).toContain("SELECTABLE-CHAT-TEXT");

            setup.mockInput.pressEscape();
            await settle();
            // Selection gone; focus did NOT move to the pane — the clear layer swallowed esc, so the
            // textarea-targeted esc→NORMAL never ran. Textarea focus IS the INSERT indicator's source.
            expect(selectedText(setup)).toBe("");
            expect(refs.ta.focused).toBe(true);
            expect(refs.sb.focused).toBe(false);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("no selection, focused textarea: esc falls through and flips INSERT→NORMAL (focuses the pane)", async () => {
        let refs!: Refs;
        const setup = await testRender(() => <Harness onRefs={(r) => (refs = r)} />, { width: 80, height: 24 });
        const settle = makeSettle(setup, 35);
        try {
            await settle();
            expect(selectedText(setup)).toBe("");
            expect(refs.ta.focused).toBe(true);

            setup.mockInput.pressEscape();
            await settle();
            // With nothing selected the clear layer is disabled: esc reaches the textarea-targeted
            // layer and moves focus to the pane (NORMAL), proving the fall-through is intact.
            expect(refs.ta.focused).toBe(false);
            expect(refs.sb.focused).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("no selection, open dialog: esc falls through and cancels the dialog", async () => {
        let refs!: Refs;
        const setup = await testRender(() => <Harness onRefs={(r) => (refs = r)} />, { width: 80, height: 24 });
        const settle = makeSettle(setup, 35);
        try {
            await settle();
            expect(refs).toBeDefined();

            dialogPush(() => (
                <box>
                    <text>dialog body</text>
                </box>
            ));
            await settle();
            expect(dialogIsOpen()).toBe(true);
            expect(selectedText(setup)).toBe("");

            setup.mockInput.pressEscape();
            await settle();
            // The disabled clear layer lets the dialog host's structural esc close the dialog.
            expect(dialogIsOpen()).toBe(false);
        } finally {
            setup.renderer.destroy();
        }
    });
});
