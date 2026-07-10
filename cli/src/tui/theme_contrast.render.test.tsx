import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, rgbToHex, type RGBA } from "@opentui/core";

import { DEFAULT_THEME_ID, themes } from "../lib/design_system.ts";
import { setTheme, syntaxStyle, theme } from "./theme.ts";
import { ToolBlock } from "./components/tool_block.tsx";

// End-to-end guard for the theme-contrast fix (design_system.ts's "default" syntax scope + the
// tool_block <code> fg prop). captureCharFrame() gives characters only, so it cannot see the bug —
// the failure is a COLOR, not a missing glyph. The test harness's captureSpans() exposes each
// rendered span's resolved fg (an RGBA), which is the mechanism this test asserts on.
//
// The regression it pins: an un-captured span (a markdown pipe-table DATA cell; a plain-text tool
// result the <code> renderable paints via setText with no highlights) used to fall through to
// opentui's built-in #FFFFFF foreground — invisible on a white light theme. Verified against the
// counterfactual (a default-less SyntaxStyle / a bare <code> without fg both paint #ffffff), so
// these assertions genuinely fail if either fix is reverted. github-light is the sharpest case: its
// bg is pure #ffffff, so white-on-white is fully invisible; its fg is #24292f (near-black).

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

/** Render `node`, driving frames on real timers until `needle` appears (markdown/code parse async). */
async function renderUntil(node: Parameters<typeof testRender>[0], needle: string, timeoutMs = 3000): Promise<Awaited<ReturnType<typeof testRender>>> {
    const setup = await testRender(node, { width: 60, height: 12 });
    const start = Date.now();
    for (;;) {
        await setup.renderOnce();
        if (setup.captureCharFrame().includes(needle) || Date.now() - start > timeoutMs) return setup;
        await new Promise((r) => setTimeout(r, 10));
    }
}

describe("theme-contrast AA: un-captured spans use the theme fg, not white", () => {
    test("a markdown pipe-table data cell renders in the theme fg", async () => {
        setTheme(LIGHT);
        const md = ["| Column |", "| --- |", "| CELLDATA |"].join("\n");
        // The production markdown config (see MessageBlock): fg + active syntaxStyle, streaming pinned true.
        const setup = await renderUntil(
            () => (
                <box width="100%" height="100%">
                    <markdown content={md} fg={theme().fg} syntaxStyle={syntaxStyle()} streaming={true} internalBlockMode="top-level" />
                </box>
            ),
            "CELLDATA",
        );
        try {
            const fg = spanFg(setup, "CELLDATA");
            expect(fg).toBeDefined();
            expect(fg && rgbToHex(fg)).not.toBe(WHITE);
            expect(fg && parseColor(themes[LIGHT].colors.fg).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a ToolBlock plain-text result renders in the theme fg", async () => {
        setTheme(LIGHT);
        const setup = await renderUntil(
            () => (
                <box width="100%" height="100%">
                    <ToolBlock name="read_file" result={"UNIQUEPLAINTEXT no highlights here"} filetype="text" status="ok" />
                </box>
            ),
            "UNIQUEPLAINTEXT",
        );
        try {
            const fg = spanFg(setup, "UNIQUEPLAINTEXT");
            expect(fg).toBeDefined();
            expect(fg && rgbToHex(fg)).not.toBe(WHITE);
            expect(fg && parseColor(themes[LIGHT].colors.fg).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});
