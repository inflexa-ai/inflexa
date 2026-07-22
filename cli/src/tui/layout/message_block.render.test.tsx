import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, type RGBA } from "@opentui/core";

import { DEFAULT_THEME_ID, themes } from "../../lib/design_system.ts";
import { setTheme } from "../theme.ts";
import { MessageBlock } from "./message_block.tsx";
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

/** An assistant turn with one body part; `interrupted` toggles the muted header marker. */
function renderAssistant(interrupted: boolean): ReturnType<typeof testRender> {
    const parts: Part[] = [{ id: "p1", sessionId: "s", messageId: "m", type: "text", text: "an answer that began", createdAt: 0 }];
    return testRender(
        () => <MessageBlock index={1} role="assistant" parts={parts} interrupted={interrupted} streamPartId={() => null} streamText={() => ""} />,
        { width: 60, height: 10 },
    );
}

describe("MessageBlock interrupted marker", () => {
    // The active theme is a module singleton; reset it after each case so order doesn't matter.
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    test("renders a muted interrupted marker when the flag is set", async () => {
        setTheme(LIGHT);
        const setup = await renderAssistant(true);
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
        const setup = await renderAssistant(false);
        try {
            await setup.renderOnce();
            expect(setup.captureCharFrame()).not.toContain("interrupted");
        } finally {
            setup.renderer.destroy();
        }
    });
});
