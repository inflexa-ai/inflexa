import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, rgbToHex, type InputRenderable, type RGBA, type TextareaRenderable } from "@opentui/core";

import { DEFAULT_THEME_ID, themes } from "../lib/design_system.ts";
import { setTheme } from "./theme.ts";
import { TextArea } from "./components/text_area.tsx";
import { TextInput } from "./components/text_input.tsx";

// End-to-end guard for the focused-input-text fix (the `focusedTextColor` props on TextArea /
// TextInput). Both editors wrap opentui's TextareaRenderable, which keeps SEPARATE unfocused/focused
// text colors and picks by focus in updateColors(); its `set textColor` writes only the unfocused
// slot, so an editor given `textColor` but no `focusedTextColor` keeps opentui's #FFFFFF focused
// default — white-on-bgActive, invisible while you type on a light theme. captureCharFrame() sees
// characters only (the bug is a COLOR, not a missing glyph), so — like theme_contrast.render.test —
// this asserts on captureSpans()'s resolved fg (an RGBA).
//
// The mechanism that makes this a real regression guard: the editors mount focused (autoFocus
// defaults true), and each poll pass calls ref.focus() so `focused` is genuinely true at capture
// time (asserted below). That forces the FOCUSED color path — the one that painted #FFFFFF before
// the fix — so these assertions fail if the `focusedTextColor` prop is dropped. github-light is the
// sharpest case: bg is pure #ffffff (white-on-white is fully invisible) and fg is #24292f.
// Busy dimming must survive the focus split too, so the busy cases pin fgMuted, not fg.

const LIGHT = "github-light";
const WHITE = "#ffffff";

// The active theme is a module singleton; reset it after each case so order doesn't matter.
afterEach(() => {
    setTheme(DEFAULT_THEME_ID);
});

/** The fg of the FIRST captured span whose text contains `needle`, or undefined if none rendered. */
function spanFg(setup: Awaited<ReturnType<typeof testRender>>, needle: string): RGBA | undefined {
    for (const line of setup.captureSpans().lines) {
        for (const span of line.spans) {
            if (span.text.includes(needle)) return span.fg;
        }
    }
    return undefined;
}

/**
 * Render `node`, re-asserting focus on the editor each frame (mount focus can race prop application;
 * focus() is idempotent) and driving frames on real timers until the seeded text appears.
 */
async function renderFocused(
    node: Parameters<typeof testRender>[0],
    getRef: () => TextareaRenderable | InputRenderable | null,
    needle: string,
    timeoutMs = 3000,
): Promise<Awaited<ReturnType<typeof testRender>>> {
    const setup = await testRender(node, { width: 40, height: 4 });
    const start = Date.now();
    for (;;) {
        getRef()?.focus();
        await setup.renderOnce();
        if (setup.captureCharFrame().includes(needle) || Date.now() - start > timeoutMs) return setup;
        await new Promise((r) => setTimeout(r, 10));
    }
}

describe("focused-input contrast: focused editor text uses the theme fg, not white", () => {
    test("a focused TextArea renders its seeded text in the theme fg", async () => {
        setTheme(LIGHT);
        // Read the ref through a getter, not the closed-over variable directly: it is assigned only
        // inside the onRef callback, so TS's control-flow analysis would otherwise narrow it to null.
        let ref: TextareaRenderable | null = null;
        const getRef = (): TextareaRenderable | null => ref;
        const setup = await renderFocused(
            () => (
                <box width="100%" height="100%">
                    <TextArea
                        chrome="bare"
                        height={1}
                        initialValue="FOCUSEDAREA"
                        onRef={(r) => {
                            ref = r;
                        }}
                        onSubmit={() => {}}
                    />
                </box>
            ),
            getRef,
            "FOCUSEDAREA",
        );
        try {
            // Proves the FOCUSED path is what we measured — the unfocused color is already fg, so
            // without genuine focus this assertion could not distinguish the fix from the bug.
            expect(getRef()?.focused).toBe(true);
            const fg = spanFg(setup, "FOCUSEDAREA");
            expect(fg).toBeDefined();
            expect(fg && rgbToHex(fg)).not.toBe(WHITE);
            expect(fg && parseColor(themes[LIGHT].colors.fg).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a focused TextInput renders its seeded text in the theme fg", async () => {
        setTheme(LIGHT);
        let ref: InputRenderable | null = null;
        const getRef = (): InputRenderable | null => ref;
        const setup = await renderFocused(
            () => (
                <box width="100%" height="100%">
                    <TextInput
                        chrome="bare"
                        initialValue="FOCUSEDINPUT"
                        onRef={(r) => {
                            ref = r;
                        }}
                    />
                </box>
            ),
            getRef,
            "FOCUSEDINPUT",
        );
        try {
            expect(getRef()?.focused).toBe(true);
            const fg = spanFg(setup, "FOCUSEDINPUT");
            expect(fg).toBeDefined();
            expect(fg && rgbToHex(fg)).not.toBe(WHITE);
            expect(fg && parseColor(themes[LIGHT].colors.fg).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a focused busy TextArea dims to fgMuted (not white) in both focus states", async () => {
        setTheme(LIGHT);
        let ref: TextareaRenderable | null = null;
        const getRef = (): TextareaRenderable | null => ref;
        const setup = await renderFocused(
            () => (
                <box width="100%" height="100%">
                    <TextArea
                        chrome="bare"
                        height={1}
                        busy={true}
                        initialValue="BUSYAREA"
                        onRef={(r) => {
                            ref = r;
                        }}
                        onSubmit={() => {}}
                    />
                </box>
            ),
            getRef,
            "BUSYAREA",
        );
        try {
            expect(getRef()?.focused).toBe(true);
            const fg = spanFg(setup, "BUSYAREA");
            expect(fg).toBeDefined();
            expect(fg && rgbToHex(fg)).not.toBe(WHITE);
            expect(fg && parseColor(themes[LIGHT].colors.fgMuted).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a focused busy TextInput dims to fgMuted (not white) in both focus states", async () => {
        setTheme(LIGHT);
        let ref: InputRenderable | null = null;
        const getRef = (): InputRenderable | null => ref;
        const setup = await renderFocused(
            () => (
                <box width="100%" height="100%">
                    <TextInput
                        chrome="bare"
                        busy={true}
                        initialValue="BUSYINPUT"
                        onRef={(r) => {
                            ref = r;
                        }}
                    />
                </box>
            ),
            getRef,
            "BUSYINPUT",
        );
        try {
            expect(getRef()?.focused).toBe(true);
            const fg = spanFg(setup, "BUSYINPUT");
            expect(fg).toBeDefined();
            expect(fg && rgbToHex(fg)).not.toBe(WHITE);
            expect(fg && parseColor(themes[LIGHT].colors.fgMuted).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});
