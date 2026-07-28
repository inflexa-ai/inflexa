import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, type RGBA } from "@opentui/core";

import { DEFAULT_THEME_ID, themes } from "../../lib/design_system.ts";
import { setTheme } from "../theme.ts";
import { renderFrame } from "../../test_support/tui.ts";
import { RunActivityPanel } from "./run_activity_panel.tsx";
import type { ActiveRunProgress } from "../hooks/sidebar_live.ts";
import type { RunStepView } from "../components/run_block.tsx";

// The panel is the chat column's live frontier readout. Its contract has three legs, and only the
// first is a character-frame question:
//   - CONTENT: the frontier (running steps only), never the full step list.
//   - PRESENCE: zero rows when there is no run — an idle chat must compose exactly as before.
//   - CHROME: a full-width painted box that neither bleeds nor collapses, verified over a HEIGHT
//     SWEEP because that class of defect is size-dependent and a single height hides it.

const WIDE = { width: 80, height: 12 };

function step(over: Partial<RunStepView> = {}): RunStepView {
    return { label: "step", state: "running", startedAt: null, ...over };
}

function progress(over: Partial<ActiveRunProgress> = {}): ActiveRunProgress {
    return {
        runId: "11111111-2222-3333-4444-555555555555",
        name: "Differential expression",
        tag: "555555",
        startedAt: new Date().toISOString(),
        done: 1,
        total: 3,
        steps: [
            step({ label: "quality control", state: "done" }),
            step({ label: "align reads", state: "running", agent: "bioinformatician" }),
            step({ label: "summarize", state: "queued" }),
        ],
        stale: false,
        ...over,
    };
}

/** Render the panel with sensible defaults; `over` replaces any prop. */
function panel(over: Partial<Parameters<typeof RunActivityPanel>[0]> = {}) {
    return () => (
        <RunActivityPanel
            progress={progress()}
            activity="tool bash"
            activeCount={1}
            position={1}
            nextKeyLabel="ctrl+n"
            dismissKeyLabel="ctrl+r"
            onNext={() => {}}
            {...over}
        />
    );
}

describe("RunActivityPanel content", () => {
    test("a running step is named, attributed, and described", async () => {
        const frame = await renderFrame(panel(), WIDE);
        expect(frame).toContain("Differential expression");
        expect(frame).toContain("1/3");
        expect(frame).toContain("align reads");
        expect(frame).toContain("[bioinformatician]");
        expect(frame).toContain("tool bash");
    });

    test("the frontier only — done and queued steps stay in the rail, not here", async () => {
        const frame = await renderFrame(panel(), WIDE);
        expect(frame).toContain("align reads");
        // The step list belongs to the sidebar. Rendering it here too would put one widget on screen
        // twice, which is the duplication the panel exists to avoid.
        expect(frame).not.toContain("quality control");
        expect(frame).not.toContain("summarize");
    });

    test("every parallel frontier step is shown, not just the first", async () => {
        const frame = await renderFrame(
            panel({
                progress: progress({
                    steps: [step({ label: "align reads" }), step({ label: "call variants" })],
                }),
            }),
            WIDE,
        );
        expect(frame).toContain("align reads");
        expect(frame).toContain("call variants");
    });

    test("an unrecognised step kind passes through verbatim rather than collapsing to a placeholder", async () => {
        // `friendlyStepLabel` returns an unknown DBOS step name unchanged; the panel must not
        // second-guess it, so a newly added step kind surfaces instead of hiding.
        const frame = await renderFrame(panel({ activity: "some-new-step-kind" }), WIDE);
        expect(frame).toContain("some-new-step-kind");
    });

    test("an unresolvable activity label is omitted, and the rest of the frontier still renders", async () => {
        const frame = await renderFrame(panel({ activity: null }), WIDE);
        expect(frame).toContain("align reads");
        expect(frame).toContain("[bioinformatician]");
        expect(frame).not.toContain("tool bash");
    });

    test("no run → zero rows: the panel renders nothing at all", async () => {
        // Rendered directly rather than through `panel()`: Solid's prop merge treats an `undefined`
        // value in a spread as "not provided", so it cannot clear a prop an earlier source set.
        const frame = await renderFrame(
            () => <RunActivityPanel progress={undefined} activeCount={0} position={0} nextKeyLabel="ctrl+n" dismissKeyLabel="ctrl+r" onNext={() => {}} />,
            WIDE,
        );
        expect(frame.trim()).toBe("");
    });
});

