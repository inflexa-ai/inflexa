import { afterEach, describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";
import { testRender } from "@opentui/solid";
import { parseColor, rgbToHex, type RGBA } from "@opentui/core";
import type { JSX } from "solid-js";

import { DEFAULT_THEME_ID, themes } from "../../../lib/design_system.ts";
import { contrast } from "../../../test_support/contrast.ts";
import { setTheme } from "../../theme.ts";
import { useKeymapRoot } from "../../keymap.ts";
import { DialogOverlay, dialogClear, dialogClose, dialogPush } from "./dialog_host.tsx";
import { ResultsDialog } from "./results_dialog.tsx";
import { UsageDialog, usageStepLines, type UsageSnapshot } from "./usage_dialog.tsx";
import type { LlmUsageByStep } from "../../../db/primary_query.ts";
import type { DbError } from "../../../db/errors.ts";

// The dialog's PAINTED ladder: the headline, every grain section, the drill into a run's steps and
// back, and the two states that must never stop it opening (a failed read, an analysis with no
// calls). The composition arithmetic is pinned as pure functions in `usage_dialog.test.ts` — a char
// frame proves a figure painted, never which figure it is.
//
// The last case measures COLOR, because a frame carries none: opentui defaults an uncolored <text> to
// opaque white, which on `github-light` (bg #ffffff) is a 1.00:1 invisible row that every character
// assertion above would still pass.

const LIGHT = "github-light";
const WHITE = "#ffffff";

/** A run whose id tail is `eeddcc` and, in the drill test, whose steps the stacked view reports. */
const RUN_ID = "99999999-8888-7777-6666-5555ffeeddcc";
const THREAD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeee11112222";

const STEPS: LlmUsageByStep[] = [
    { stepId: "s1_load", totals: { calls: 3, inputTokens: 24_000, outputTokens: 1_500 } },
    { stepId: "s2_align", totals: { calls: 1, inputTokens: 6_200, outputTokens: 400 } },
];

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
    return {
        totals: {
            calls: 9,
            inputTokens: 42_600,
            outputTokens: 3_140,
            cacheCreationInputTokens: 1_000,
            cacheReadInputTokens: 38_000,
            reasoningTokens: 900,
        },
        sessions: [{ threadId: THREAD_ID, totals: { calls: 4, inputTokens: 12_000, outputTokens: 1_200 } }],
        runs: [{ runId: RUN_ID, totals: { calls: 4, inputTokens: 30_200, outputTokens: 1_900 } }],
        unattributed: { calls: 1, inputTokens: 400, outputTokens: 40 },
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

// A real-clock settle: the dialog host applies focus on a microtask and the list's scroll retries on a
// macrotask, so a bare render pair is too early for both.
async function settle(setup: Setup): Promise<string> {
    await new Promise((r) => setTimeout(r, 20));
    await setup.renderOnce();
    await setup.renderOnce();
    return setup.captureCharFrame();
}

/**
 * Push the usage dialog with the production wiring for its drill: selecting a run STACKS the step view
 * over it, exactly as the app composes the two, so dismissing the step view lands back on the still
 * mounted breakdown.
 */
function pushUsage(load: () => Result<UsageSnapshot, DbError>, names?: ReadonlyMap<string, string>): void {
    dialogPush(() => (
        <UsageDialog
            analysisName="rna-seq-2026"
            loadUsage={load}
            names={names}
            onOpenRun={() =>
                dialogPush(() => <ResultsDialog title="Steps" lines={usageStepLines(STEPS)} emptyText="no steps recorded" onClose={() => dialogClose()} />)
            }
            onClose={() => dialogClose("cancel")}
        />
    ));
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

    test("paints the headline and every grain, and never a summed figure", async () => {
        const setup = await testRender(() => <Harness />, { width: 100, height: 34 });
        try {
            await settle(setup);
            pushUsage(() => ok(snapshot()), new Map([[RUN_ID, "Differential expression"]]));
            const frame = await settle(setup);

            expect(frame).toContain("9 calls");
            expect(frame).toContain("42.6k");
            expect(frame).toContain("3.1k");
            // The breakdowns are nested under the figure each one details, never beside them as peers.
            expect(frame).toContain("cache write");
            expect(frame).toContain("cache read");
            expect(frame).toContain("reasoning");

            expect(frame).toContain("By session");
            expect(frame).toContain("By run");
            expect(frame).toContain("Unattributed");
            expect(frame).toContain("(no session or run)");

            // The id leads the run row and the known name rides beside it.
            expect(frame).toContain("eeddcc");
            expect(frame).toContain("Differential expression");

            // 45.7k (input+output), 80.6k (input+cacheRead) and 4.0k (output+reasoning) are each a
            // number this dialog must never invent — the cache and reasoning counts are already inside
            // the two figures shown.
            for (const summed of ["45.7k", "80.6k", "4.0k"]) expect(frame).not.toContain(summed);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a run row drills into that run's steps, and dismissing lands back on the breakdown", async () => {
        const setup = await testRender(() => <Harness />, { width: 100, height: 34 });
        try {
            await settle(setup);
            pushUsage(() => ok(snapshot()));
            await settle(setup);

            // Row 0 is the session; the run is next. Enter on a session row does nothing — only a run
            // is drillable — so the arrow is what makes this test about the run.
            setup.mockInput.pressArrow("down");
            let frame = await settle(setup);
            expect(frame).toContain(`› eeddcc`);

            setup.mockInput.pressEnter();
            frame = await settle(setup);
            expect(frame).toContain("s1_load");
            expect(frame).toContain("s2_align");
            expect(frame).toContain("24.0k");
            // The steps view replaced nothing: the breakdown below it is still mounted, just covered.
            expect(frame).not.toContain("By session");

            setup.mockInput.pressEscape();
            frame = await settle(setup);
            expect(frame).toContain("By session");
            expect(frame).toContain("By run");
            expect(frame).not.toContain("s1_load");
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
                    loadUsage={() => err<UsageSnapshot, DbError>({ type: "query_failed", op: "test", cause: new Error("boom") })}
                    onOpenRun={() => {}}
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

    test("an analysis with no recorded calls says so, with no zeroed figures and no table", async () => {
        const setup = await testRender(() => <Harness />, { width: 100, height: 34 });
        try {
            await settle(setup);
            pushUsage(() => ok(snapshot({ totals: { calls: 0 }, sessions: [], runs: [], byModel: [], byAgent: [], unattributed: { calls: 0 } })));
            const frame = await settle(setup);

            expect(frame).toContain("no usage recorded");
            expect(frame).not.toContain("By session");
            expect(frame).not.toContain("input");
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
            pushUsage(() => ok(snapshot()), new Map([[RUN_ID, "Differential expression"]]));
            await settle(setup);

            // The headline label, its figure, and a grain row are the three span shapes this dialog
            // paints; a bare literal in an fg-less <text> would render each of them at #ffffff.
            for (const needle of ["9 calls", "cache write", "42.6k", "eeddcc"]) {
                const fg = spanFg(setup, needle);
                expect({ needle, defined: fg !== undefined }).toEqual({ needle, defined: true });
                expect({ needle, hex: fg && rgbToHex(fg) }).not.toEqual({ needle, hex: WHITE });
                // Information-bearing text holds the 4.5:1 floor against the panel it sits on.
                expect({ needle, ok: contrast(rgbToHex(fg!), colors.bgRaised) >= 4.5 }).toEqual({ needle, ok: true });
            }

            // The muted headline labels are a tier of their own, and they must still be the theme's
            // muted role rather than an accident of the white default.
            expect(rgbToHex(spanFg(setup, "cache write")!)).toBe(rgbToHex(parseColor(colors.fgMuted)));
        } finally {
            setup.renderer.destroy();
        }
    });
});
