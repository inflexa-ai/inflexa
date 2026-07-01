import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { createMockMouse } from "@opentui/core/testing";
import type { TextareaRenderable } from "@opentui/core";

import { useKeymapRoot } from "../../keymap.ts";
import { DialogOverlay, dialogPush, dialogClose, dialogClear, dialogIsOpen, useDialogBindings, type CloseReason } from "./dialog_host.tsx";
import { PromptDialog } from "./prompt_dialog.tsx";
import { SelectList } from "../select_list.tsx";
import { ConfigApp } from "../../app_config.tsx";

// End-to-end verification of the dialog host STATE MACHINE through the real keyboard bus: close
// reasons per gesture, the busy veto, stacked-entry state survival + key inertness, the
// press-inside-release-outside click model, and the config-screen bare-key regression (typing `s`
// into the postgres-field prompt must insert a character, not fire save).

afterEach(() => {
    dialogClear();
});

function Harness(props: { onTa?: (ta: TextareaRenderable) => void }) {
    useKeymapRoot();
    return (
        <box width="100%" height="100%">
            <textarea
                ref={(r: TextareaRenderable) => {
                    queueMicrotask(() => r.focus());
                    props.onTa?.(r);
                }}
            />
            <DialogOverlay />
        </box>
    );
}

// A lone ESC byte is an ambiguous escape-sequence prefix: opentui's StdinParser holds it for
// timeoutMs (20ms) before flushing it as a standalone "escape" key, so settle on a real clock.
function makeSettle(setup: { renderOnce: () => Promise<void> }): () => Promise<void> {
    return async () => {
        await new Promise((r) => setTimeout(r, 35));
        await setup.renderOnce();
        await setup.renderOnce();
    };
}

