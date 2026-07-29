import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";

import { theme } from "../theme.ts";
import { GLYPHS, space, stroke } from "../../lib/design_system.ts";
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
 * How often the elapsed readouts recompute. One second is the finest unit `String.relativeAge`
 * prints (`31s`), so a coarser tick would visibly skip values and a finer one would spend renders
 * redrawing the same string.
 *
 * Exported so the test that proves elapsed advances waits out the REAL period rather than a copy of
 * it — a hand-held duplicate would silently stop covering this if the period were ever retuned.
 */
export const ELAPSED_TICK_MS = 1_000;

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

    // Elapsed is a CLOCK readout, not a data readout. Computed inline during render it would advance
    // only when the progress object's identity changed, which couples the clock to the feed: a
    // stalled feed would freeze every age at its last value, and the panel would then read as a run
    // that has stopped progressing rather than as a view that has stopped updating — two conditions
    // that call for opposite responses from the reader, so they must not look identical.
    //
    // The tick's VALUE is never rendered. Subscribing to it is the whole point: it re-runs `age`,
    // which reads the wall clock through `relativeAge`.
    const [tick, setTick] = createSignal(0);
    // PRESENCE, not the object: an effect tracking `props.progress` itself would tear down and re-arm
    // on every data refresh, resetting the tick's phase — and a feed refreshing faster than the tick
    // would leave the clock permanently un-fired, which is the exact failure this ticker exists to
    // rule out. A boolean memo dedupes referentially, so the effect re-runs only when a run appears
    // or leaves.
    const showing = createMemo((): boolean => props.progress !== undefined);
    // Armed only while a run is showing — with no run the panel renders no rows at all, so a live
    // timer would be pure background work. The effect's own cleanup disarms it on both transitions:
    // the run leaving, and the component being disposed.
    createEffect(() => {
        if (!showing()) return;
        const timer = setInterval(() => setTick((t) => t + 1), ELAPSED_TICK_MS);
        onCleanup(() => clearInterval(timer));
    });

    /** Relative age of an ISO instant, recomputed on every clock tick — `null` when absent or unparseable. */
    function age(iso: string | null | undefined): string | null {
        // Read for the SUBSCRIPTION, not the value: this is what enrolls each caller's JSX expression
        // in the ticker, so `relativeAge` is re-evaluated against a moved wall clock.
        tick();
        return iso?.relativeAge() ?? null;
    }

    return (
        <Show when={props.progress}>
            {(run: Accessor<ActiveRunProgress>) => (
                // Full-width, background-painted, non-shrinking. Both properties are load-bearing, not
                // stylistic: this row sits directly beneath the Chat stream's flexGrow scrollbox, which
                // renders one row taller than it contributes to the column, so a bare <text> would let
                // scrolled content show through the gaps between its glyphs (the documented bleed). And a
                // non-numeric width defaults to shrinking, which would collapse the panel below its own
                // height on a short terminal — the stream must yield the squeeze instead. The rule row
                // inherits that protection: opentui draws the border, the title and the fill in one
                // `drawBox`, so the frame is part of the same opaque rect rather than glyphs over
                // transparency.
                //
                // `bgRaised` is the surface every docked element already paints — the status bar, the
                // sidebar, the ask prompt, dialog panels. This panel was the only docked surface on `bg`,
                // the transcript's own fill, which is precisely why it read as one more message that had
                // stopped scrolling. The tint alone cannot carry that distinction (it separates from `bg`
                // by as little as 1.06:1 on the lightest theme), so the labelled rule is the load-bearing
                // cue and the surface supports it.
                //
                // The rule is TOP-ONLY: the input's own top border already supplies this panel's bottom
                // edge one row below, and drawing a second would put two parallel hairlines around an
                // empty row — structure the eye reads as a rendering artifact. `border` must stay
                // explicit for that: opentui promotes a box carrying `borderStyle`/`borderColor` and no
                // `border` to a full four-sided frame, so dropping this one prop does not remove the
                // frame, it silently produces the card shape the design rejected.
                //
                // The frame colour is CONSTANT across every run state, including degraded. The input's
                // border colour is its focus/mode signal, so a state-coloured frame directly above it
                // would read as a second focus ring and make the real one ambiguous. Run state lives in
                // the header glyph's role and in the words.
                <box
                    width="100%"
                    flexShrink={0}
                    flexDirection="column"
                    backgroundColor={theme().bgRaised}
                    border={["top"]}
                    borderStyle={stroke.panel}
                    borderColor={theme().border}
                    title=" RUN "
                    titleColor={theme().fgMuted}
                    paddingLeft={space.sm}
                    paddingRight={space.sm}
                >
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
                            <Fg role="fgMuted">{`  ${GLYPHS.middot} ${age(run().startedAt) ?? GLYPHS.emDash}`}</Fg>
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
                                <Show when={age(step.startedAt)}>{(stepAge: Accessor<string>) => <Fg role="fgMuted">{`  ${stepAge()}`}</Fg>}</Show>
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

                    {/* `fgMuted`, not `fgSubtle`: a key hint is information-bearing text and holds the
                        4.5:1 floor. `fgSubtle` is the decorative tier (3:1) — it measures 3.36:1 on
                        github-light, which the contrast sweep correctly rejects for a line the reader
                        is meant to act on. */}
                    <text>
                        <Fg role="fgMuted">
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
