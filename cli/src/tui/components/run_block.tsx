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
    const filled = (): string => GLYPHS.bar.repeat(props.done);
    const empty = (): string => GLYPHS.bar.repeat(Math.max(0, props.total - props.done));
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
            <text>
                <Fg role={MARKERS.run.role}>{`${MARKERS.run.glyph} `}</Fg>
                <Fg role="fg">{props.name}</Fg> <Fg role="fgMuted">{props.tag}</Fg>
            </text>
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
