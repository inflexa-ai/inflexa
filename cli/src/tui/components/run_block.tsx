import { For } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, space, MARKERS } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** A run step's display shape (domain-agnostic; the mock model + the harness step ledger map onto this). */
export type RunStepView = {
    /** Human label shown in the step list. */
    label: string;
    /** Lifecycle state, selecting the step glyph + color. */
    state: "done" | "running" | "failed" | "queued";
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
     * Cap on how many step rows to render at once. When the run has MORE steps than this, the list
     * shows a WINDOW of `maxSteps` rows centered on the frontier of work (the first step that is not
     * yet done), clamped to the list ends. The progress bar and `done/total` always reflect the FULL
     * run — only the step list is windowed. Absent → the whole list renders (the runs dialog keeps its
     * complete view). Exists because the chat's sticky progress row sits in a fixed slice of the chat
     * column: a long run must not grow the row without bound, and the window keeps it anchored to where
     * work actually is.
     */
    maxSteps?: number;
};

/**
 * Cell budget for the progress meter in the narrow (windowed) mount. The default meter is one cell per
 * step, which soft-wraps the ~40-column sticky slice once a run passes ~30 steps; when `maxSteps`
 * signals that narrow mount the meter is scaled to at most this many cells instead. ~20 keeps it
 * comfortably inside the rail while still reading as a proportional bar.
 */
const BAR_BUDGET = 20;

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
    // The meter's cell counts. Without `maxSteps` it stays one cell per step — the dialog + gallery full
    // view, where the block owns its whole width. With `maxSteps` (the narrow sticky mount, where a
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
    // The visible slice of the step list. Full list unless `maxSteps` caps it; then a window of that
    // many rows centered on the frontier — the first not-yet-done step — clamped so it never runs past
    // either end. When every step is done the frontier is the tail, so the window shows the run's end.
    const windowedSteps = (): RunStepView[] => {
        const all = props.steps;
        const max = props.maxSteps;
        if (max === undefined || all.length <= max) return all;
        const frontier = all.findIndex((s) => s.state !== "done");
        const pivot = frontier === -1 ? all.length - 1 : frontier;
        const start = Math.max(0, Math.min(pivot - Math.floor(max / 2), all.length - max));
        return all.slice(start, start + max);
    };
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
                <For each={windowedSteps()}>
                    {(step) => {
                        const m = stepMark(step.state);
                        return (
                            <text>
                                <Fg role={m.role}>{`${m.glyph} `}</Fg>
                                <Fg role={step.state === "queued" ? "fgMuted" : "fg"}>{step.label}</Fg>
                            </text>
                        );
                    }}
                </For>
            </box>
            {(props.hint ?? true) ? <text fg={theme().fgMuted}>esc detach {GLYPHS.middot} ctrl+c abort</text> : null}
        </box>
    );
}
