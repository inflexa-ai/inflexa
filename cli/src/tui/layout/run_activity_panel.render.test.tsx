import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { parseColor, type RGBA } from "@opentui/core";
import { createSignal } from "solid-js";

import { DEFAULT_THEME_ID, GLYPHS, themes } from "../../lib/design_system.ts";
import { setTheme } from "../theme.ts";
import { ELAPSED_TICK_MS, RunActivityPanel } from "./run_activity_panel.tsx";
import type { ActiveRunProgress } from "../hooks/sidebar_live.ts";
import type { RunStepView } from "../components/run_block.tsx";

// The panel is the chat column's live frontier readout. Its contract has three legs, and only the
// first is a character-frame question:
//   - CONTENT: the frontier (running steps only), never the full step list.
//   - PRESENCE: zero rows when there is no run — an idle chat must compose exactly as before.
//   - CHROME: a full-width painted box that neither bleeds nor collapses, verified over a HEIGHT
//     SWEEP because that class of defect is size-dependent and a single height hides it.

const WIDE = { width: 80, height: 12 };

/**
 * A frame of a panel that has finished measuring itself.
 *
 * The shared `renderFrame` renders once, which is a frame too early for this component: the panel
 * sizes its legend from its own computed width, and that width is only readable a macrotask after
 * mount (the layout pass runs inside the render loop). Asserting on the single-render frame would
 * pin the pre-measurement fallback — the bare region name — and so would pass no matter what the
 * legend logic did. Every assertion in this file goes through here for that reason.
 */
async function settledFrame(node: Parameters<typeof testRender>[0], size: { width: number; height: number }): Promise<string> {
    const setup = await testRender(node, size);
    try {
        for (let i = 0; i < 3; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            await setup.renderOnce();
        }
        return setup
            .captureCharFrame()
            .split("\n")
            .map((line) => line.trimEnd())
            .join("\n")
            .trimEnd();
    } finally {
        setup.renderer.destroy();
    }
}

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
        const frame = await settledFrame(panel(), WIDE);
        expect(frame).toContain("Differential expression");
        expect(frame).toContain("1/3");
        expect(frame).toContain("align reads");
        expect(frame).toContain("[bioinformatician]");
        expect(frame).toContain("tool bash");
    });

    test("the frontier only — done and queued steps stay in the rail, not here", async () => {
        const frame = await settledFrame(panel(), WIDE);
        expect(frame).toContain("align reads");
        // The step list belongs to the sidebar. Rendering it here too would put one widget on screen
        // twice, which is the duplication the panel exists to avoid.
        expect(frame).not.toContain("quality control");
        expect(frame).not.toContain("summarize");
    });

    test("every parallel frontier step is shown, not just the first", async () => {
        const frame = await settledFrame(
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
        const frame = await settledFrame(panel({ activity: "some-new-step-kind" }), WIDE);
        expect(frame).toContain("some-new-step-kind");
    });

    test("an unresolvable activity label is omitted, and the rest of the frontier still renders", async () => {
        const frame = await settledFrame(panel({ activity: null }), WIDE);
        expect(frame).toContain("align reads");
        expect(frame).toContain("[bioinformatician]");
        expect(frame).not.toContain("tool bash");
    });

    test("no run → zero rows: the panel renders nothing at all", async () => {
        // Rendered directly rather than through `panel()`: Solid's prop merge treats an `undefined`
        // value in a spread as "not provided", so it cannot clear a prop an earlier source set.
        const frame = await settledFrame(
            () => <RunActivityPanel progress={undefined} activeCount={0} position={0} nextKeyLabel="ctrl+n" dismissKeyLabel="ctrl+r" onNext={() => {}} />,
            WIDE,
        );
        expect(frame.trim()).toBe("");
    });
});

