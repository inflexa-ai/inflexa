import { afterEach, describe, expect, test } from "bun:test";
import { testRender, useTerminalDimensions } from "@opentui/solid";
import { parseColor, type RGBA } from "@opentui/core";

import { renderFrame } from "../../test_support/tui.ts";
import { DEFAULT_THEME_ID, size, themes } from "../../lib/design_system.ts";
import { setTheme } from "../theme.ts";
import { StatusBar } from "./status_bar.tsx";

// The working-directory path is a wide-terminal-only affordance. StatusBar is dumb — it renders
// whatever path string it is handed — so the width decision lives in the app. These cases pin both:
// the dumb render (path shown iff supplied) and the app-side gate mirrored here over the real terminal
// dimensions, straddling `size.breakpointWide` (120). Booting the whole chat App would drag in a
// runtime, DB, and providers for what is a one-line composition, so the gate is reproduced directly.
function gatedStatusBar(path: string) {
    return () => {
        const dims = useTerminalDimensions();
        return <StatusBar title="inflexa" path={dims().width >= size.breakpointWide ? path : undefined} hints={["ctrl+k"]} />;
    };
}

describe("StatusBar working-directory path", () => {
    test("renders the path segment when one is supplied", async () => {
        const frame = await renderFrame(() => <StatusBar title="inflexa" path="~/work/proj" hints={["ctrl+k"]} />, { width: 130, height: 3 });
        expect(frame).toContain("~/work/proj");
    });

    test("omits the path segment when none is supplied", async () => {
        const frame = await renderFrame(() => <StatusBar title="inflexa" hints={["ctrl+k"]} />, { width: 130, height: 3 });
        expect(frame).not.toContain("~/work/proj");
    });

    test("the app gate shows the path only at/above the breakpoint", async () => {
        const wide = await renderFrame(gatedStatusBar("~/work/proj"), { width: 121, height: 3 });
        expect(wide).toContain("~/work/proj");

        const narrow = await renderFrame(gatedStatusBar("~/work/proj"), { width: 119, height: 3 });
        expect(narrow).not.toContain("~/work/proj");
    });
});

// The interrupt hint carries its OWN color so the armed ("again to interrupt") state accents while the
// resting hint stays muted. A character frame cannot see a color, so these assert on the span's resolved
// fg via captureSpans (the same mechanism as theme_contrast.render.test.tsx) on github-light, whose bg is
// pure #ffffff — the sharpest case for an accidentally-white span.
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

describe("StatusBar interrupt hint", () => {
    // The active theme is a module singleton; reset it after each case so order doesn't matter.
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    test("the resting hint renders muted", async () => {
        setTheme(LIGHT);
        // A distinctive label so the span search never collides with the muted right-hints span beside it.
        const setup = await testRender(() => <StatusBar title="inflexa" hints={["ctrl+k"]} interruptHint={{ label: "RESTINGHINT", armed: false }} />, {
            width: 130,
            height: 3,
        });
        try {
            await setup.renderOnce();
            const fg = spanFg(setup, "RESTINGHINT");
            expect(fg).toBeDefined();
            expect(fg && parseColor(themes[LIGHT].colors.fgMuted).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("the armed hint renders in the accent color", async () => {
        setTheme(LIGHT);
        const setup = await testRender(() => <StatusBar title="inflexa" hints={["ctrl+k"]} interruptHint={{ label: "ARMEDHINT", armed: true }} />, {
            width: 130,
            height: 3,
        });
        try {
            await setup.renderOnce();
            const fg = spanFg(setup, "ARMEDHINT");
            expect(fg).toBeDefined();
            expect(fg && parseColor(themes[LIGHT].colors.accent).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("no interrupt hint renders when the prop is absent", async () => {
        const frame = await renderFrame(() => <StatusBar title="inflexa" hints={["ctrl+k"]} />, { width: 130, height: 3 });
        expect(frame).not.toContain("interrupt");
    });
});
