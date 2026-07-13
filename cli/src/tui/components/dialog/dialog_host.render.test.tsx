import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { testRender } from "@opentui/solid";
import { createMockMouse } from "@opentui/core/testing";
import type { InputRenderable, TextareaRenderable } from "@opentui/core";

import { useKeymapRoot } from "../../keymap.ts";
import { GLYPHS } from "../../../lib/design_system.ts";
import { TextInput } from "../text_input.tsx";
import { DialogOverlay, dialogPush, dialogClose, dialogClear, dialogIsOpen, useDialogBindings, useDialogEntry, type CloseReason } from "./dialog_host.tsx";
import { PromptDialog } from "./prompt_dialog.tsx";
import { SelectDialog } from "./select_dialog.tsx";
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

    test("grouped SelectDialog: scrolling back to the top reveals the first group header again", async () => {
        // The palette shape: the header renders inside its group-starting row's box, so cursor-
        // driven scroll must bring it back into view when the cursor returns to that first item.
        const items = [
            ...Array.from({ length: 14 }, (_, i) => ({ value: `a${i}`, title: `alpha item ${i}`, category: "Alpha" })),
            ...Array.from({ length: 14 }, (_, i) => ({ value: `b${i}`, title: `beta item ${i}`, category: "Beta" })),
        ];
        const setup = await testRender(() => <Harness />, { width: 80, height: 18 });
        const settle = makeSettle(setup);
        const frame = () => setup.captureCharFrame();
        try {
            await settle();
            dialogPush(() => <SelectDialog title="Pick" items={items} emptyText="none" onSelect={() => {}} onCancel={() => {}} />);
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

    test("close-then-open keeps the next dialog's initial focus and the app restore chain", async () => {
        // The palette pattern: onSelect closes the palette, then the command pushes its own
        // dialog in the same tick. The overlay's deferred app-focus restore (scheduled at N→0)
        // must NOT fire into the newly opened dialog — and the saved app focus must survive for
        // the eventual real N→0 close.
        function Probe(props: { onRef: (r: InputRenderable) => void }): JSX.Element {
            const dialog = useDialogEntry();
            return (
                <box>
                    <TextInput
                        chrome="bare"
                        autoFocus={false}
                        onRef={(r: InputRenderable) => {
                            props.onRef(r);
                            dialog?.setInitialFocus(r);
                        }}
                    />
                </box>
            );
        }
        let ta: TextareaRenderable | null = null;
        let probeInput: InputRenderable | null = null;
        const setup = await testRender(() => <Harness onTa={(r) => (ta = r)} />, { width: 60, height: 20 });
        const settle = makeSettle(setup);
        try {
            await settle();
            expect(setup.renderer.currentFocusedRenderable?.id).toBe(ta!.id); // app focus = chat textarea

            dialogPush(() => (
                <box>
                    <text>palette stand-in</text>
                </box>
            ));
            await settle();

            // Same tick: close the "palette", push the command's dialog (the NewAnalysisDialog shape).
            dialogClose();
            dialogPush(() => <Probe onRef={(r) => (probeInput = r)} />);
            await settle(); // > the 1ms restore timer

            const focusedId = setup.renderer.currentFocusedRenderable?.id;
            expect(focusedId).toBe(probeInput!.id); // the dialog keeps its focus
            expect(focusedId).not.toBe(ta!.id);

            dialogClose(); // real N→0: the app focus restore chain must still work
            await settle();
            expect(setup.renderer.currentFocusedRenderable?.id).toBe(ta!.id);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("multi SelectDialog: space types while filtering, esc unlocks list keys, space toggles, enter confirms", async () => {
        // The INSERT/NORMAL-lite seam: with the filter focused, space MUST reach the input as a
        // character (bare-printable rule); the first esc is consumed by the close-guard veto
        // (blur, dialog stays open), unlocking space-to-toggle.
        const items = [
            { value: "a", title: "alpha" },
            { value: "b", title: "beta" },
            { value: "c", title: "gamma" },
        ];
        const confirmed: string[][] = [];
        const setup = await testRender(() => <Harness />, { width: 80, height: 20 });
        const settle = makeSettle(setup);
        const frame = () => setup.captureCharFrame();
        try {
            await settle();
            dialogPush(() => (
                <SelectDialog
                    title="Pick many"
                    items={items}
                    emptyText="none"
                    mode="multi"
                    initialSelected={new Set(["c"])}
                    onConfirm={(vs) => confirmed.push(vs)}
                    onCancel={() => {}}
                />
            ));
            await settle();
            expect(frame()).toContain(`${GLYPHS.circle} gamma`); // seed renders filled
            expect(frame()).toContain("1 selected");

            await setup.mockInput.typeText("al");
            setup.mockInput.pressKey(" "); // INSERT: types into the filter, must NOT toggle
            await settle();
            expect(frame()).toContain("alpha");
            expect(frame()).not.toContain("beta"); // "al " trims to "al" for ranking
            expect(frame()).toContain("1 selected"); // ...so the count is untouched

            setup.mockInput.pressEscape(); // guard veto: blur to list keys, dialog stays open
            await settle();
            expect(frame()).toContain("Pick many");

            setup.mockInput.pressKey(" "); // NORMAL: toggles the cursor row (alpha)
            await settle();
            expect(frame()).toContain(`${GLYPHS.circle} alpha`);
            expect(frame()).toContain("2 selected");

            setup.mockInput.pressEnter();
            await settle();
            expect(confirmed.length).toBe(1);
            expect([...confirmed[0]!].sort()).toEqual(["a", "c"]);
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

            // Walk to the last section — the postgres password field — and open its edit prompt.
            // Section nav wraps end-to-end, so the count must be exact: overshooting loops back to
            // the top. Sections are the telemetry toggle, the theme + runtime radios, then the five
            // postgres fields (host/port/database/user/password), so the last sits 7 steps down.
            for (let i = 0; i < 7; i++) setup.mockInput.pressArrow("down");
            await settle();
            setup.mockInput.pressEnter();
            await settle();
            expect(frame()).toContain("postgres.password");

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
