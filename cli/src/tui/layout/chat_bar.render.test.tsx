import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, type RGBA } from "@opentui/core";

import { DEFAULT_THEME_ID, themes } from "../../lib/design_system.ts";
import { setTheme } from "../theme.ts";
import { ChatBar } from "./chat_bar.tsx";

// The footer interrupt hint carries its OWN color: muted for the resting esc / one-press abort forms, warn
// for the armed "again to interrupt" form — and warn must stay distinct from the accent NORMAL mode word on
// the same bgActive row. A character frame cannot see a color, so these assert on the span's resolved fg via
// captureSpans (the mechanism from theme_contrast.render.test.tsx) on github-light, whose pure-#ffffff bg is
// the sharpest case for an accidentally-white span. autoFocus seeds the footer mode word without a real
// focus-grab (see ChatBar.autoFocus), so an isolated render pins each mode's footer directly.
const LIGHT = "github-light";

/** The fg of the first captured span whose text contains `needle`, or undefined if none rendered. */
function spanFg(setup: Awaited<ReturnType<typeof testRender>>, needle: string): RGBA | undefined {
    for (const line of setup.captureSpans().lines) {
        for (const span of line.spans) {
            if (span.text.includes(needle)) return span.fg;
        }
    }
    return undefined;
}

/** Render a ChatBar with a distinct hint label so the span search never collides with the mode/newline words. */
function renderChatBar(opts: { autoFocus: boolean; label: string; armed: boolean }): Promise<Awaited<ReturnType<typeof testRender>>> {
    setTheme(LIGHT);
    return testRender(
        () => <ChatBar autoFocus={opts.autoFocus} onTextareaRef={() => {}} onSubmit={() => {}} interruptHint={{ label: opts.label, armed: opts.armed }} />,
        { width: 80, height: 6 },
    );
}

describe("ChatBar footer interrupt hint", () => {
    // The active theme is a module singleton; reset it after each case so order doesn't matter.
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    test("busy NORMAL, unarmed → the hint renders muted, beside the NORMAL mode word", async () => {
        const setup = await renderChatBar({ autoFocus: false, label: "UNARMEDHINT", armed: false });
        try {
            await setup.renderOnce();
            const hint = spanFg(setup, "UNARMEDHINT");
            expect(hint).toBeDefined();
            expect(hint && parseColor(themes[LIGHT].colors.fgMuted).equals(hint)).toBe(true);
            // The NORMAL mode word is the row the hint sits beside.
            expect(setup.captureCharFrame()).toContain("NORMAL");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("busy NORMAL, armed → the hint renders in warn, distinct from the accent NORMAL word", async () => {
        const setup = await renderChatBar({ autoFocus: false, label: "ARMEDHINT", armed: true });
        try {
            await setup.renderOnce();
            const hint = spanFg(setup, "ARMEDHINT");
            const mode = spanFg(setup, "NORMAL");
            expect(hint).toBeDefined();
            expect(mode).toBeDefined();
            // Armed → the warn role, which clears AA text contrast on the bgActive row.
            expect(hint && parseColor(themes[LIGHT].colors.warning).equals(hint)).toBe(true);
            // The NORMAL word is the accent role...
            expect(mode && parseColor(themes[LIGHT].colors.accent).equals(mode)).toBe(true);
            // ...and the armed hint is visually distinct from it on the same row.
            expect(hint && mode && hint.equals(mode)).toBe(false);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("busy INSERT → the one-press abort-chord hint renders muted, beside the INSERT mode word", async () => {
        const setup = await renderChatBar({ autoFocus: true, label: "INSERTHINT", armed: false });
        try {
            await setup.renderOnce();
            const hint = spanFg(setup, "INSERTHINT");
            expect(hint).toBeDefined();
            expect(hint && parseColor(themes[LIGHT].colors.fgMuted).equals(hint)).toBe(true);
            expect(setup.captureCharFrame()).toContain("INSERT");
        } finally {
            setup.renderer.destroy();
        }
    });
});
