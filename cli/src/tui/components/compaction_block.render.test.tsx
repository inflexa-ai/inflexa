import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";

import { renderFrame } from "../../test_support/tui.ts";
import { DEFAULT_THEME_ID, GLYPHS, themes } from "../../lib/design_system.ts";
import { setTheme } from "../theme.ts";
import { CompactionBlock, type CompactionBlockProps } from "./compaction_block.tsx";

const FORMS: Record<string, CompactionBlockProps> = {
    running: { status: "running", tokensBefore: 162_000 },
    done: { status: "done", tokensBefore: 162_000, tokensAfter: 14_000, durationMs: 21_000 },
    "failed with a drop": { status: "failed", tokensBefore: 170_000, tokensAfter: 90_000, durationMs: 3_000 },
    "failed with no drop": { status: "failed", tokensBefore: 170_000, durationMs: 3_000 },
};

function frameOf(props: CompactionBlockProps, width = 100): Promise<string> {
    return renderFrame(() => <CompactionBlock {...props} />, { width, height: 4 });
}

describe("CompactionBlock", () => {
    test("shows one muted progress line and no rule while running", async () => {
        const frame = await frameOf(FORMS.running!);

        expect(frame).toBe(`Summarizing earlier conversation${GLYPHS.ellipsis}`);
    });

    test("shows a divider with the two token figures and the duration when done", async () => {
        const frame = await frameOf(FORMS.done!);

        expect(frame.startsWith(GLYPHS.lineHorizontal)).toBe(true);
        expect(frame.endsWith(GLYPHS.lineHorizontal)).toBe(true);
        expect(frame).toContain(`Summarized earlier conversation ${GLYPHS.middot} 162.0k ${GLYPHS.arrowRight} 14.0k ${GLYPHS.middot} 21.0s`);
        expect(frame.split("\n")).toHaveLength(1);
        expect([...frame]).toHaveLength(100);
    });

    test("names the drop and the two token figures of a failed compaction that dropped turns", async () => {
        const frame = await frameOf(FORMS["failed with a drop"]!);

        expect(frame).toContain(
            `Could not summarize earlier conversation ${GLYPHS.middot} dropped the oldest turns ${GLYPHS.middot} 170.0k ${GLYPHS.arrowRight} 90.0k`,
        );
        expect(frame.startsWith(GLYPHS.lineHorizontal)).toBe(true);
    });

    test("names no drop for a failed compaction with no tokens after", async () => {
        const frame = await frameOf(FORMS["failed with no drop"]!);

        expect(frame).toContain("Could not summarize earlier conversation");
        expect(frame).not.toContain("dropped");
        expect(frame).not.toContain(GLYPHS.arrowRight);
    });

    test("wraps the label on a narrow terminal and keeps each word", async () => {
        const frame = await frameOf(FORMS["failed with a drop"]!, 40);

        for (const word of ["Could", "summarize", "dropped", "oldest", "170.0k", "90.0k"]) expect(frame).toContain(word);
    });
});

describe("CompactionBlock on a light theme", () => {
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    test.each(Object.entries(FORMS))("paints each span of the %s form with a theme color", async (_form, props) => {
        setTheme("github-light");
        const colors = themes["github-light"].colors;
        const setup = await testRender(() => <CompactionBlock {...props} />, { width: 100, height: 4 });
        try {
            await setup.renderOnce();
            const spans = setup
                .captureSpans()
                .lines.flatMap((line) => line.spans)
                .filter((span) => span.text.trim().length > 0);
            expect(spans.length).toBeGreaterThan(0);
            for (const span of spans) {
                const isLabel = /[a-z]/i.test(span.text);
                const expected = isLabel ? colors.fgMuted : colors.fgSubtle;
                expect({ text: span.text.trim(), matches: parseColor(expected).equals(span.fg) }).toEqual({ text: span.text.trim(), matches: true });
            }
        } finally {
            setup.renderer.destroy();
        }
    });
});