describe("RunActivityPanel repaint", () => {
    test("a props change repaints the frontier, the counts, and the activity in place", async () => {
        // Every other test in this file renders once against static props, which cannot distinguish a
        // panel that tracks its inputs from one that latched them at mount — the exact failure a live
        // readout must not have. One mount, two prop generations.
        const [snapshot, setSnapshot] = createSignal(progress());
        const [activity, setActivity] = createSignal("tool bash");
        const setup = await testRender(
            () => (
                <RunActivityPanel
                    progress={snapshot()}
                    activity={activity()}
                    activeCount={1}
                    position={1}
                    nextKeyLabel="ctrl+n"
                    dismissKeyLabel="ctrl+r"
                    onNext={() => {}}
                />
            ),
            WIDE,
        );
        try {
            await setup.renderOnce();
            const before = setup.captureCharFrame();
            expect(before).toContain("align reads");
            expect(before).toContain("1/3");
            expect(before).toContain("tool bash");

            setSnapshot(
                progress({
                    done: 2,
                    steps: [
                        step({ label: "quality control", state: "done" }),
                        step({ label: "align reads", state: "done" }),
                        step({ label: "summarize", state: "running", agent: "analyst" }),
                    ],
                }),
            );
            setActivity("tool samtools sort");
            await setup.renderOnce();

            const after = setup.captureCharFrame();
            expect(after).toContain("summarize");
            expect(after).toContain("[analyst]");
            expect(after).toContain("2/3");
            expect(after).toContain("tool samtools sort");
            // The frontier moved on — the step that finished must leave, or the panel is showing a
            // stale frontier beside fresh counts.
            expect(after).not.toContain("align reads");
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("RunActivityPanel elapsed clock", () => {
    // Elapsed is driven by the panel's own ticker, not by its data feed. The two are distinguishable
    // only under a frozen feed: if the readout advances while the progress object never changes, it
    // cannot be a side effect of a refresh — which is what keeps a stalled VIEW from reading as a
    // stalled RUN.
    afterEach(() => setSystemTime());

    test("elapsed advances with no change to the underlying run data", async () => {
        const frozen = progress({ startedAt: Date.ago(0), steps: [step({ label: "align reads", startedAt: Date.ago(0) })] });
        const setup = await testRender(
            () => (
                <RunActivityPanel
                    progress={frozen}
                    activity="tool bash"
                    activeCount={1}
                    position={1}
                    nextKeyLabel="ctrl+n"
                    dismissKeyLabel="ctrl+r"
                    onNext={() => {}}
                />
            ),
            WIDE,
        );
        try {
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain(`${GLYPHS.middot} 0s`);

            // Move the wall clock, never the data: `frozen` is the same object across both frames, so
            // anything that changes on screen can only have come from the ticker. Two hours rather
            // than a few seconds because the readout's coarse unit then absorbs the real time this
            // test must also spend waiting out one tick — the assertion pins a value, not a race.
            setSystemTime(new Date(Date.now() + 2 * 60 * 60_000));
            await Promise.sleep(ELAPSED_TICK_MS + 250);
            await setup.renderOnce();

            const after = setup.captureCharFrame();
            expect(after).toContain("2h00m");
            expect(after).not.toContain(`${GLYPHS.middot} 0s`);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("RunActivityPanel navigation", () => {
    test("a single active run names no position and offers no next-run chord", async () => {
        const frame = await settledFrame(panel({ activeCount: 1, position: 1 }), WIDE);
        expect(frame).toContain("RUN · ctrl+r hide");
        expect(frame).not.toContain("1/1");
        expect(frame).not.toContain("next");
    });

    test("several active runs put the position and the next-run chord in the legend", async () => {
        const frame = await settledFrame(panel({ activeCount: 3, position: 2 }), WIDE);
        expect(frame).toContain("RUN 2/3 · ctrl+n next · ctrl+r hide");
    });

    test("the legend's chords come from the props, so a remapped chord is advertised correctly", async () => {
        // The mount derives these from `keybindLabel`; passing different ones proves nothing is
        // hand-written inside the component.
        const frame = await settledFrame(panel({ activeCount: 2, nextKeyLabel: "ctrl+9", dismissKeyLabel: "ctrl+0" }), WIDE);
        expect(frame).toContain("ctrl+9 next");
        expect(frame).toContain("ctrl+0 hide");
    });

    test("the run's own rows carry no view state — no position, no chord hints", async () => {
        const lines = (await settledFrame(panel({ activeCount: 3, position: 2 }), WIDE)).split("\n");
        // Everything below the rule describes the RUN. The position and the chords are facts about the
        // region, so they live on the frame; a content row carrying either is the defect this pins.
        const body = lines.slice(1).join("\n");
        expect(body).not.toContain("2/3");
        expect(body).not.toContain("ctrl+n");
        expect(body).not.toContain("ctrl+r");
    });
});

describe("RunActivityPanel legend fits the panel's width", () => {
    // opentui renders a border title only when the box is at least `title.length + 4` wide and
    // otherwise DROPS it — silently, taking the region's name with it. So the legend degrades by a
    // ladder, and the boundary is worth pinning: a 40-column tmux pane is a real case, and the
    // difference between "sheds its chords" and "renders an unlabelled rule" is invisible without it.
    const CASES = [
        { width: 100, expect: "RUN 2/3 · ctrl+n next · ctrl+r hide", note: "roomy: the whole legend" },
        { width: 41, expect: "RUN 2/3 · ctrl+n next · ctrl+r hide", note: "the exact width the full legend still fits" },
        { width: 40, expect: "RUN 2/3", note: "one column short: chords shed, position survives" },
        { width: 14, expect: "RUN", note: "narrow: the region's name alone" },
    ] as const;

    for (const c of CASES) {
        test(`${c.width} columns — ${c.note}`, async () => {
            const frame = await settledFrame(panel({ activeCount: 3, position: 2 }), { width: c.width, height: 12 });
            expect(frame.split("\n")[0]).toContain(c.expect);
        });
    }

    test("the rule is never left unlabelled at any width the panel can be given", async () => {
        for (let width = 12; width <= 60; width += 1) {
            const frame = await settledFrame(panel({ activeCount: 3, position: 2 }), { width, height: 12 });
            expect(frame.split("\n")[0]).toContain("RUN");
        }
    });
});

describe("RunActivityPanel degradation", () => {
    test("a stale entry keeps the run and its last known frontier, marked unavailable", async () => {
        const frame = await settledFrame(panel({ progress: progress({ stale: true }) }), WIDE);
        // Still present — a panel that vanished on a blip is indistinguishable from a finished run.
        expect(frame).toContain("Differential expression");
        expect(frame).toContain("align reads");
        expect(frame).toContain("unavailable");
    });

    test("a fresh entry carries no unavailable marker", async () => {
        const frame = await settledFrame(panel(), WIDE);
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

    test("the rule's RUN label resolves the muted role", async () => {
        // The label rides the border row, which opentui paints straight into the buffer from the box's
        // `titleColor` rather than through a <text> — a path with its own default, and one no character
        // frame can speak about at all. Span color is the only assertion that can say it is legible.
        setTheme(LIGHT);
        const setup = await testRender(panel(), WIDE);
        try {
            await setup.renderOnce();
            const label = spanFg(setup, "RUN");
            expect(label).toBeDefined();
            expect(label && parseColor(themes[LIGHT].colors.fgMuted).equals(label)).toBe(true);
            expect(label && parseColor("#ffffff").equals(label)).toBe(false);
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
                    activity="Running script deseq2.R"
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

    // Each panel row, named by a substring that identifies it. The RULE row leads deliberately: it is
    // the row directly beneath the scrollbox, so it is the one the bleed reaches first. Its label also
    // proves the rule itself is drawn — opentui paints a title onto the top border side, so the label
    // cannot appear unless that side exists.
    const PANEL_ROWS = [" RUN ", "Differential expression", "align reads", "Running script"];

    for (const height of [8, 10, 12, 16, 20, 30, 40]) {
        test(`height ${height}: the panel keeps its rows, and no stream content bleeds into them`, async () => {
            const frame = await settledFrame(column(height), { width: 60, height });
            const lines = frame.split("\n");

            // The panel did not collapse: rule, identity, frontier and activity all survive.
            for (const row of PANEL_ROWS) expect(frame).toContain(row);
            // The fixed input row below it is never squeezed out either — and it sits DIRECTLY under
            // the panel's last row, so the panel drew no bottom rule of its own. That is not a spare
            // assertion: opentui promotes a box carrying `borderStyle`/`borderColor` but no explicit
            // `border` to a full four-sided frame, so losing the top-only intent is a silent edit, and
            // the result is the two-parallel-hairlines-around-an-empty-row shape the design rejects.
            const lastPanelRow = lines.findIndex((line) => line.includes("Running script"));
            expect(lines[lastPanelRow + 1]).toContain("INPUTROW");

            // No stream content shares a line with any panel row. A bleed shows up exactly here: the
            // scrollbox's last row overlapping the panel's first.
            for (const line of lines) {
                if (PANEL_ROWS.some((row) => line.includes(row))) {
                    expect(line).not.toContain("BLEEDCANARY");
                }
            }
        });
    }

    test("with no run the column composes exactly as it would with no panel present", async () => {
        const withPanel = await settledFrame(
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
        const withoutPanel = await settledFrame(
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
