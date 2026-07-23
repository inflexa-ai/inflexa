import { createEffect, createMemo, createSignal, For, on, Show, type Accessor } from "solid-js";
import { useRenderer } from "@opentui/solid";

import { theme } from "../theme.ts";
import { GLYPHS, space, MARKERS } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** A run step's display shape (domain-agnostic; the mock model + the harness step ledger map onto this). */
export type RunStepView = {
    /** Human label shown in the step list. */
    label: string;
    /** Lifecycle state, selecting the step glyph + color. */
    state: "done" | "running" | "failed" | "queued";
    /**
     * ISO start time of a `running` step, from the ledger's `started_at`. Meaningful only while the step
     * is running — the block renders its elapsed age beside the label so a long step reads as live rather
     * than wedged. Absent (or unparseable) → no age, exactly as before; non-running rows never show one.
     */
    startedAt?: string | null;
};

/** Props for {@link RunBlock}. */
export type RunBlockProps = {
    /** Run name, e.g. `drug-repurposing`. */
    name: string;
    /** Short run tag, e.g. `T5S1`. */
    tag: string;
    /** Completed step count (numerator of the progress bar). */
    done: number;
    /** Total step count (denominator of the progress bar). */
    total: number;
    /** Ordered steps. */
    steps: RunStepView[];
    /**
     * Whether to show the `esc detach · ctrl+c abort` footer. Defaults to `true` (the gallery + any
     * live run view). Set `false` where those keys are NOT the block's to own — e.g. inside the runs
     * dialog, where `esc` closes the dialog (not the run) and no abort chord is bound, so the footer
     * would advertise an affordance that does not exist.
     */
    hint?: boolean;
    /**
     * Whether to show the `● name tag` heading line. Defaults to `true`. Set `false` where the block
     * sits directly under a row that already names the run — the sidebar RUNS section renders the
     * progress embed beneath the run's own row, and repeating the name would read as a second run.
     */
    heading?: boolean;
    /**
     * Cap on how many step rows to render at once. When the run has enough steps that windowing
     * actually saves rows, the list shows a WINDOW of `maxSteps` rows over the steps, centred on the
     * earliest step still running and thereafter positioned by the reader — each elision marker names
     * how many steps are hidden on its side AND slides the window one step that way when clicked. The
     * window returns to the work whenever the set of running steps changes. The progress bar and
     * `done/total` always reflect the FULL run — only the step list is windowed.
     * Absent → the whole list renders and the markers never appear (the runs dialog keeps its complete,
     * non-interactive view). Exists for the narrow rail mount, where a long run must not grow the embed
     * without bound.
     *
     * Prefer an ODD value: the window centres by placing the frontier at `floor(maxSteps / 2)`, which is
     * the exact middle row only when the count is odd.
     */
    maxSteps?: number;
};

/**
 * The step list's visible slice plus how many steps the window elides on each side. Both counts zero
 * means the whole list is rendered. The counts are what the elision markers report, so a hidden step is
 * never merely absent — the reader can always reconcile the rows on screen against `done/total`.
 */
type StepWindow = {
    /** The steps to render, in order. */
    steps: RunStepView[];
    /** How many steps precede the slice. */
    hiddenBefore: number;
    /** How many steps follow the slice. */
    hiddenAfter: number;
};

/**
 * Cell budget for the progress meter in the narrow (windowed) mount. The default meter is one cell per
 * step, which soft-wraps the ~40-column rail once a run passes ~30 steps; when `maxSteps` signals that
 * narrow mount the meter is scaled to at most this many cells instead. ~20 keeps it comfortably inside
 * the rail while still reading as a proportional bar.
 */
const BAR_BUDGET = 20;

/**
 * An elision marker's text — `4 earlier steps` / `1 more step`. Named counts, not a bare `…`: the
 * marker's job is to let the reader reconcile the visible rows against `done/total` and see where the
 * window sits, neither of which a shape-only ellipsis can do. Painted in the muted TEXT tier by its
 * caller (not the `fgSubtle` decoration tier) because it carries information and must clear the 4.5:1
 * floor; the directional arrow is a separate accent span, so it is not part of this string.
 */
