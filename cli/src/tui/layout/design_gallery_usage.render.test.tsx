import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { rgbToHex } from "@opentui/core";
import { ok, okAsync } from "neverthrow";
import type { JSX } from "solid-js";
import type { DbError as HarnessDbError, StepExecutionRow } from "@inflexa-ai/harness";

import { DEFAULT_THEME_ID, GLYPHS, size, themes } from "../../lib/design_system.ts";
import { formatTokenFigure, formatTokenFigureLabelled, tokenFigureDetail } from "../../lib/usage_format.ts";
import { contrast } from "../../test_support/contrast.ts";
import { setTheme } from "../theme.ts";
import { useKeymapRoot } from "../keymap.ts";
import { DialogOverlay, DialogShowcase, dialogClear, dialogPush } from "../components/dialog/dialog_host.tsx";
import { RunDetailDialog } from "../components/dialog/run_detail_dialog.tsx";
import { UsageDialog, type SessionUsageSnapshot } from "../components/dialog/usage_dialog.tsx";
import { RunBlock } from "../components/run_block.tsx";
import { FixedList } from "../components/fixed_list.tsx";
import { absTimeShort, idTail, shortRunName } from "../hooks/sidebar_live.ts";
import { DesignGallery } from "./design_gallery.tsx";
import { mockCortexRuns, mockLongRun, mockRun, mockRunUsage, mockUsageSnapshot } from "./design_gallery_fixtures.ts";
import type { DbError as LocalDbError } from "../../db/errors.ts";

// The design gallery is where a token figure gets REVIEWED, so a figure that renders invisible there
// is worse than one missing: the reviewer signs off on a state nobody could see. This file measures
// the gallery's figure-bearing exhibits on a LIGHT theme, which is the only place the defect shows.
//
// The defect class: opentui defaults an uncolored <text> to opaque white. On the five dark themes that
// scores 12–18:1 — off-palette but legible, which is exactly what hides it from anyone checking on the
// dark default. `github-light`'s bg is pure #ffffff, so the same span measures 1.00:1 and vanishes.
// captureCharFrame() carries no color, so `toContain("↑809.2k")` passes identically on an invisible
// span; captureSpans() exposes each span's RESOLVED fg, which is what every claim here reads.
//
// Scoped to the FIGURE spans on purpose. `theme_contrast.render.test.tsx` already sweeps every span of
// the block set (and, now that the gallery's run fixtures carry figures, the step figure line rides
// that sweep for free); what it cannot say is that the figure was on screen at all — an empty sweep
// and a clean one look alike. Each case here locates the exact string the shared formatter wrote, so a
// figure that stopped rendering fails as a missing span rather than passing as a quiet absence.

const LIGHT = "github-light";
const WHITE = "#ffffff";
/** WCAG AA for text. A token figure is a measurement the reader acts on, never decoration. */
const TEXT_FLOOR = 4.5;

type Setup = Awaited<ReturnType<typeof testRender>>;

/**
 * Every span whose text contains `figure`, with the surface it was painted on.
 *
 * opentui carries an ancestor box's `backgroundColor` into its spans, so a row highlighted by the
 * list cursor is measured against THAT highlight rather than against the app background behind it.
 * `rgbToHex` appends an alpha byte only for a non-opaque color, so a 7-character result is exactly the
 * "something real was painted here" test; anything else means the span sits on the surface passed in.
 */
function figureSpans(setup: Setup, figure: string, surface: string): { fg: string; bg: string }[] {
    const found: { fg: string; bg: string }[] = [];
    for (const line of setup.captureSpans().lines) {
        for (const span of line.spans) {
            if (!span.text.includes(figure)) continue;
            const bgHex = rgbToHex(span.bg);
            found.push({ fg: rgbToHex(span.fg), bg: bgHex.length === 7 ? bgHex : surface });
        }
    }
    return found;
}

/** One exhibit, rendered exactly as the gallery drives it, plus the figure it must paint. */
type FigureCase = {
    /** Exhibit name, used in the failure message. */
    name: string;
    /** The block under its gallery fixtures. */
    node: () => JSX.Element;
    /**
     * The figure string this surface must paint, taken from the fixture that produced it rather than
     * typed out — a literal here could pass against a notation the formatter no longer writes.
     */
    figure: string;
    /**
     * The surface the exhibit is painted on: the app background for a stream/rail block, the raised
     * panel for anything the gallery wraps in a dialog showcase.
     */
    surface: string;
    /** Terminal size, wide/tall enough that the figure is not laid out off-screen. */
    size: { width: number; height: number };
};

const colors = themes[LIGHT].colors;

