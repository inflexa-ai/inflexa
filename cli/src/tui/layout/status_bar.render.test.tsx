import { afterEach, describe, expect, test } from "bun:test";
import { testRender, useTerminalDimensions } from "@opentui/solid";
import { parseColor } from "@opentui/core";

import { renderFrame } from "../../test_support/tui.ts";
import { DEFAULT_THEME_ID, GLYPHS, size, themes } from "../../lib/design_system.ts";
import { setTheme } from "../theme.ts";
import { sessionScopeOf } from "../app.tsx";
import type { ThreadSnapshot } from "../hooks/thread.ts";
import { conversationThread, reportThread } from "../../test_support/threads.ts";
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

// The scope segment marks a header whose subtitle names the ANALYSIS while the open session is a
// report of it. StatusBar is dumb here too, so these pin both halves: the dumb render (segment shown
// iff supplied) and the app-side gate, reproduced over the REAL derivation `App` passes it through —
// mounting the whole chat App for a one-line composition would drag in a runtime, DB and providers.
describe("StatusBar report scope segment", () => {
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    /** The prop exactly as `App` derives it: the segment rides a report row and nothing else. */
    function scopeFor(snapshot: ThreadSnapshot): string | undefined {
        return sessionScopeOf(snapshot) === "report" ? "report" : undefined;
    }

    test("a report thread shows the segment after the analysis name", async () => {
        const frame = await renderFrame(
            () => <StatusBar title="inflexa" subtitle="rna-seq-2026" scope={scopeFor({ kind: "loaded", thread: reportThread() })} hints={["ctrl+k"]} />,
            { width: 130, height: 3 },
        );
        const header = frame.split("\n")[0] ?? "";
        expect(header).toContain("report");
        // After the identity pair it qualifies, never before it.
        expect(header.indexOf("report")).toBeGreaterThan(header.indexOf("rna-seq-2026"));
    });

    test("a conversation shows no scope segment", async () => {
        const frame = await renderFrame(
            () => <StatusBar title="inflexa" subtitle="rna-seq-2026" scope={scopeFor({ kind: "loaded", thread: conversationThread() })} hints={["ctrl+k"]} />,
            { width: 130, height: 3 },
        );
        expect(frame).not.toContain("report");
    });

    test("a snapshot that knows no kind shows no segment either", async () => {
        for (const snapshot of [{ kind: "unresolved" } as const, { kind: "unavailable" } as const, { kind: "absent" } as const]) {
            const frame = await renderFrame(() => <StatusBar title="inflexa" subtitle="rna-seq-2026" scope={scopeFor(snapshot)} hints={["ctrl+k"]} />, {
                width: 130,
                height: 3,
            });
            expect(frame).not.toContain("report");
        }
    });

    // A character frame carries no colour, so it cannot tell an accent segment from one that fell
    // through to opentui's opaque white — which on `github-light`'s pure-white bg is invisible.
    test("the segment paints the accent role, not the white default", async () => {
        setTheme("github-light");
        const setup = await testRender(() => <StatusBar title="inflexa" subtitle="rna-seq-2026" scope="report" hints={["ctrl+k"]} />, {
            width: 130,
            height: 3,
        });
        try {
            await setup.renderOnce();
            let fg: ReturnType<typeof parseColor> | undefined;
            for (const line of setup.captureSpans().lines) {
                for (const span of line.spans) {
                    if (span.text.includes("report")) fg = span.fg;
                }
            }
            expect(fg).toBeDefined();
            expect(fg && parseColor(themes["github-light"].colors.accent).equals(fg)).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});

// The interrupt hint now lives in the ChatBar footer beside the mode word it depends on (its span-color
// coverage is chat_bar.render.test.tsx). The status bar can no longer even receive it — the prop is gone —
// so this pins the observable contract: a status bar rendered exactly as the chat renders it during a busy
// turn carries no interrupt affordance in its right-hints region.
describe("StatusBar carries no interrupt hint", () => {
    test("renders no interrupt hint while a turn is busy", async () => {
        const frame = await renderFrame(
            () => (
                <StatusBar
                    title="inflexa"
                    subtitle="rna-seq-2026"
                    state={{ text: `${GLYPHS.circleHalf} thinking${GLYPHS.ellipsis}`, tone: "warn" }}
                    hints={["ctrl+k", "ctrl+b", "ctrl+c"]}
                />
            ),
            { width: 130, height: 3 },
        );
        expect(frame).not.toContain("interrupt");
    });
});
