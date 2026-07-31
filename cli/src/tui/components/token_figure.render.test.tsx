import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, type RGBA } from "@opentui/core";

import { TokenFigure, type TokenFigureProps } from "./token_figure.tsx";
import { DEFAULT_THEME_ID, GLYPHS, themes } from "../../lib/design_system.ts";
import { setTheme } from "../theme.ts";

// The component that turns recorded quantities into pixels, in both written forms. What needs a FRAME
// rather than a unit test on `lib/usage_format.ts` is everything the writing cannot state: where the
// two arms land across a width, that the parts of an arm stay indented under it, and — since a frame
// carries no color — that every span resolves a foreground rather than falling through to opentui's
// white default, which is invisible on the light themes.

/** The pure-#ffffff light theme: an unresolved foreground scores 1.00:1 here, so it cannot hide. */
const LIGHT = "github-light";

/** Render one figure at a fixed width and return its lines, trailing padding stripped. */
async function linesOf(props: TokenFigureProps, width = 40): Promise<string[]> {
    const setup = await testRender(() => <TokenFigure {...props} />, { width, height: 8 });
    try {
        await setup.renderOnce();
        return setup
            .captureCharFrame()
            .split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => l !== "");
    } finally {
        // A leaked renderer holds native handles open and can segfault a later render (CLAUDE.md).
        setup.renderer.destroy();
    }
}

/** Every resolved span foreground in the render, keyed by the span's text. */
async function spansOf(props: TokenFigureProps, width = 40): Promise<Map<string, RGBA>> {
    const setup = await testRender(() => <TokenFigure {...props} />, { width, height: 8 });
    try {
        await setup.renderOnce();
        const out = new Map<string, RGBA>();
        for (const line of setup.captureSpans().lines) {
            for (const span of line.spans) if (span.text.trim() !== "") out.set(span.text, span.fg);
        }
        return out;
    } finally {
        setup.renderer.destroy();
    }
}

describe("TokenFigure — the long form", () => {
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    test("the two arms sit at opposite edges of one row, with each arm's parts indented under it", async () => {
        const lines = await linesOf({
            quantities: { inputTokens: 820_300, outputTokens: 43_300, cacheCreationInputTokens: 195_900, cacheReadInputTokens: 624_300 },
            variant: "long",
        });

        // ONE row for the arms — the layout no longer stacks them, which is what the rail's USAGE
        // section was rebuilt for. Input leads; output is pushed flush against the trailing edge, so
        // its figure ends at (or one cell short of) the last column rather than floating mid-width.
        expect(lines[0]).toContain("820.3k in");
        expect(lines[0]).toContain("43.3k out");
        expect(lines[0]!.indexOf("820.3k in")).toBe(0);
        expect(lines[0]!.trimEnd().endsWith("43.3k out")).toBe(true);

        // The cache counts are parts OF the input total. Indented under it and BELOW the arms' row —
        // level them onto the arm row and the reader is invited to add a cached prefix to the total it
        // is already inside, which is the one sum this notation exists to prevent.
        expect(lines[1]).toBe("  cache write 195.9k");
        expect(lines[2]).toBe("  cache read 624.3k");
    });

    test("an arm the provider never reported keeps its column and says so, rather than vanishing", async () => {
        const lines = await linesOf({ quantities: { inputTokens: 900 }, variant: "long" });

        // Not a zero — the ledger holds no output measurement here — and not an omission either: a
        // reader scanning the trailing edge for the output figure has to find the absence where the
        // figure would have been, or they read a half figure as a whole one.
        expect(lines[0]).toContain("900 in");
        expect(lines[0]).toContain("not reported");
        expect(lines.join("\n")).not.toContain("0 out");
    });

    test("every span resolves a foreground, so the figure survives a light theme", async () => {
        setTheme(LIGHT);
        const spans = await spansOf({
            quantities: { inputTokens: 820_300, outputTokens: 43_300, cacheReadInputTokens: 624_300 },
            variant: "long",
        });
        const colors = themes[LIGHT].colors;

        // A frame assertion cannot prove legibility: `toContain` passes identically on a span painted
        // white on white. The quantities are data-toned and the part's LABEL is muted — the label is
        // the decoration, the number beside it is the fact.
        expect(spans.get("820.3k in")?.equals(parseColor(colors.fg))).toBe(true);
        expect(spans.get("43.3k out")?.equals(parseColor(colors.fg))).toBe(true);
        expect(spans.get("624.3k")?.equals(parseColor(colors.fg))).toBe(true);
        expect(spans.get("  cache read ")?.equals(parseColor(colors.fgMuted))).toBe(true);
    });
});

describe("TokenFigure — the short form", () => {
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    test("both arms ride one line behind the reader's-seat arrows", async () => {
        const lines = await linesOf({ quantities: { inputTokens: 820_300, outputTokens: 43_300 }, variant: "short" });
        expect(lines).toEqual([`${GLYPHS.arrowUp}820.3k ${GLYPHS.arrowDown}43.3k`]);
    });

    test("the indent step is the one the rail nests every decoration at", async () => {
        const lines = await linesOf({ quantities: { inputTokens: 900 }, variant: "short", indent: true });
        expect(lines).toEqual([`  ${GLYPHS.arrowUp}900`]);
    });

    test("calls that reported no quantity render the absence glyph, not a zero and not a blank row", async () => {
        setTheme(LIGHT);
        const lines = await linesOf({ quantities: {}, variant: "short" });
        // The row it decorates is still there, so the decoration must be too — an omitted line would
        // silently shorten a list its reader is scanning down.
        expect(lines).toEqual([GLYPHS.emDash]);

        const spans = await spansOf({ quantities: {}, variant: "short" });
        expect(spans.get(GLYPHS.emDash)?.equals(parseColor(themes[LIGHT].colors.fgMuted))).toBe(true);
    });
});