describe("dialog host state machine (rendered, real keyboard bus)", () => {
    test("close reasons: esc → cancel, programmatic → commit, sweep → dismiss", async () => {
        const setup = await testRender(() => <Harness />, { width: 60, height: 20 });
        const settle = makeSettle(setup);
        const reasons: CloseReason[] = [];
        try {
            await settle();

            dialogPush(
                () => (
                    <box>
                        <text>A</text>
                    </box>
                ),
                (r) => reasons.push(r),
            );
            await settle();
            setup.mockInput.pressEscape();
            await settle();
            expect(reasons).toEqual(["cancel"]);
            expect(dialogIsOpen()).toBe(false);

            dialogPush(
                () => (
                    <box>
                        <text>B</text>
                    </box>
                ),
                (r) => reasons.push(r),
            );
            await settle();
            dialogClose();
            expect(reasons).toEqual(["cancel", "commit"]);

            dialogPush(
                () => (
                    <box>
                        <text>C</text>
                    </box>
                ),
                (r) => reasons.push(r),
            );
            dialogPush(
                () => (
                    <box>
                        <text>D</text>
                    </box>
                ),
                (r) => reasons.push(r),
            );
            await settle();
            dialogClear();
            expect(reasons).toEqual(["cancel", "commit", "dismiss", "dismiss"]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("busy prompt vetoes every dismissal; clearing busy re-enables cancel (fired once)", async () => {
        const setup = await testRender(() => <Harness />, { width: 80, height: 20 });
        const settle = makeSettle(setup);
        const [busy, setBusy] = createSignal(true);
        let cancels = 0;
        try {
            await settle();
            dialogPush(() => <PromptDialog title="P" busy={busy()} onSubmit={() => {}} onCancel={() => cancels++} />);
            await settle();

            setup.mockInput.pressEscape();
            await settle();
            expect(dialogIsOpen()).toBe(true);
            expect(dialogClose("dismiss")).toBe(false);
            expect(dialogIsOpen()).toBe(true);
            expect(cancels).toBe(0);

            setBusy(false);
            await settle();
            setup.mockInput.pressEscape();
            await settle();
            expect(dialogIsOpen()).toBe(false);
            expect(cancels).toBe(1);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("single-line prompt: typing lands in the input, enter submits, commit skips onCancel", async () => {
        const setup = await testRender(() => <Harness />, { width: 80, height: 20 });
        const settle = makeSettle(setup);
        let submitted = "";
        let cancels = 0;
        try {
            await settle();
            dialogPush(() => (
                <PromptDialog
                    title="Name"
                    onSubmit={(v) => {
                        submitted = v;
                        dialogClose();
                    }}
                    onCancel={() => cancels++}
                />
            ));
            await settle();

            await setup.mockInput.typeText("hi");
            await settle();
            setup.mockInput.pressEnter();
            await settle();
            expect(submitted).toBe("hi");
            expect(cancels).toBe(0);
            expect(dialogIsOpen()).toBe(false);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("stacking: covered dialog keeps its state and focus, its keys go inert, reveal restores both", async () => {
        const setup = await testRender(() => <Harness />, { width: 80, height: 24 });
        const settle = makeSettle(setup);
        let spyA = 0;

        function DialogA() {
            useDialogBindings(() => ({
                bindings: [{ chord: { key: "g", ctrl: true }, run: () => spyA++ }],
            }));
            return <PromptDialog title="A" value="ab" onSubmit={() => {}} onCancel={() => {}} />;
        }

        const frame = () =>
            setup
                .captureCharFrame()
                .split("\n")
                .map((l) => l.trimEnd())
                .join("\n");

        try {
            await settle();
            dialogPush(() => <DialogA />);
            await settle();

            // A's input is focused (host-applied initial focus); typing appends to the seed value.
            await setup.mockInput.typeText("c");
            await settle();
            expect(frame()).toContain("abc");
            setup.mockInput.pressKey("g", { ctrl: true });
            await settle();
            expect(spyA).toBe(1);

            // Cover A with B: only B is painted, A's layer is inert, typing goes to B.
            dialogPush(() => <PromptDialog title="B" value="zz" onSubmit={() => {}} onCancel={() => {}} />);
            await settle();
            expect(frame()).toContain("zz");
            expect(frame()).not.toContain("abc");
            setup.mockInput.pressKey("g", { ctrl: true });
            await settle();
            expect(spyA).toBe(1);
            await setup.mockInput.typeText("y");
            await settle();
            expect(frame()).toContain("zzy");

            // Reveal A: its typed state survived, its layer is live again, focus is back on its input.
            dialogClose();
            await settle();
            expect(frame()).toContain("abc");
            expect(frame()).not.toContain("zzy");
            setup.mockInput.pressKey("g", { ctrl: true });
            await settle();
            expect(spyA).toBe(2);
            await setup.mockInput.typeText("d");
            await settle();
            expect(frame()).toContain("abcd");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("grouped SelectList: scrolling back to the top reveals the first group header again", async () => {
        // The palette shape: the header is a row the cursor never lands on, so cursor-driven
        // scroll must pull it into view when the cursor returns to a group's first item.
        const items = [
            ...Array.from({ length: 14 }, (_, i) => ({ value: `a${i}`, title: `alpha item ${i}`, category: "Alpha" })),
            ...Array.from({ length: 14 }, (_, i) => ({ value: `b${i}`, title: `beta item ${i}`, category: "Beta" })),
        ];
        const setup = await testRender(() => <Harness />, { width: 80, height: 18 });
        const settle = makeSettle(setup);
        const frame = () => setup.captureCharFrame();
        try {
            await settle();
            dialogPush(() => <SelectList title="Pick" items={items} emptyText="none" grouped onSelect={() => {}} onCancel={() => {}} />);
            await settle();
            expect(frame()).toContain("Alpha");

            // Walk to the bottom: the list scrolls, the first header leaves the viewport.
            for (let i = 0; i < items.length - 1; i++) setup.mockInput.pressArrow("down");
            await settle();
            expect(frame()).toContain("beta item 13");
            expect(frame()).not.toContain("Alpha");

            // Walk back to the top: the cursor stops on item 0, and the header above it must
            // scroll back into view with it.
            for (let i = 0; i < items.length - 1; i++) setup.mockInput.pressArrow("up");
            await settle();
            expect(frame()).toContain("alpha item 0");
            expect(frame()).toContain("Alpha");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("click model: press inside + release outside does NOT dismiss; full outside click dismisses", async () => {
        const setup = await testRender(() => <Harness />, { width: 100, height: 30 });
        const settle = makeSettle(setup);
        const mouse = createMockMouse(setup.renderer);
        const reasons: CloseReason[] = [];
        try {
            await settle();
            // Click containment lives on DialogPanel, so the pushed content must use the real chrome.
            dialogPush(
                () => <PromptDialog title="Click" onSubmit={() => {}} onCancel={() => {}} />,
                (r) => reasons.push(r),
            );
            await settle();

            // The panel is centered: (50, 15) is inside it; (2, 2) is scrim.
            await mouse.pressDown(50, 15);
            await mouse.release(2, 2);
            await settle();
            expect(dialogIsOpen()).toBe(true);

            // The inside→outside drag left a text selection behind; the selection guard would
            // (correctly) swallow the next outside click, so clear it to test the plain-click path.
            setup.renderer.clearSelection();
            await mouse.pressDown(2, 2);
            await mouse.release(2, 2);
            await settle();
            expect(dialogIsOpen()).toBe(false);
            expect(reasons).toEqual(["dismiss"]);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("focus returns to the app widget at N→0", async () => {
        let ta!: TextareaRenderable;
        const setup = await testRender(() => <Harness onTa={(t) => (ta = t)} />, { width: 60, height: 20 });
        const settle = makeSettle(setup);
        try {
            await settle();
            expect(ta.focused).toBe(true);

            dialogPush(() => <PromptDialog title="P" onSubmit={() => {}} onCancel={() => {}} />);
            await settle();
            expect(ta.focused).toBe(false);

            setup.mockInput.pressEscape();
            await settle();
            // Restore is deferred a tick past unmount cleanup.
            await new Promise((r) => setTimeout(r, 10));
            await setup.renderOnce();
            expect(ta.focused).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("config screen over the dialog host (the swallowed-keystroke regression)", () => {
    test("typing s/q/space into the postgres-field prompt inserts characters and fires no form action", async () => {
        // Standalone ConfigApp: installs its own keymap root and DialogOverlay. The XDG sandbox
        // (test preload) gives it an isolated, defaults-only config.
        const setup = await testRender(() => <ConfigApp />, { width: 90, height: 34 });
        const settle = makeSettle(setup);
        const frame = () =>
            setup
                .captureCharFrame()
                .split("\n")
                .map((l) => l.trimEnd())
                .join("\n");
        try {
            await settle();

            // Walk to the last section (a postgres field — down past the end clamps) and open it.
            for (let i = 0; i < 40; i++) setup.mockInput.pressArrow("down");
            await settle();
            setup.mockInput.pressEnter();
            await settle();
            expect(frame()).toContain("postgres.");

            // `q` must type into the field, not exit the screen; `s` must not fire save;
            // space must not toggle anything. Any form action here is the old mode-gating bug.
            await setup.mockInput.typeText("q");
            await settle();
            expect(frame()).toContain("postgres.");
            await setup.mockInput.typeText("s ");
            await settle();
            expect(frame()).not.toContain("No changes to save.");
            expect(frame()).not.toContain("Saved.");
            expect(frame()).toContain("postgres.");

            // Esc (the host's structural key) closes the prompt and returns to the intact form.
            setup.mockInput.pressEscape();
            await settle();
            expect(frame()).not.toContain("postgres.password");
            expect(frame()).toContain("inflexa config");
        } finally {
            setup.renderer.destroy();
        }
    });
});