function elisionLabel(count: number, word: "earlier" | "more"): string {
    return `${count} ${word} step${count === 1 ? "" : "s"}`;
}

/** The themed glyph + color role for a step's state. */
function stepMark(state: RunStepView["state"]): { glyph: string; role: "success" | "warning" | "error" | "fgSubtle" } {
    if (state === "done") return { glyph: GLYPHS.check, role: "success" };
    if (state === "running") return { glyph: GLYPHS.triangleRight, role: "warning" };
    if (state === "failed") return { glyph: GLYPHS.cross, role: "error" };
    return { glyph: GLYPHS.circleHollow, role: "fgSubtle" };
}

/**
 * The long-running run / task block: the `●` marker with the run name and tag, a
 * filled/empty progress meter, an indented step list (done / running / queued),
 * and the detach/abort affordance.
 */
export function RunBlock(props: RunBlockProps) {
    // Read for its selection state alone, on the marker release path — the block renders nothing from it.
    const renderer = useRenderer();
    // The meter's cell counts. Without `maxSteps` it stays one cell per step — the dialog + gallery full
    // view, where the block owns its whole width. With `maxSteps` (the narrow rail mount, where a
    // 30+-step per-step bar soft-wraps the ~40-column slice) it scales to at most BAR_BUDGET cells,
    // `filled` proportional to done/total. A partially-done run is clamped to [1, cells−1] so mid-flight
    // work never paints as fully filled or fully empty — an honest signal beats a rounding artifact.
    const barCells = (): { filled: number; total: number } => {
        if (props.maxSteps === undefined) return { filled: props.done, total: props.total };
        const cells = Math.min(props.total, BAR_BUDGET);
        if (props.total <= 0) return { filled: 0, total: cells };
        const proportional = Math.round((props.done / props.total) * cells);
        const partial = props.done > 0 && props.done < props.total;
        return { filled: partial ? Math.min(cells - 1, Math.max(1, proportional)) : proportional, total: cells };
    };
    const filled = (): string => GLYPHS.bar.repeat(barCells().filled);
    const empty = (): string => {
        const c = barCells();
        return GLYPHS.bar.repeat(Math.max(0, c.total - c.filled));
    };
    // Where the reader has scrolled the window to, or null while it tracks the frontier on its own. The
    // rail re-reads the ledger every few seconds and hands this block a fresh steps array each tick; a
    // window that recentred on every tick would drag the list out from under someone reading the earlier
    // steps, so a click pins the position and only the two releases below let go of it.
    const [pinnedStart, setPinnedStart] = createSignal<number | null>(null);

    // The anchor the window centres on: the FIRST RUNNING step, because a plan's steps run in parallel
    // waves and several can be in flight at once. Anchoring on the earliest of them is what keeps a
    // still-running step on screen when a LATER sibling finishes — with the naive "first step that is not
    // done" rule, `[done, running, running, done]` collapsing to `[done, running, done, done]` would
    // leave the anchor on the finished sibling's side and scroll the work that is still live out of view.
    // Falls back to the first not-yet-done step between waves (nothing running, work still pending), and
    // to the tail once every step is done.
    //
    // A MEMO, not a plain accessor, and that is load-bearing for every reader below. `on(deps, fn)` runs
    // `fn` whenever a signal `deps` touched changes — it never diffs what `deps` returned — and the rail
    // hands this block a freshly-minted props object on every poll. Reading `props.steps` through a bare
    // accessor would therefore fire the release effects several times a minute and silently undo the
    // reader's scrolling. A memo re-computes just as often but only NOTIFIES on a real change.
    const anchorIndex = createMemo((): number => {
        const running = props.steps.findIndex((s) => s.state === "running");
        if (running !== -1) return running;
        const pending = props.steps.findIndex((s) => s.state !== "done");
        return pending === -1 ? props.steps.length - 1 : pending;
    });

    // What "the run's in-flight work" is, as a comparable value: every running step, plus the anchor so a
    // wave boundary with nothing running still counts as movement. The whole SET matters, not just the
    // anchor — when one of several parallel steps finishes, the anchor can stay put while the work
    // genuinely changed, and that is exactly a moment the reader wants to be looking at the run again.
    const activityKey = createMemo((): string => {
        const running: number[] = [];
        for (const [i, step] of props.steps.entries()) if (step.state === "running") running.push(i);
        return `${anchorIndex()}|${running.join(",")}`;
    });

    // Release 1 — the work moved. Snapping back to it is the point of the embed: it is a live progress
    // readout first and a browser second, so when the steps it exists to report change, the window
    // returns to them rather than stranding the reader on history they scrolled to minutes ago.
    createEffect(on(activityKey, () => setPinnedStart(null), { defer: true }));

    // Release 2 — a different run took over. The sidebar's progress embed is NOT keyed, so when one run
    // succeeds another the same block instance is handed the new run's props rather than being remounted
    // — without this the previous run's scroll position would carry onto a different run's steps. Memoed
    // for the same reason as the frontier: the tag string is re-read every poll but rarely changes.
    const runTag = createMemo((): string => props.tag);
    createEffect(on(runTag, () => setPinnedStart(null), { defer: true }));

    // The visible slice of the step list. Full list unless `maxSteps` caps it; then a window of that
    // many rows over the steps, clamped so it never runs past either end. Its default position centres
    // the anchor — with an odd `maxSteps` it lands on the exact middle row, so parallel siblings running
    // just after it are on screen too — and once the reader clicks an elision marker it sits wherever
    // they left it until a release above fires.
    const stepWindow = (): StepWindow => {
        const all = props.steps;
        const max = props.maxSteps;
        const whole: StepWindow = { steps: all, hiddenBefore: 0, hiddenAfter: 0 };
        if (max === undefined || all.length <= max) return whole;
        const auto = Math.max(0, Math.min(anchorIndex() - Math.floor(max / 2), all.length - max));
        // Each elided side spends a row on its marker, so a window only earns its place when those
        // markers occupy fewer rows than the steps they stand in for. Windowing 8 steps into 7 costs a
        // marker row to hide a single labelled step — the same height, strictly less information — and
        // that near-miss is the common case: an ordinary plan lands just over the cap. Below the
        // break-even point the whole list is the better render, so the cap engages only once it pays.
        // Measured at the AUTO position, never the pinned one, so scrolling can never change whether the
        // window exists — a click must move the window, not make it collapse into the full list.
        const markerRows = (auto > 0 ? 1 : 0) + (all.length - (auto + max) > 0 ? 1 : 0);
        if (max + markerRows >= all.length) return whole;
        const start = Math.max(0, Math.min(pinnedStart() ?? auto, all.length - max));
        return { steps: all.slice(start, start + max), hiddenBefore: start, hiddenAfter: all.length - (start + max) };
    };

    // Slide the window by `delta` steps, clamped to the list. `hiddenBefore` IS the current start, so the
    // shift composes off whatever is on screen whether the window is still auto-positioned or already
    // pinned. Every rendered marker is actionable by construction — a marker only exists when that side
    // hides something — so no click can be a no-op and no disabled state is needed.
    function shiftWindow(delta: number): void {
        const max = props.maxSteps;
        if (max === undefined) return;
        setPinnedStart(Math.max(0, Math.min(stepWindow().hiddenBefore + delta, props.steps.length - max)));
    }

    // The shift fires on mouse-DOWN: these are controls, not drag targets, and acting on the press means a
    // selection drag that merely ends here can never trigger one.
    function pressMarker(delta: number, e: { stopPropagation(): void }): void {
        e.stopPropagation();
        shiftWindow(delta);
    }

    // The matching mouse-UP has to be contained too, because the sidebar's RUNS section opens the runs
    // picker on mouse-up — an un-stopped release would scroll the window AND pop a dialog over it on the
    // same press. The one release worth letting through is the tail of a text-selection drag that happened
    // to end on a marker: the root's copy-on-select handler needs to see it, and the section's own
    // activation already ignores selection-carrying releases, so letting it bubble cannot open anything.
    //
    // Decided from the LIVE SELECTION rather than from press state remembered on mouse-down. A flag can
    // outlive its gesture: pressing a marker that then reaches the list's end unmounts that very marker,
    // so no mouse-up ever arrives to clear it, and the next unrelated release landing there would be
    // swallowed — losing a copy. Reading the selection has no lifetime to get wrong, and mirrors the guard
    // `openProfileFromSidebar`/`openRunsFromSidebar` already apply on the same gesture.
    function releaseMarker(e: { stopPropagation(): void }): void {
        if (renderer.getSelection()?.getSelectedText()) return;
        e.stopPropagation();
    }
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            {(props.heading ?? true) ? (
                <text>
                    <Fg role={MARKERS.run.role}>{`${MARKERS.run.glyph} `}</Fg>
                    <Fg role="fg">{props.name}</Fg> <Fg role="fgMuted">{props.tag}</Fg>
                </text>
            ) : null}
            <text paddingLeft={space.md}>
                <Fg role="success">{filled()}</Fg>
                <Fg role="fgSubtle">{empty()}</Fg> <Fg role="fgMuted">{`${props.done}/${props.total}`}</Fg>
            </text>
            <box paddingLeft={space.md} flexDirection="column" border={["left"]} borderColor={theme().border}>
                {/* The elision markers bracket the window so a truncated list never reads as a complete
                one — the rule the runs picker already follows for its 100-run cap: truncation is stated,
                never silent. They are also the window's scroll control: each click slides it one step
                toward that side, so the same row that admits what is hidden is the thing that reveals it,
                and the two counts double as the position indicator. The accent-colored arrow is the
                codebase's established "this row is clickable" affordance (see `OpenableCardBlock`).
                `selectable={false}` because these are buttons, not prose: the renderer's text selection
                would otherwise highlight the label on every press, which reads as the click having done
                something other than what it did. The STEP rows stay selectable — those are content a
                reader may legitimately want to copy. */}
                <Show when={stepWindow().hiddenBefore > 0}>
                    <text selectable={false} onMouseDown={(e) => pressMarker(-1, e)} onMouseUp={releaseMarker}>
                        <Fg role="accent">{`${GLYPHS.arrowUp} `}</Fg>
                        <Fg role="fgMuted">{elisionLabel(stepWindow().hiddenBefore, "earlier")}</Fg>
                    </text>
                </Show>
                <For each={stepWindow().steps}>
                    {(step) => {
                        const m = stepMark(step.state);
                        // Elapsed age of a running step, from its ledger start. The gate lives HERE, not
                        // in the row→view mapping, so both mapping sites stay dumb projections and every
                        // rule about WHEN an age shows is in one place: running rows only, and only when
                        // the timestamp parses. Muted TEXT tier (not the fgSubtle decoration tier) — it is
                        // information and must clear the 4.5:1 floor. `Date.relativeAge` is the shared
                        // elapsed-indicator vocabulary (never a hand-rolled formatter — see cli CLAUDE.md).
                        const age = (): string | null => {
                            if (step.state !== "running" || !step.startedAt) return null;
                            const t = Date.parse(step.startedAt);
                            return Number.isNaN(t) ? null : Date.relativeAge(t);
                        };
                        return (
                            <text>
                                <Fg role={m.role}>{`${m.glyph} `}</Fg>
                                <Fg role={step.state === "queued" ? "fgMuted" : "fg"}>{step.label}</Fg>
                                <Show when={age()}>{(a: Accessor<string>) => <Fg role="fgMuted">{` ${a()}`}</Fg>}</Show>
                            </text>
                        );
                    }}
                </For>
                <Show when={stepWindow().hiddenAfter > 0}>
                    <text selectable={false} onMouseDown={(e) => pressMarker(1, e)} onMouseUp={releaseMarker}>
                        <Fg role="accent">{`${GLYPHS.arrowDown} `}</Fg>
                        <Fg role="fgMuted">{elisionLabel(stepWindow().hiddenAfter, "more")}</Fg>
                    </text>
                </Show>
            </box>
            {(props.hint ?? true) ? <text fg={theme().fgMuted}>esc detach {GLYPHS.middot} ctrl+c abort</text> : null}
        </box>
    );
}
