import { describe, expect, test } from "bun:test";
import { For } from "solid-js";
import { testRender } from "@opentui/solid";

import { BootIndicator } from "./boot_indicator.tsx";
import { ScrollPane } from "./scroll_pane.tsx";
import { ChatBar } from "../layout/chat_bar.tsx";
import { theme } from "../theme.ts";

// Headless render coverage for the boot gate's visible surface (the store transitions are unit-tested
// in hooks/boot.test.ts). Three observables: while booting the animation renders, the
// gated input affordance surfaces the closed gate (the render-observable proxy for "submit refused" —
// the host's handleSubmit returns while not ready), and a failed boot shows its actionable message.

const noop = (): void => {};

/** Count non-overlapping occurrences of `needle` in `haystack` (case-sensitive). */
function occurrences(haystack: string, needle: string): number {
    let count = 0;
    let from = 0;
    for (;;) {
        const idx = haystack.indexOf(needle, from);
        if (idx === -1) break;
        count++;
        from = idx + needle.length;
    }
    return count;
}

describe("BootIndicator + gated ChatBar render", () => {
    test("booting shows the spinner label", async () => {
        const setup = await testRender(
            () => (
                <box width="100%" height="100%">
                    <BootIndicator />
                </box>
            ),
            { width: 60, height: 6 },
        );
        try {
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("booting harness runtime");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("the gated ChatBar surfaces the closed gate in its placeholder", async () => {
        const setup = await testRender(
            () => (
                <box width="100%" height="100%">
                    <ChatBar gated onTextareaRef={noop} onSubmit={noop} />
                </box>
            ),
            { width: 60, height: 8 },
        );
        try {
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("Booting harness runtime");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a failed boot shows the actionable message", async () => {
        const setup = await testRender(
            () => (
                <box width="100%" height="100%">
                    <BootIndicator message={"boot failed detail\ntry the fix here"} />
                </box>
            ),
            { width: 60, height: 6 },
        );
        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("boot failed detail");
            expect(frame).toContain("try the fix here"); // the second (remedy) line renders too
        } finally {
            setup.renderer.destroy();
        }
    });
});

// The component alone at one fixed size cannot catch the two failure modes its ACTUAL mount site risks
// (see app.tsx + cli/CLAUDE.md "Layout"): the flexGrow-scrollbox 1-cell bleed painting scroll content
// onto the row below, and the short-terminal squeeze pushing chrome off-screen. So mirror the real
// composition — a flexGrow ScrollPane (with overflowing content above), the painted full-width
// flexShrink={0} wrapper holding BootIndicator, and the flexShrink={0} ChatBar chrome below — and sweep
// heights. At every height the indicator must render exactly once (not doubled/corrupted by bleed, not
// squeezed out) and the input chrome directly below it must keep its own rows.
describe("BootIndicator at its real mount shape survives bleed + short-terminal squeeze", () => {
    const HEIGHTS = [8, 12, 20, 40];

    for (const height of HEIGHTS) {
        test(`height ${height}: indicator renders once and the input chrome below stays intact`, async () => {
            const setup = await testRender(
                () => (
                    <box flexDirection="column" width="100%" height="100%">
                        {/* The chat column: a flexGrow scroll surface, then the two flexShrink={0} chrome
                        rows. Content overflows the pane so the documented 1-cell bleed is in play. */}
                        <box flexDirection="column" flexGrow={1} minHeight={0}>
                            <ScrollPane focusOnMount={false} flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1}>
                                <For each={Array.from({ length: 40 }, (_unused, i) => i)}>{(i) => <text>scroll-line-{i}</text>}</For>
                            </ScrollPane>
                            {/* Mirror app.tsx: the painted full-width flexShrink={0} wrapper that reclaims
                            the bleed and keeps its row under the squeeze. */}
                            <box width="100%" flexShrink={0} backgroundColor={theme().bg} paddingLeft={1} paddingRight={1}>
                                <BootIndicator />
                            </box>
                            <ChatBar gated onTextareaRef={noop} onSubmit={noop} />
                        </box>
                    </box>
                ),
                { width: 50, height },
            );
            try {
                await setup.renderOnce();
                const frame = setup.captureCharFrame();
                // Exactly once: never zero (squeezed out by the flexShrink={0} wrapper failing to hold
                // its row) and never doubled/overwritten by the scrollbox bleed (the painted wrapper
                // opaquely reclaims its row). BootIndicator's label is lowercase; the gated ChatBar
                // placeholder is capital-B "Booting …", so the two never alias in this count.
                expect(occurrences(frame, "booting harness runtime")).toBe(1);
                // The input chrome directly below the indicator kept its rows too — its gated placeholder
                // proves the ChatBar was not squeezed off-screen at this height.
                expect(frame).toContain("Booting harness runtime");
            } finally {
                setup.renderer.destroy();
            }
        });
    }
});
