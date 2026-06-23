import { For } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, space, MARKERS } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** A run step's display shape (domain-agnostic; the mock model maps onto this). */
export type RunStepView = {
    /** Human label shown in the step list. */
    label: string;
    /** Lifecycle state, selecting the step glyph + color. */
    state: "done" | "running" | "queued";
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
};

/** The themed glyph + color role for a step's state. */
function stepMark(state: RunStepView["state"]): { glyph: string; role: "success" | "warning" | "fgSubtle" } {
    if (state === "done") return { glyph: GLYPHS.check, role: "success" };
    if (state === "running") return { glyph: GLYPHS.triangleRight, role: "warning" };
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
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role={MARKERS.run.role}>{`${MARKERS.run.glyph} `}</Fg>
                <Fg role="fg">{props.name}</Fg> <Fg role="fgSubtle">{props.tag}</Fg>
            </text>
            <text paddingLeft={space.md}>
                <Fg role="success">{filled()}</Fg>
                <Fg role="fgSubtle">{empty()}</Fg> <Fg role="fgMuted">{`${props.done}/${props.total}`}</Fg>
            </text>
            <box paddingLeft={space.md} flexDirection="column" border={["left"]} borderColor={theme().border}>
                <For each={props.steps}>
                    {(step) => {
                        const m = stepMark(step.state);
                        return (
                            <text>
                                <Fg role={m.role}>{`${m.glyph} `}</Fg>
                                <Fg role={step.state === "queued" ? "fgSubtle" : "fg"}>{step.label}</Fg>
                            </text>
                        );
                    }}
                </For>
            </box>
            <text fg={theme().fgSubtle}>esc detach {GLYPHS.middot} ctrl+c abort</text>
        </box>
    );
}