/**
 * The runs-picker row shape, as both the gallery exhibit and the live picker build it: the figure is a
 * trailing segment of the row's `meta` line, which a row carrying `meta` owns instead of an inline
 * hint. Only the figure's legibility is claimed here, so the surrounding segments are along for the
 * ride — they are what puts the figure at the far end of a long muted line rather than alone on one.
 */
function pickerItems(): { value: string; title: string; meta: string }[] {
    return mockCortexRuns.map((run) => {
        const totals = mockRunUsage.get(run.runId);
        const figure = totals ? formatTokenFigure(totals) : "";
        return {
            value: run.runId,
            title: shortRunName(run),
            meta: `${idTail(run.runId)} ${GLYPHS.middot} ${run.status} ${GLYPHS.middot} ${absTimeShort(run.startedAt)}${figure ? ` ${GLYPHS.middot} ${figure}` : ""}`,
        };
    });
}

/** The gallery's usage-dialog exhibit, driven exactly as the gallery drives it. */
function usageDialogExhibit(): JSX.Element {
    return (
        <DialogShowcase>
            <UsageDialog
                analysisName="rna-seq-2026"
                loadUsage={() => ok<SessionUsageSnapshot, LocalDbError>(mockUsageSnapshot)}
                onClose={() => dialogClear()}
            />
        </DialogShowcase>
    );
}

/**
 * The headline's arms as the LABELLED form writes them, read off the fixture the exhibit renders.
 *
 * Derived rather than typed out for the same reason every other figure here is: a literal would keep
 * passing against a form the module no longer writes, and the labelled headline is the one figure in
 * this gallery that no other exhibit paints.
 *
 * The guard below is what lets the cases read `headline.input.labelled` without an assertion: a
 * fixture edited down to one arm fails as a bad fixture rather than as a mysteriously empty exhibit.
 */
const headline = tokenFigureDetail(mockUsageSnapshot.totals);
if (headline.input === null || headline.output === null) throw new Error("the usage fixture must report both arms for the headline cases below");

const CASES: FigureCase[] = [
    {
        // The dialog headline's LEADING arm — the labelled form, painted bold on the panel.
        name: "UsageDialog — the labelled headline's leading arm",
        node: usageDialogExhibit,
        figure: headline.input.labelled,
        surface: colors.bgRaised,
        size: { width: 100, height: 34 },
    },
    {
        // ...and its TRAILING arm, which is the one the edge-alignment fix moved. A figure pinned to
        // the panel's far edge is exactly where an unresolved foreground goes unnoticed longest.
        name: "UsageDialog — the labelled headline's trailing arm",
        node: usageDialogExhibit,
        figure: headline.output.labelled,
        surface: colors.bgRaised,
        size: { width: 100, height: 34 },
    },
    {
        // The wide mount: every step's figure on its own indented line under the step it details.
        name: "RunBlock — per-step figure (full mount)",
        node: () => <RunBlock name={mockRun.name} tag={mockRun.tag} done={mockRun.done} total={mockRun.total} steps={mockRun.steps} />,
        figure: mockRun.steps[0]!.usageFigure!,
        surface: colors.bg,
        size: { width: 80, height: 24 },
    },
    {
        // The rail mount is the one the figure line was measured against — ~37 usable cells, windowed
        // steps, elision markers. Its figures are the ones most at risk of being unreadable.
        name: "RunBlock — per-step figure (windowed rail mount)",
        node: () => (
            <RunBlock
                name={mockLongRun.name}
                tag={mockLongRun.tag}
                done={mockLongRun.done}
                total={mockLongRun.total}
                steps={mockLongRun.steps}
                maxSteps={size.railStepRows}
                hint={false}
                heading={false}
            />
        ),
        // The step the window centres on, so the assertion cannot pass on a row that happens to be
        // visible at one terminal size and scrolled away at another.
        figure: mockLongRun.steps[7]!.usageFigure!,
        surface: colors.bg,
        size: { width: 44, height: 24 },
    },
    {
        // The run-detail dialog's `usage` property line, wrapped in the same inert showcase context the
        // gallery gives it. Its metadata lines render on the first frame (the step fetch is what is
        // async), so the figure is measurable without waiting on the load.
        name: "RunDetailDialog — the usage property line",
        node: () => (
            <DialogShowcase>
                <RunDetailDialog
                    run={mockCortexRuns[0]!}
                    loadSteps={() => okAsync<StepExecutionRow[], HarnessDbError>([])}
                    usage={mockRunUsage.get(mockCortexRuns[0]!.runId)}
                    onClose={() => dialogClear()}
                />
            </DialogShowcase>
        ),
        // The LONG form on this line, unlike every other case in this table: a `label value` property
        // line in a full-width dialog spends words where a rail decoration cannot.
        figure: formatTokenFigureLabelled(mockRunUsage.get(mockCortexRuns[0]!.runId)!),
        surface: colors.bgRaised,
        size: { width: 100, height: 30 },
    },
    {
        // A figure riding a row's `meta` line — the runs picker. Row 0 is the cursor row, so this also
        // measures the figure against the list's highlight rather than only against the panel.
        name: "FixedList — figure in a row's meta line (runs picker)",
        node: () => <FixedList items={pickerItems()} emptyText="no runs" />,
        figure: formatTokenFigure(mockRunUsage.get(mockCortexRuns[0]!.runId)!),
        surface: colors.bgRaised,
        size: { width: 80, height: 12 },
    },
    {
        // A figure riding a row's inline `hint` — the Switch analysis picker, the one surface that
        // reports a whole-analysis total. A different span from the meta line above, painted on the
        // same line as the title rather than on one of its own.
        name: "FixedList — figure as a row's inline hint (Switch analysis)",
        node: () => (
            <FixedList
                items={[
                    { value: "1", title: "rna-seq-2026", hint: formatTokenFigure({ inputTokens: 2_140_000, outputTokens: 96_300 }), description: "de" },
                    { value: "2", title: "scrna-atlas" },
                ]}
                emptyText="No analyses"
            />
        ),
        figure: formatTokenFigure({ inputTokens: 2_140_000, outputTokens: 96_300 }),
        surface: colors.bgRaised,
        size: { width: 80, height: 12 },
    },
];

