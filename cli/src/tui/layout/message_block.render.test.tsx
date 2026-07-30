import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, type RGBA } from "@opentui/core";

import { DEFAULT_THEME_ID, GLYPHS, themes } from "../../lib/design_system.ts";
import { setTheme } from "../theme.ts";
import { formatTurnUsage, MessageBlock } from "./message_block.tsx";
import type { TurnUsage } from "../../modules/harness/turn.ts";
import type { Part } from "../../types/session.ts";

// The interrupted marker is a muted suffix on an assistant turn that streamed before being aborted. A
// character frame cannot prove the color, so this asserts on the span's resolved fg via captureSpans (the
// mechanism from theme_contrast.render.test.tsx) on github-light, whose pure-#ffffff bg is the sharpest
// case for an accidentally-white span.
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

/** An assistant turn with one body part; the header props under test are passed straight through. */
function renderAssistant(header: { interrupted?: boolean; durationMs?: number; turnUsage?: TurnUsage } = {}): ReturnType<typeof testRender> {
    const parts: Part[] = [{ id: "p1", sessionId: "s", messageId: "m", type: "text", text: "an answer that began", createdAt: 0 }];
    return testRender(
        () => (
            <MessageBlock
                index={1}
                role="assistant"
                parts={parts}
                interrupted={header.interrupted}
                durationMs={header.durationMs}
                turnUsage={header.turnUsage}
                streamPartId={() => null}
                streamText={() => ""}
            />
        ),
        { width: 60, height: 10 },
    );
}

describe("MessageBlock interrupted marker", () => {
    // The active theme is a module singleton; reset it after each case so order doesn't matter.
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    test("renders a muted interrupted marker when the flag is set", async () => {
        setTheme(LIGHT);
        const setup = await renderAssistant({ interrupted: true });
        try {
            // The header (with the marker) paints synchronously; the async markdown body is irrelevant here.
            await setup.renderOnce();
            const fg = spanFg(setup, "interrupted");
            expect(fg).toBeDefined();
            expect(fg && parseColor(themes[LIGHT].colors.fgMuted).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("renders no interrupted marker when the flag is unset", async () => {
        setTheme(LIGHT);
        const setup = await renderAssistant({ interrupted: false });
        try {
            await setup.renderOnce();
            expect(setup.captureCharFrame()).not.toContain("interrupted");
        } finally {
            setup.renderer.destroy();
        }
    });
});

// What the turn cost sits on the same header line as its elapsed time. The fixture's cache and
// reasoning counts are the point of every case here: they are breakdowns OF the two headline counts,
// so any surface that added them in would report an inflated figure — 22.2k in / 4.0k out instead of
// 12.4k in / 3.1k out.
const REPORTED: TurnUsage = { inputTokens: 12_400, outputTokens: 3100, cacheReadInputTokens: 9800, cacheCreationInputTokens: 1200, reasoningTokens: 900 };

describe("MessageBlock turn-usage figures", () => {
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    test("a reported rollup renders two figures on the meta line, next to the duration", async () => {
        setTheme(LIGHT);
        const setup = await renderAssistant({ durationMs: 2400, turnUsage: REPORTED });
        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("2.4s");
            expect(frame).toContain("12.4k in");
            expect(frame).toContain("3.1k out");
            // Frames carry no color, so the figures' legibility is asserted on the resolved span: the
            // meta line is muted, and an unresolved foreground would paint white — invisible on this
            // pure-#ffffff light theme.
            const fg = spanFg(setup, "12.4k in");
            expect(fg && parseColor(themes[LIGHT].colors.fgMuted).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("an absent rollup leaves the line unchanged — the duration alone, no zero and no placeholder", async () => {
        setTheme(LIGHT);
        const setup = await renderAssistant({ durationMs: 2400 });
        try {
            await setup.renderOnce();
            // Scoped to the header ROW rather than the whole frame: the body prose below it is free to
            // contain the word "in", and a whole-frame negative would be asserting against the fixture.
            const header = setup
                .captureCharFrame()
                .split("\n")
                .find((line) => line.includes("Inflexa"));
            expect(header).toBeDefined();
            expect(header).toContain("2.4s");
            expect(header).not.toContain(" in");
            expect(header).not.toContain(" out");
            expect(header).not.toContain("0k");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("the cache and reasoning counts are folded into neither figure", () => {
        // Asserted on the formatter rather than the frame: "these two numbers are the reported ones"
        // is a claim about arithmetic, and a frame containing two numbers cannot pin WHICH numbers.
        // Summing the input side would give 23.4k, the output side 4.0k.
        expect(formatTurnUsage(REPORTED)).toBe(`12.4k in ${GLYPHS.middot} 3.1k out`);
    });

    test("a quantity the provider never reported contributes no figure at all", () => {
        expect(formatTurnUsage({ inputTokens: 900 })).toBe("900 in");
        expect(formatTurnUsage({ outputTokens: 1500 })).toBe("1.5k out");
        // Neither headline count reported: nothing to render, so the caller appends no separator either.
        expect(formatTurnUsage({ cacheReadInputTokens: 400 })).toBe("");
    });
});
