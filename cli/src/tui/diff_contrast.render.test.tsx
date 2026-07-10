import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, rgbToHex, type RGBA } from "@opentui/core";

import { DEFAULT_THEME_ID, themes, type ThemeId } from "../lib/design_system.ts";
import { setTheme } from "./theme.ts";
import { DiffBlock } from "./components/diff_block.tsx";

// End-to-end guard for the diff token group (design_system.ts's diffAddedBg/diffRemovedBg + the
// <diff> band/sign/line-number props in diff_block.tsx). captureCharFrame() sees characters only, so
// it cannot catch this — the regression is a COLOR. captureSpans() exposes each rendered cell's
// resolved fg AND bg (RGBA), which is the mechanism these assertions read.
//
// The regression it pins: a bare <diff> falls back to opentui's hardcoded, dark-only defaults —
// #1a4d1a/#4d1a1a row bands and #888888 line numbers — which look wrong on light themes and fail AA.
// Verified against the counterfactual with a probe render: without the props the added/removed
// content cells carry #1a4d1a/#4d1a1a and the gutter carries #888888, so these assertions genuinely
// fail if the props are dropped. One dark theme and one light theme are both exercised because the
// bands are per-theme tints that differ in direction (dark bands vs light pastels).

// Distinct tokens per line so each content span is found unambiguously (the removed and added lines
// must not share a needle). No digits in the content, so a bare-digit span is unambiguously a line
// number (not the DiffBlock's "+1"/"—1" stats span). Context lines carry the transparent contextBg
// default, so they are not asserted.
const DIFF = ["--- a/q.sql", "+++ b/q.sql", "@@ -1,3 +1,3 @@", " CTXKEEP first", "-ROWGONE removed", "+ROWNEW added", " CTXKEEP last"].join("\n");

const OPENTUI_ADDED_BG = "#1a4d1a";
const OPENTUI_REMOVED_BG = "#4d1a1a";
const OPENTUI_LINE_NUMBER_FG = "#888888";

// The active theme is a module singleton; reset it after each case so order doesn't matter.
afterEach(() => {
    setTheme(DEFAULT_THEME_ID);
});

/** Render the DiffBlock, driving frames on real timers until the diff has parsed (async tree-sitter). */
async function renderDiff(id: ThemeId): Promise<Awaited<ReturnType<typeof testRender>>> {
    setTheme(id);
    const setup = await testRender(
        () => (
            <box width="100%" height="100%">
                <DiffBlock path="q.sql" diff={DIFF} added={1} removed={1} />
            </box>
        ),
        { width: 72, height: 20 },
    );
    const start = Date.now();
    for (;;) {
        await setup.renderOnce();
        if (setup.captureCharFrame().includes("ROWNEW") || Date.now() - start > 3000) return setup;
        await new Promise((r) => setTimeout(r, 10));
    }
}

type Span = { fg: RGBA; bg: RGBA };

/** The FIRST captured span satisfying `match`, or undefined if none rendered. */
function findSpan(setup: Awaited<ReturnType<typeof testRender>>, match: (text: string) => boolean): Span | undefined {
    for (const line of setup.captureSpans().lines) {
        for (const span of line.spans) {
            if (match(span.text)) return { fg: span.fg, bg: span.bg };
        }
    }
    return undefined;
}

describe("theme-contrast AA: diff bands, signs, and line numbers are themed, not opentui defaults", () => {
    for (const id of ["tokyo-night", "github-light"] as const) {
        test(`under ${id} the diff renders themed bands and no opentui defaults`, async () => {
            const setup = await renderDiff(id);
            try {
                const colors = themes[id].colors;

                // (a) None of opentui's hardcoded diff defaults survive anywhere in the frame.
                for (const line of setup.captureSpans().lines) {
                    for (const span of line.spans) {
                        expect(rgbToHex(span.bg)).not.toBe(OPENTUI_ADDED_BG);
                        expect(rgbToHex(span.bg)).not.toBe(OPENTUI_REMOVED_BG);
                        expect(rgbToHex(span.fg)).not.toBe(OPENTUI_LINE_NUMBER_FG);
                    }
                }

                // (b) The band behind each changed line is that theme's diff token, and the diff text on it
                // stays the theme fg (the band is the cell bg, not a re-color of the content).
                const added = findSpan(setup, (t) => t.includes("ROWNEW"));
                const removed = findSpan(setup, (t) => t.includes("ROWGONE"));
                expect(added).toBeDefined();
                expect(removed).toBeDefined();
                expect(added && parseColor(colors.diffAddedBg).equals(added.bg)).toBe(true);
                expect(removed && parseColor(colors.diffRemovedBg).equals(removed.bg)).toBe(true);
                expect(added && parseColor(colors.fg).equals(added.fg)).toBe(true);

                // The +/− signs reuse success/error and the gutter reuses fgMuted (no dedicated tokens).
                // The sign spans are " +"/" -" (leading space) — distinct from the header's "+1"/"—1" stats.
                const plusSign = findSpan(setup, (t) => t === " +");
                const minusSign = findSpan(setup, (t) => t === " -");
                expect(plusSign && parseColor(colors.success).equals(plusSign.fg)).toBe(true);
                expect(minusSign && parseColor(colors.error).equals(minusSign.fg)).toBe(true);

                // A line-number gutter cell (a bare-digit span) uses fgMuted.
                const lineNumber = findSpan(setup, (t) => /^\s*\d+\s*$/.test(t));
                expect(lineNumber && parseColor(colors.fgMuted).equals(lineNumber.fg)).toBe(true);
            } finally {
                setup.renderer.destroy();
            }
        });
    }
});