describe("design gallery — token figures are legible on a light theme", () => {
    afterEach(() => {
        dialogClear();
        setTheme(DEFAULT_THEME_ID);
    });

    // The gallery mounts every exhibit at once, so a prop the type system accepts but a widget rejects
    // at runtime takes the whole showcase down — and the showcase is precisely the surface nobody is
    // watching until they open it to review something else. Cheap smoke: it opens and paints its title.
    //
    // Two opentui log lines are EXPECTED here and are properties of mounting two dozen exhibits at
    // once rather than of this test — the live gallery emits both: the "possible EventTarget memory
    // leak" warning for its selection / layout-changed listeners, and a "TreeSitter client destroyed"
    // line at teardown, from the highlighted code exhibits still parsing when the renderer goes down.
    // Noise to expect, not failures to chase.
    test("the whole gallery mounts and paints", async () => {
        const setup = await testRender(
            () => {
                useKeymapRoot();
                return (
                    <box width="100%" height="100%">
                        <DialogOverlay />
                    </box>
                );
            },
            { width: 120, height: 40 },
        );
        try {
            await setup.renderOnce();
            dialogPush(() => <DesignGallery onClose={() => dialogClear()} />);
            await new Promise((r) => setTimeout(r, 20));
            await setup.renderOnce();
            await setup.renderOnce();

            expect(setup.captureCharFrame()).toContain("Design system");
        } finally {
            setup.renderer.destroy();
        }
    });

    for (const c of CASES) {
        test(`${c.name} paints "${c.figure}" with a resolved foreground`, async () => {
            setTheme(LIGHT);
            const setup = await testRender(
                () => (
                    <box width="100%" height="100%" backgroundColor={c.surface}>
                        {c.node()}
                    </box>
                ),
                c.size,
            );
            try {
                await setup.renderOnce();
                await setup.renderOnce();

                const spans = figureSpans(setup, c.figure, c.surface);
                // Non-vacuity first, and reported on its own: a colour verdict over zero spans attests
                // to nothing, and a figure that stopped rendering must read as a missing exhibit rather
                // than as a clean bill of health.
                expect({ case: c.name, painted: spans.length > 0 }).toEqual({ case: c.name, painted: true });

                for (const span of spans) {
                    // The exact defect: an fg-less <text> falls through to opentui's opaque white, which
                    // on this theme's pure-white bg is 1.00:1 and invisible to any character assertion.
                    expect({ case: c.name, fg: span.fg }).not.toEqual({ case: c.name, fg: WHITE });
                    const ratio = contrast(span.fg, span.bg);
                    expect({ case: c.name, legible: ratio >= TEXT_FLOOR, ratio: Number(ratio.toFixed(2)), on: span.bg }).toEqual({
                        case: c.name,
                        legible: true,
                        ratio: Number(ratio.toFixed(2)),
                        on: span.bg,
                    });
                }
            } finally {
                setup.renderer.destroy();
            }
        });
    }
});
