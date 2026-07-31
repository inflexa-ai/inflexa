import { afterEach, describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";
import { testRender } from "@opentui/solid";
import { parseColor, rgbToHex, type RGBA } from "@opentui/core";
import type { JSX } from "solid-js";

import { DEFAULT_THEME_ID, GLYPHS, themes } from "../../../lib/design_system.ts";
import { contrast } from "../../../test_support/contrast.ts";
import { setTheme } from "../../theme.ts";
import { useKeymapRoot } from "../../keymap.ts";
import { DialogOverlay, dialogClear, dialogClose, dialogPush } from "./dialog_host.tsx";
import { UsageDialog, type SessionUsageSnapshot } from "./usage_dialog.tsx";
import type { DbError } from "../../../db/errors.ts";

// The dialog's PAINTED ladder: the two-armed headline in the LABELLED form, its arms pinned to the
// panel's opposite EDGES with each breakdown nested under the arm it details, the compact-form
// groupings beneath it, and the two states that must never stop it opening (a failed read, a
// conversation with no calls). The composition arithmetic is pinned as pure functions in
// `usage_dialog.test.ts` — a char frame proves a figure painted, never which figure it is.
//
// The edge claims sweep panel widths on purpose: the layout they replaced put each arm at the head of
// its own half-panel, which reads as "left and right" at exactly one width and drifts at every other.
//
// The last case measures COLOR, because a frame carries none: opentui defaults an uncolored <text> to
// opaque white, which on `github-light` (bg #ffffff) is a 1.00:1 invisible row that every character
// assertion above would still pass.

const LIGHT = "github-light";
const WHITE = "#ffffff";

function snapshot(over: Partial<SessionUsageSnapshot> = {}): SessionUsageSnapshot {
    return {
        totals: {
            calls: 9,
            inputTokens: 42_600,
            outputTokens: 3_140,
            cacheCreationInputTokens: 1_000,
            cacheReadInputTokens: 38_000,
            reasoningTokens: 900,
        },
        byModel: [{ servedModelId: "claude-opus-4", totals: { calls: 9, inputTokens: 42_600, outputTokens: 3_140 } }],
        byAgent: [{ agentId: "conversation", totals: { calls: 9, inputTokens: 42_600, outputTokens: 3_140 } }],
        ...over,
    };
}

function Harness(): JSX.Element {
    useKeymapRoot();
    return (
        <box width="100%" height="100%">
            <DialogOverlay />
        </box>
    );
}

type Setup = Awaited<ReturnType<typeof testRender>>;

// A real-clock settle: the dialog host applies focus on a microtask and the scroll pane retries on a
// macrotask, so a bare render pair is too early for both.
async function settle(setup: Setup): Promise<string> {
    await new Promise((r) => setTimeout(r, 20));
    await setup.renderOnce();
    await setup.renderOnce();
    return setup.captureCharFrame();
}

function pushUsage(load: () => Result<SessionUsageSnapshot, DbError>): void {
    dialogPush(() => <UsageDialog analysisName="rna-seq-2026" loadUsage={load} onClose={() => dialogClose("cancel")} />);
}

/** The frame's first line containing `needle`, or undefined. */
function lineWith(frame: string, needle: string): string | undefined {
    return frame.split("\n").find((l) => l.includes(needle));
}

/**
 * Where `needle` sits on its line RELATIVE TO THE PANEL's two borders: how far its first character is
 * past the left border, and how far its last character is short of the right one.
 *
 * Measured against the borders rather than against the terminal because the panel is centred and
 * clamped, so a raw column index moves with the terminal width for reasons that have nothing to do
 * with the layout under test. The two insets are what separate "anchored to an edge" from "floating":
 * an edge-anchored figure holds ITS inset constant as the panel widens, while the half-panel layout
 * this replaces grew the output figure's right inset with every extra column.
 */
function insets(frame: string, needle: string): { left: number; right: number } {
    const line = lineWith(frame, needle);
    if (line === undefined) throw new Error(`no line carries ${needle}`);
    const start = line.indexOf(needle);
    return { left: start - line.indexOf(GLYPHS.lineVertical), right: line.lastIndexOf(GLYPHS.lineVertical) - (start + needle.length - 1) };
}

/** The fg of the FIRST captured span whose text contains `needle`, or undefined if none rendered. */
function spanFg(setup: Setup, needle: string): RGBA | undefined {
    for (const line of setup.captureSpans().lines) {
        for (const span of line.spans) {
            if (span.text.includes(needle)) return span.fg;
        }
    }
    return undefined;
}

describe("UsageDialog", () => {
    afterEach(() => {
        dialogClear();
        setTheme(DEFAULT_THEME_ID);
    });

    test("writes the headline LABELLED and the grouping rows COMPACT, and never paints a summed figure", async () => {
        const setup = await testRender(() => <Harness />, { width: 100, height: 34 });
        try {
            await settle(setup);
            pushUsage(() => ok(snapshot()));
            const frame = await settle(setup);

            expect(frame).toContain("9 calls");
            // The dialog says WHICH session reading it shows — the rail's figure and
            // `inflexa usage sessions` differ by the whole of every run this conversation launched.
            expect(frame).toContain("runs included");

            // One line carries both arms, input first, in the LABELLED form: the headline is this
            // dialog's subject and owns a full panel width, so it can afford the words.
            const arms = lineWith(frame, "42.6k in");
            expect(arms).toBeDefined();
            expect(arms).toContain("3.1k out");
            expect(arms!.indexOf("42.6k in")).toBeLessThan(arms!.indexOf("3.1k out"));

            // ...while a GROUPING row keeps the compact arrows: it is one of many being compared down a
            // column, where words would push the figures apart and make the comparison harder. Same
            // quantities, one arm apiece — two writings of one figure, never two figures.
            const group = lineWith(frame, "claude-opus-4");
            expect(group).toContain("↑42.6k ↓3.1k");
            expect(arms).not.toContain(GLYPHS.arrowUp);

            // The breakdowns are nested UNDER the arm each details, never beside them as peers.
            const cacheWrite = lineWith(frame, "cache write");
            expect(cacheWrite).toBeDefined();
            expect(cacheWrite).toContain("reasoning");
            expect(cacheWrite!.indexOf("cache write")).toBeGreaterThan(arms!.indexOf("42.6k in"));
            expect(cacheWrite!.indexOf("reasoning")).toBeGreaterThan(arms!.indexOf("42.6k in"));
            expect(frame).toContain("cache read");

            expect(frame).toContain("By served model");
            expect(frame).toContain("By agent");
            expect(frame).toContain("claude-opus-4");
            expect(frame).toContain("conversation");

            // 45.7k (input+output), 80.6k (input+cacheRead) and 4.0k (output+reasoning) are each a
            // number this dialog must never invent — the cache and reasoning counts are already inside
            // the two figures shown.
            for (const summed of ["45.7k", "80.6k", "4.0k"]) expect(frame).not.toContain(summed);
        } finally {
            setup.renderer.destroy();
        }
    });

    // The defect this replaces: both arms were `flexGrow={1}`, so each owned half the panel and
    // left-aligned inside it — leaving the output figure floating mid-panel adjacent to nothing, and
    // drifting further from the edge with every column the terminal gained. A single-width assertion
    // cannot tell an edge-anchored figure from a half-anchored one, which is why this sweeps.
    for (const width of [70, 84, 100, 120]) {
        test(`at ${width} columns the headline's two figures sit at opposite panel edges`, async () => {
            const setup = await testRender(() => <Harness />, { width, height: 34 });
            try {
                await settle(setup);
                // No reasoning count: with nothing nested under it the output arm IS its figure, so the
                // figure itself lands on the panel's trailing edge. (The nested case below is what
                // pins the arm's behaviour when its widest line is a breakdown instead.)
                pushUsage(() => ok(snapshot({ totals: { calls: 9, inputTokens: 42_600, outputTokens: 3_140 } })));
                const frame = await settle(setup);

                const input = insets(frame, "42.6k in");
                const output = insets(frame, "3.1k out");
                // Each figure sits exactly its own panel padding from the edge it belongs to, and the
                // two insets match — the reader compares two peers, each findable without scanning.
                expect({ width, trailing: output.right }).toEqual({ width, trailing: input.left });
                // ...and the output really is at the FAR edge, not merely somewhere right of centre: the
                // gap it leaves behind it grows with the panel, which the half-panel layout never did.
                expect(output.left).toBeGreaterThan(input.left + "42.6k in".length);
            } finally {
                setup.renderer.destroy();
            }
        });
    }

    test("a quantity nested under the trailing arm is indented under that arm, not pushed to the panel edge", async () => {
        const setup = await testRender(() => <Harness />, { width: 100, height: 34 });
        try {
            await settle(setup);
            pushUsage(() => ok(snapshot()));
            const frame = await settle(setup);

            // The trailing arm is sized to its widest LINE and pinned to the panel's trailing edge, so
            // when a nested quantity is longer than the figure above it (`reasoning 900` against
            // `3.1k out`) the arm still ends at the edge and the figure aligns to the arm's own leading
            // edge. That inset is the accepted cost of keeping the indent readable: right-aligning the
            // arm's contents would flush the nested quantity against the panel edge too, and the
            // nesting is the only thing saying it is a PART of the figure above rather than a peer.
            const arm = insets(frame, "3.1k out");
            const nested = insets(frame, "reasoning 900");
            expect(nested.right).toBe(arm.right - ("  reasoning 900".length - "3.1k out".length));
            expect(nested.left - arm.left).toBe(2);
            // ...and the nested line is the one at the edge, at the same inset the LEADING arm keeps
            // from its own edge — the arm as a block is flush, never floating mid-panel.
            expect(nested.right).toBe(insets(frame, "42.6k in").left);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("carries none of the grains their own entities now report, and nothing drills", async () => {
        const setup = await testRender(() => <Harness />, { width: 100, height: 34 });
        try {
            await settle(setup);
            pushUsage(() => ok(snapshot()));
            let frame = await settle(setup);

            for (const gone of ["By session", "By run", "(no session or run)"]) expect(frame).not.toContain(gone);

            // Enter is a close now, not a drill: nothing stacks over the panel, it dismisses.
            setup.mockInput.pressEnter();
            frame = await settle(setup);
            expect(frame).not.toContain("By served model");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("an arm the provider never reported renders the absent word, never a zero", async () => {
        const setup = await testRender(() => <Harness />, { width: 100, height: 34 });
        try {
            await settle(setup);
            pushUsage(() =>
                ok(
                    snapshot({
                        totals: { calls: 2, inputTokens: 900 },
                        byModel: [{ servedModelId: "claude-opus-4", totals: { calls: 2, inputTokens: 900 } }],
                        byAgent: [{ agentId: "conversation", totals: { calls: 2, inputTokens: 900 } }],
                    }),
                ),
            );
            const frame = await settle(setup);

            // The headline's surviving arm in the labelled form, and the grouping row's in the compact
            // one — both omit the arm nobody reported, which is the rule that has to hold identically
            // across the two forms or they would disagree about what was measured.
            expect(frame).toContain("900 in");
            expect(frame).toContain("↑900");
            expect(frame).toContain("not reported");
            expect(frame).not.toContain("↓0");
            expect(frame).not.toContain("0 out");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a failed ledger read renders an unavailable state inside the dialog, which still opens and closes", async () => {
        let closed = false;
        const setup = await testRender(() => <Harness />, { width: 100, height: 34 });
        try {
            await settle(setup);
            dialogPush(() => (
                <UsageDialog
                    analysisName="rna-seq-2026"
                    loadUsage={() => err<SessionUsageSnapshot, DbError>({ type: "query_failed", op: "test", cause: new Error("boom") })}
                    onClose={() => {
                        closed = true;
                        dialogClose("cancel");
                    }}
                />
            ));
            let frame = await settle(setup);

            // Opened, titled, and honest about what it cannot show — not a refusal to open.
            expect(frame).toContain("Usage");
            expect(frame).toContain("usage unavailable");

            setup.mockInput.pressEscape();
            frame = await settle(setup);
            expect(closed).toBe(true);
            expect(frame).not.toContain("usage unavailable");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a conversation with no recorded calls says so, with no zeroed figures and no table", async () => {
        const setup = await testRender(() => <Harness />, { width: 100, height: 34 });
        try {
            await settle(setup);
            pushUsage(() => ok(snapshot({ totals: { calls: 0 }, byModel: [], byAgent: [] })));
            const frame = await settle(setup);

            expect(frame).toContain("no usage recorded");
            expect(frame).not.toContain("By served model");
            expect(frame).not.toContain("↑");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("on a light theme every information-bearing span resolves a foreground, never the white default", async () => {
        setTheme(LIGHT);
        const colors = themes[LIGHT].colors;
        const setup = await testRender(() => <Harness />, { width: 100, height: 34 });
        try {
            await settle(setup);
            pushUsage(() => ok(snapshot()));
            await settle(setup);

            // The call count, an arm, a nested breakdown value, a section heading and a group row are
            // the five span shapes this dialog paints; a bare literal in an fg-less <text> would render
            // each of them at #ffffff.
            for (const needle of ["9 calls", "42.6k in", "↑42.6k", "cache write", "By served model", "claude-opus-4"]) {
                const fg = spanFg(setup, needle);
                expect({ needle, defined: fg !== undefined }).toEqual({ needle, defined: true });
                expect({ needle, hex: fg && rgbToHex(fg) }).not.toEqual({ needle, hex: WHITE });
                // Information-bearing text holds the 4.5:1 floor against the panel it sits on.
                expect({ needle, ok: contrast(rgbToHex(fg!), colors.bgRaised) >= 4.5 }).toEqual({ needle, ok: true });
            }

            // The muted breakdown labels are a tier of their own, and they must still be the theme's
            // muted role rather than an accident of the white default.
            expect(rgbToHex(spanFg(setup, "cache write")!)).toBe(rgbToHex(parseColor(colors.fgMuted)));
        } finally {
            setup.renderer.destroy();
        }
    });
});