describe("RunActivityPanel navigation", () => {
    test("a single active run shows no position indicator and no next-run hint", async () => {
        const frame = await renderFrame(panel({ activeCount: 1, position: 1 }), WIDE);
        expect(frame).not.toContain("run 1/1");
        expect(frame).not.toContain("next run");
        expect(frame).toContain("ctrl+r hide");
    });

    test("several active runs show the position and the derived next-run chord", async () => {
        const frame = await renderFrame(panel({ activeCount: 3, position: 2 }), WIDE);
        expect(frame).toContain("run 2/3");
        expect(frame).toContain("ctrl+n next run");
    });

    test("hint labels come from the props, so a remapped chord is advertised correctly", async () => {
        // The mount derives these from `keybindLabel`; passing different ones proves nothing is
        // hand-written inside the component.
        const frame = await renderFrame(panel({ activeCount: 2, nextKeyLabel: "ctrl+9", dismissKeyLabel: "ctrl+0" }), WIDE);
        expect(frame).toContain("ctrl+9 next run");
        expect(frame).toContain("ctrl+0 hide");
    });
});

describe("RunActivityPanel degradation", () => {
    test("a stale entry keeps the run and its last known frontier, marked unavailable", async () => {
        const frame = await renderFrame(panel({ progress: progress({ stale: true }) }), WIDE);
        // Still present — a panel that vanished on a blip is indistinguishable from a finished run.
        expect(frame).toContain("Differential expression");
        expect(frame).toContain("align reads");
        expect(frame).toContain("unavailable");
    });

    test("a fresh entry carries no unavailable marker", async () => {
        const frame = await renderFrame(panel(), WIDE);
        expect(frame).not.toContain("unavailable");
    });
});

