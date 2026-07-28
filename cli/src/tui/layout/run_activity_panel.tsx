import { createMemo, For, Show, type Accessor } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, space } from "../../lib/design_system.ts";
import { Fg } from "../components/emphasis.tsx";
import type { ActiveRunProgress } from "../hooks/sidebar_live.ts";
import type { RunStepView } from "../components/run_block.tsx";

// The run-activity panel: the chat column's live frontier readout for ONE focused run.
//
// It is not a second step list. The sidebar RUNS section owns the list, and duplicating it would put
// the same widget on screen twice. What the rail physically cannot carry is why this exists: at
// `size.railWidth` (40) a step row is already `glyph + name + age`, and adding the owning agent and
// a live activity label runs past 60 characters — measured, the agent tag alone pushes the age and
// retry count off the row. Those live here, at chat width.
//
// Division of labour: the rail answers *what is the shape of the work*; the panel answers *what is
// happening right now*. The only overlap is the completion count, rendered as bare text here and as
// a meter there so the two never read as the same widget.

/** Props for {@link RunActivityPanel}. */
export type RunActivityPanelProps = {
    /** The focused run's progress, or `undefined` when there is nothing active to show. */
    progress: ActiveRunProgress | undefined;
    /**
     * A human phrase for what the run's newest durable step is doing (`tool bash`, `model round 3`,
     * `sandbox executing`). Absent when it cannot be resolved — the panel then renders the rest of
     * the frontier rather than substituting a placeholder.
     */
    activity?: string | null;
    /** How many runs are active in total — the denominator of the position indicator. */
    activeCount: number;
    /** The focused run's 1-based position within the active set. */
    position: number;
    /** Label for the chord that advances to the next active run, derived from the binding (never hand-written). */
    nextKeyLabel: string;
    /** Label for the chord that dismisses the panel. */
    dismissKeyLabel: string;
    /** Advance to the next active run. */
    onNext: () => void;
};

/**
 * The steps currently running — the run's frontier.
 *
 * All of them, not the first: a run with parallel steps genuinely has several frontiers, and
 * collapsing them to one would misreport which work is in flight.
 */
function frontierOf(steps: readonly RunStepView[]): RunStepView[] {
    return steps.filter((s) => s.state === "running");
}

/**
 * The chat column's live run frontier. Renders nothing (no rows at all) when `progress` is absent,
 * so an idle chat composes exactly as it did before the panel existed.
 */
export function RunActivityPanel(props: RunActivityPanelProps) {
    const frontier = createMemo((): RunStepView[] => (props.progress ? frontierOf(props.progress.steps) : []));
    // A run whose own step read failed this refresh shows its LAST KNOWN frontier, muted and marked.
    // Removing the panel instead would be indistinguishable from the run having finished — the one
    // reading a blip must never produce.
    const stale = createMemo((): boolean => props.progress?.stale === true);

    return (
        <Show when={props.progress}>
            {(run: Accessor<ActiveRunProgress>) => (
                // Full-width, background-painted, non-shrinking. Both properties are load-bearing, not
                // stylistic: this row sits directly beneath the Chat stream's flexGrow scrollbox, which
                // renders one row taller than it contributes to the column, so a bare <text> would let
                // scrolled content show through the gaps between its glyphs (the documented bleed). And a
                // non-numeric width defaults to shrinking, which would collapse the panel below its own
                // height on a short terminal — the stream must yield the squeeze instead.
                <box width="100%" flexShrink={0} flexDirection="column" backgroundColor={theme().bg} paddingLeft={space.sm} paddingRight={space.sm}>
                    {/* The header row is the panel's CLICK TARGET for navigation, and only it — a
                        click anywhere on the panel would hijack the drag that starts a text selection
                        over the frontier lines. It carries the position indicator, so the affordance
                        sits on the thing it acts upon. Inert with a single active run. */}
                    <box width="100%" onMouseDown={() => props.activeCount > 1 && props.onNext()}>
                        <text>
                            <Fg role={stale() ? "fgMuted" : "warning"}>{`${GLYPHS.circleHalf} `}</Fg>
                            <Fg role={stale() ? "fgMuted" : "fg"}>{run().name}</Fg>
                            {/* Bare counts, deliberately — the rail renders the same figure as a meter, and
                                two meters would read as two widgets showing one run. */}
                            <Fg role="fgMuted">{`  ${run().done}/${run().total}`}</Fg>
                            <Fg role="fgMuted">{`  ${GLYPHS.middot} ${run().startedAt.relativeAge() ?? GLYPHS.emDash}`}</Fg>
                            <Show when={props.activeCount > 1}>
                                <Fg role="fgMuted">{`  ${GLYPHS.middot} run ${props.position}/${props.activeCount}`}</Fg>
                            </Show>
                            <Show when={stale()}>
                                <Fg role="fgMuted">{`  ${GLYPHS.middot} unavailable`}</Fg>
                            </Show>
                        </text>
                    </box>

                    <For each={frontier()}>
                        {(step) => (
                            <text>
                                <Fg role="fgMuted">{`  ${GLYPHS.arrowRight} `}</Fg>
                                <Fg role={stale() ? "fgMuted" : "fg"}>{step.label}</Fg>
                                <Show when={step.agent}>{(a: Accessor<string>) => <Fg role="tool">{`  [${a()}]`}</Fg>}</Show>
                                <Show when={step.startedAt?.relativeAge()}>{(age: Accessor<string>) => <Fg role="fgMuted">{`  ${age()}`}</Fg>}</Show>
                            </text>
                        )}
                    </For>

                    {/* The activity label is the panel's whole reason for existing at this width. Omitted
                        rather than substituted when unresolvable — a placeholder would claim knowledge the
                        reader does not have. */}
                    <Show when={props.activity}>
                        {(a: Accessor<string>) => (
                            <text>
                                <Fg role="fgMuted">{`    ${a()}`}</Fg>
                            </text>
                        )}
                    </Show>

                    <text>
                        <Fg role="fgSubtle">
                            {props.activeCount > 1
                                ? `${props.nextKeyLabel} next run ${GLYPHS.middot} ${props.dismissKeyLabel} hide`
                                : `${props.dismissKeyLabel} hide`}
                        </Fg>
                    </text>
                </box>
            )}
        </Show>
    );
}
