import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, rgbToHex } from "@opentui/core";

import { DEFAULT_THEME_ID, GLYPHS, MARKERS, themes } from "../../lib/design_system.ts";
import { renderFrame } from "../../test_support/tui.ts";
import { mockAnalogyReports } from "../layout/design_gallery_fixtures.ts";
import { setTheme } from "../theme.ts";
import { AnalogyReportBlock } from "./analogy_report_block.tsx";

const SIZE = { width: 100, height: 40 };

type Setup = Awaited<ReturnType<typeof testRender>>;

function frameOf(setup: Setup): string {
    return setup.captureCharFrame();
}

/** The resolved fg of the first span whose text contains `needle`. */
function fgOf(setup: Setup, needle: string): string | undefined {
    for (const line of setup.captureSpans().lines) {
        for (const span of line.spans) {
            if (span.text.includes(needle)) return rgbToHex(span.fg);
        }
    }
    return undefined;
}

function sameColor(hex: string | undefined, expected: string): boolean {
    return hex !== undefined && parseColor(hex).equals(parseColor(expected));
}

async function clickOn(setup: Setup, needle: string): Promise<void> {
    const lines = frameOf(setup).split("\n");
    const y = lines.findIndex((line) => line.includes(needle));
    expect(y).toBeGreaterThanOrEqual(0);
    await setup.mockMouse.click(lines[y]?.indexOf(needle) ?? 0, y);
    await setup.renderOnce();
}

describe("AnalogyReportBlock", () => {
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    test("starts collapsed: the counts, the problem, and the analogy and solution titles, with no detail", async () => {
        const setup = await testRender(() => <AnalogyReportBlock view={mockAnalogyReports.full} />, SIZE);
        try {
            await setup.renderOnce();
            const frame = frameOf(setup);
            expect(frame).toContain(`${GLYPHS.triangleRight} Analogies ${GLYPHS.middot} 2 domains ${GLYPHS.middot} 2 with solutions`);
            expect(frame).toContain("for: Robust expression control under noisy induction");
            expect(frame).toContain(`1 control_theory ${GLYPHS.middot} Gene circuit as a feedback loop`);
            expect(frame).toContain("Model predictive control");
            expect(frame).toContain("Safety-stock policy");
            expect(frame).not.toContain(`promoter ${GLYPHS.arrowRight} controller`);
            expect(frame).not.toContain("Plans the inducer dose");
            expect(frame).not.toContain("https://arxiv.org/abs/2103.04120");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a click on the header expands the block, and a second click collapses it", async () => {
        const setup = await testRender(() => <AnalogyReportBlock view={mockAnalogyReports.full} />, SIZE);
        try {
            await setup.renderOnce();
            await clickOn(setup, "Analogies");
            const expanded = frameOf(setup);
            expect(expanded).toContain(`${GLYPHS.triangleDown} Analogies`);
            expect(expanded).toContain(`promoter ${GLYPHS.arrowRight} controller ${GLYPHS.middot} repressor ${GLYPHS.arrowRight} actuator`);
            expect(expanded).toContain("Plans the inducer dose");
            expect(expanded).toContain("https://arxiv.org/abs/2103.04120");

            await clickOn(setup, "Analogies");
            const collapsed = frameOf(setup);
            expect(collapsed).toContain(`${GLYPHS.triangleRight} Analogies`);
            expect(collapsed).not.toContain("Plans the inducer dose");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("paints search_failed in the error role and the other coverage states in the muted role", async () => {
        setTheme("github-light");
        const colors = themes["github-light"].colors;
        const setup = await testRender(() => <AnalogyReportBlock view={mockAnalogyReports.partial} />, SIZE);
        try {
            await setup.renderOnce();
            expect(frameOf(setup)).toContain(`4 domains ${GLYPHS.middot} 1 with solutions`);
            expect(sameColor(fgOf(setup, "search failed"), colors.error)).toBe(true);
            expect(sameColor(fgOf(setup, "no data"), colors.fgMuted)).toBe(true);
            expect(sameColor(fgOf(setup, "not loaded"), colors.fgMuted)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("counts each target domain one time", async () => {
        const view = { ...mockAnalogyReports.partial, analogies: mockAnalogyReports.partial.analogies.map((analogy) => ({ ...analogy, domain: "logistics" })) };
        const frame = await renderFrame(() => <AnalogyReportBlock view={view} />, SIZE);
        expect(frame).toContain(`Analogies ${GLYPHS.middot} 1 domain ${GLYPHS.middot} 1 with solutions`);
    });

    test("a failed report is an error block with the message as its detail, and a click leaves the frame as it was", async () => {
        const setup = await testRender(() => <AnalogyReportBlock view={mockAnalogyReports.failed} />, SIZE);
        try {
            await setup.renderOnce();
            const before = frameOf(setup);
            expect(before).toContain(`${MARKERS.error.glyph} Analogy report failed`);
            expect(before).toContain("The problem is empty or incoherent");
            await clickOn(setup, "Analogy report failed");
            expect(frameOf(setup)).toBe(before);
        } finally {
            setup.renderer.destroy();
        }
    });
});
