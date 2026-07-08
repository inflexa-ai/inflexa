import { GLYPHS, space, MARKERS } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** Props for {@link RunCardBlock}. */
export type RunCardBlockProps = {
    /** The launched run's id — shown under the title. */
    runId: string;
    /** Run title; falls back to the id when the harness card carries none. */
    title: string;
    /** How many steps the launched plan holds (the harness run card carries no live status). */
    stepCount: number;
};

/**
 * The run-card block: the `●` run marker with the run title and step count, and the run id on a
 * second line. It renders the exact fields the harness run-card contract carries — there is no
 * run-status field, so this shows identity + step count only (not a live progress meter, which
 * {@link RunBlock} renders for the mock long-running run). Primitive fields only, extracted at
 * receipt via `readRunCard`.
 */
export function RunCardBlock(props: RunCardBlockProps) {
    const heading = (): string => props.title || props.runId;
    const steps = (): string => `${props.stepCount} step${props.stepCount === 1 ? "" : "s"}`;
    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role={MARKERS.run.role}>{`${MARKERS.run.glyph} `}</Fg>
                <Fg role="fg">{heading()}</Fg>
                <Fg role="fgSubtle">{` ${GLYPHS.middot} ${steps()}`}</Fg>
            </text>
            <text paddingLeft={space.md}>
                <Fg role="fgSubtle">{props.runId}</Fg>
            </text>
        </box>
    );
}