describe("RunActivityPanel legibility on a light theme", () => {
    // A character frame carries no color, so `toContain` passes identically for a correctly-painted
    // span and one that fell through to opentui's opaque-white default. github-light's bg is pure
    // #ffffff, where that default is fully invisible — the sharpest case for this class of defect.
    const LIGHT = "github-light";
    afterEach(() => setTheme(DEFAULT_THEME_ID));

    /** The fg of the first captured span whose text contains `needle`. */
    function spanFg(setup: Awaited<ReturnType<typeof testRender>>, needle: string): RGBA | undefined {
        for (const line of setup.captureSpans().lines) {
            for (const span of line.spans) {
                if (span.text.includes(needle)) return span.fg;
            }
        }
        return undefined;
    }

    test("the run name, step name, agent, and activity each resolve a themed foreground", async () => {
        setTheme(LIGHT);
        const setup = await testRender(panel(), WIDE);
        try {
            await setup.renderOnce();
            const colors = themes[LIGHT].colors;
            const white = parseColor("#ffffff");

            const name = spanFg(setup, "Differential expression");
            expect(name).toBeDefined();
            expect(name && parseColor(colors.fg).equals(name)).toBe(true);

            const stepName = spanFg(setup, "align reads");
            expect(stepName && parseColor(colors.fg).equals(stepName)).toBe(true);

            const agent = spanFg(setup, "bioinformatician");
            expect(agent && parseColor(colors.tool).equals(agent)).toBe(true);

            const label = spanFg(setup, "tool bash");
            expect(label && parseColor(colors.fgMuted).equals(label)).toBe(true);

            // The regression this whole block exists to catch.
            for (const span of [name, stepName, agent, label]) expect(span && white.equals(span)).toBe(false);
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a stale panel mutes its name and step rather than leaving them unpainted", async () => {
        setTheme(LIGHT);
        const setup = await testRender(panel({ progress: progress({ stale: true }) }), WIDE);
        try {
            await setup.renderOnce();
            const muted = parseColor(themes[LIGHT].colors.fgMuted);
            expect(muted.equals(spanFg(setup, "Differential expression") ?? parseColor("#000000"))).toBe(true);
            expect(muted.equals(spanFg(setup, "align reads") ?? parseColor("#000000"))).toBe(true);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("RunActivityPanel chrome across terminal heights", () => {
    // A flexGrow scrollbox renders one row TALLER than it contributes to the column, so a fixed row
    // beneath it must paint its own background across the full width or scrolled content bleeds
    // through the gaps between its glyphs. And a non-numeric width defaults to flexShrink: 1, which
    // collapses the panel below its own height on a short terminal. Both defects are size-dependent
    // — a single height hides them — so this sweeps a range with the panel in its real position:
    // beneath a filled flexGrow scrollbox, above a fixed input row.
    function column(height: number) {
        return () => (
            <box flexDirection="column" width={60} height={height}>
                <scrollbox flexGrow={1} minHeight={0}>
                    {Array.from({ length: 40 }, (_, i) => (
                        <text fg="#888888">{`BLEEDCANARY-${i}`}</text>
                    ))}
                </scrollbox>
                <RunActivityPanel
                    progress={progress({ steps: [step({ label: "align reads", agent: "bioinformatician" })] })}
                    activity="tool bash"
                    activeCount={2}
                    position={1}
                    nextKeyLabel="ctrl+n"
                    dismissKeyLabel="ctrl+r"
                    onNext={() => {}}
                />
                <box width="100%" flexShrink={0}>
                    <text fg="#888888">INPUTROW</text>
                </box>
            </box>
        );
    }

    for (const height of [8, 10, 12, 16, 20, 30, 40]) {
        test(`height ${height}: the panel keeps its rows, and no stream content bleeds into them`, async () => {
            const frame = await renderFrame(column(height), { width: 60, height });
            const lines = frame.split("\n");

            // The panel did not collapse: its identity row and its hint row both survive.
            expect(frame).toContain("Differential expression");
            expect(frame).toContain("next run");
            // The fixed input row below it is never squeezed out either.
            expect(frame).toContain("INPUTROW");

            // No stream content shares a line with any panel row. A bleed shows up exactly here: the
            // scrollbox's last row overlapping the panel's first.
            for (const line of lines) {
                if (line.includes("Differential expression") || line.includes("align reads") || line.includes("next run")) {
                    expect(line).not.toContain("BLEEDCANARY");
                }
            }
        });
    }

    test("with no run the column composes exactly as it would with no panel present", async () => {
        const withPanel = await renderFrame(
            () => (
                <box flexDirection="column" width={60} height={16}>
                    <scrollbox flexGrow={1} minHeight={0}>
                        <text fg="#888888">STREAM</text>
                    </scrollbox>
                    <RunActivityPanel progress={undefined} activeCount={0} position={0} nextKeyLabel="ctrl+n" dismissKeyLabel="ctrl+r" onNext={() => {}} />
                    <box width="100%" flexShrink={0}>
                        <text fg="#888888">INPUTROW</text>
                    </box>
                </box>
            ),
            { width: 60, height: 16 },
        );
        const withoutPanel = await renderFrame(
            () => (
                <box flexDirection="column" width={60} height={16}>
                    <scrollbox flexGrow={1} minHeight={0}>
                        <text fg="#888888">STREAM</text>
                    </scrollbox>
                    <box width="100%" flexShrink={0}>
                        <text fg="#888888">INPUTROW</text>
                    </box>
                </box>
            ),
            { width: 60, height: 16 },
        );
        expect(withPanel).toBe(withoutPanel);
    });
});
