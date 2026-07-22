import { describe, expect, test } from "bun:test";
import { useTerminalDimensions } from "@opentui/solid";

import { renderFrame } from "../../test_support/tui.ts";
import { GLYPHS, size } from "../../lib/design_system.ts";
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
