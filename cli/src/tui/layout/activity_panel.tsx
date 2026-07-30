import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import { LayoutEvents, type BoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";

import { theme } from "../theme.ts";
import { GLYPHS, space, stroke } from "../../lib/design_system.ts";
import { Fg } from "../components/emphasis.tsx";
import type { ActiveProfileProgress, ActiveRunProgress, PanelSubject } from "../hooks/sidebar_live.ts";
import type { RunStepView } from "../components/run_block.tsx";

// The activity panel: the chat column's live readout for ONE focused subject — an analysis run, or
// the analysis's data profile. Both are work a user waits on, and each renders only what is true of it:
// a run has a frontier and a denominator, a profile has neither.
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

/** Props for {@link ActivityPanel}. */
export type ActivityPanelProps = {
    /** The focused subject, or `undefined` when there is nothing active to show. */
    subject: PanelSubject | undefined;
    /**
     * A human phrase for what the focused subject's agent is doing (`tool bash`, `model round 3`,
     * `sandbox executing`). Absent when it cannot be resolved — the panel then renders the rest of
     * the subject rather than substituting a placeholder.
     */
    activity?: string | null;
    /** How many subjects are active in total — the denominator of the position indicator. */
    activeCount: number;
    /** The focused subject's 1-based position within the active set. */
    position: number;
    /** Label for the chord that advances to the next active subject, derived from the binding (never hand-written). */
    nextKeyLabel: string;
    /** Label for the chord that dismisses the panel. */
    dismissKeyLabel: string;
    /** Advance to the next active subject. */
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
 * Columns a border title costs beyond its own text: two rule glyphs on each side, which opentui
 * always draws around the label.
 *
 * A title is rendered only when the box is at least this much wider than the string, and when it is
 * not, opentui **drops the title silently** rather than truncating it — so an over-long legend does
 * not lose its tail, it loses the region's name as well and leaves an unlabelled rule. Measured
 * exactly, at six title lengths from 5 to 37 columns, each first appearing at `length + 4`.
 */
const TITLE_RULE_COST = 4;

/**
 * The legend's region name for each subject kind, so the frame states which kind of work is on screen.
 * A total map rather than a ternary at the call site: a third subject kind then fails to compile here
 * instead of silently inheriting a run's legend.
 */
const REGION_NAME: Record<PanelSubject["kind"], string> = { run: "RUN", profile: "PROFILE" };

/**
 * The legend a panel of `width` columns should carry: the widest of a fixed ladder that opentui will
 * actually render, falling back to `region` alone.
 *
 * The legend is the region's own line — what this region is, which of the active subjects it is
 * showing, and the chords that act on the region itself. None of those is a fact about the subject,
 * which is why they live on the frame and not on a row describing the subject.
 *
 * The ladder exists because the alternative to degrading is disappearing (see {@link
 * TITLE_RULE_COST}). Its order is deliberate: the chords are shed first, because a hint the reader
 * has no room to read is worth less than knowing which subject they are looking at. Below roughly nine
 * columns even the bare name is dropped by opentui — a panel that narrow cannot render its content
 * either, so it is not defended against here.
 *
 * `region` is a parameter rather than the constant it once was because the panel now shows two kinds of
 * work, and this function's whole output for a focused profile is a legend reading `PROFILE` — a name
 * asserting it fits a *run* legend would be false at the call site, and nothing type-checks a name.
 * Every rung is measured against the region it was given, so a longer name simply degrades sooner:
 * `PROFILE` is four columns longer than `RUN`, which makes its boundary widths different numbers, not
 * derivable from the run's.
 */
export function fitPanelLegend(opts: {
    readonly width: number;
    readonly region: string;
    readonly position: number;
    readonly activeCount: number;
    readonly nextKeyLabel: string;
    readonly dismissKeyLabel: string;
}): string {
    const multi = opts.activeCount > 1;
    const named = multi ? `${opts.region} ${opts.position}/${opts.activeCount}` : opts.region;
    const chords = multi ? `${opts.nextKeyLabel} next ${GLYPHS.middot} ${opts.dismissKeyLabel} hide` : `${opts.dismissKeyLabel} hide`;
    const bare = ` ${opts.region} `;
    // Every rung is padded so the label breathes inside the rule rather than butting against its
    // glyphs. The last is the floor: the region's name is the one part never shed, because a rule
    // carrying no name at all is the failure the ladder exists to prevent.
    const ladder = [` ${named} ${GLYPHS.middot} ${chords} `, ` ${named} `, bare];
    return ladder.find((c) => opts.width >= c.length + TITLE_RULE_COST) ?? bare;
}

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
 * The name a profile subject renders under.
 *
 * A literal here rather than a field on the subject: there is one data profile per analysis and it is
 * always the same operation, so routing this string through the store would dress a constant up as
 * data the ledger supplies — and the subject is deliberately kept to facts the ledger has. It matches
 * the sidebar's `DATA PROFILE` section label so the rail and the panel name the same work identically.
 *
 * Rejected: the analysis name (already on the status bar, so it would repeat rather than identify) and
 * a file count (the profile reports no per-file figure while it runs, and a profile carries no counts
 * here at all).
 */
const PROFILE_NAME = "Data profile";

/**
 * The chat column's live subject readout. Renders nothing (no rows at all) when no subject is focused,
 * so an idle chat composes exactly as it did before the panel existed.
 */
export function ActivityPanel(props: ActivityPanelProps) {
    // Narrowed once each, so every arm's JSX reads its own kind's fields without re-testing the tag.
    const run = createMemo((): ActiveRunProgress | null => (props.subject?.kind === "run" ? props.subject.run : null));
    const profile = createMemo((): ActiveProfileProgress | null => (props.subject?.kind === "profile" ? props.subject.profile : null));
    // Empty for a profile by construction, not by a case handled here: the union gives a profile no
    // steps at all, so "a profile shows no frontier rows" is a property the compiler holds.
    const frontier = createMemo((): RunStepView[] => {
        const r = run();
        return r ? frontierOf(r.steps) : [];
    });
    // A subject whose own read failed this refresh shows its LAST KNOWN state, muted and marked.
    // Removing the panel instead would be indistinguishable from the work having finished — the one
    // reading a blip must never produce.
    const stale = createMemo((): boolean => {
        const s = props.subject;
        if (!s) return false;
        return s.kind === "run" ? s.run.stale : s.profile.stale;
    });

    // Elapsed is a CLOCK readout, not a data readout. Computed inline during render it would advance
    // only when the subject object's identity changed, which couples the clock to the feed: a
    // stalled feed would freeze every age at its last value, and the panel would then read as work
    // that has stopped progressing rather than as a view that has stopped updating — two conditions
    // that call for opposite responses from the reader, so they must not look identical.
    //
    // The tick's VALUE is never rendered. Subscribing to it is the whole point: it re-runs `age`,
    // which reads the wall clock through `relativeAge`.
    const [tick, setTick] = createSignal(0);
    // PRESENCE, not the object: an effect tracking `props.subject` itself would tear down and re-arm
    // on every data refresh, resetting the tick's phase — and a feed refreshing faster than the tick
    // would leave the clock permanently un-fired, which is the exact failure this ticker exists to
    // rule out. A boolean memo dedupes referentially, so the effect re-runs only when a subject
    // appears or leaves.
    const showing = createMemo((): boolean => props.subject !== undefined);

    // The panel's OWN width, which is what the legend has to fit — NOT the terminal's. An open sidebar
    // makes the two differ by the rail's width, and that gap is precisely the dangerous case: a
    // 40-column pane with the rail shown leaves the panel too narrow for the full legend while the
    // terminal still looks roomy, and a legend that does not fit is dropped rather than truncated.
    //
    // Zero until the first layout lands, which the ladder reads as "narrowest" — so the first frame
    // carries the bare region name rather than an unlabelled rule.
    const [panelWidth, setPanelWidth] = createSignal(0);
    // Re-measured after every layout pass, which is the only timing that holds. A renderable's width
    // is 0 until layout computes it, and layout runs inside the render loop — so the ref callback, a
    // microtask queued from it, and even a macrotask all read 0 when the panel mounts from a data
    // update rather than at startup (measured: the deferred read fired before the first layout of a
    // panel appearing mid-session). The box's own `resized` event is no help either — it fires from
    // `resize()`, which flex-driven sizing never calls.
    //
    // The root emits `layout-changed` from `calculateLayout`, so subscribing there gives a width that
    // is correct on the first painted frame and stays correct through resizes and sidebar toggles.
    const renderer = useRenderer();
    let panelRef: BoxRenderable | null = null;
    const measure = (r: BoxRenderable): void => {
        panelRef = r;
    };
    const onLayout = (): void => {
        if (panelRef) setPanelWidth(panelRef.width);
    };
    renderer.root.on(LayoutEvents.LAYOUT_CHANGED, onLayout);
    onCleanup(() => renderer.root.off(LayoutEvents.LAYOUT_CHANGED, onLayout));

    // Armed only while a subject is showing — with none the panel renders no rows at all, so a live
    // timer would be pure background work. The effect's own cleanup disarms it on both transitions:
    // the subject leaving, and the component being disposed.
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

    const legend = createMemo((): string =>
        fitPanelLegend({
            width: panelWidth(),
            // The frame names the kind of work on screen, so it comes from the focused subject. The
            // fallback is unreachable on screen — the box carrying the title only renders under a
            // subject — but this memo is eager, so it needs a value before the first one arrives.
            region: REGION_NAME[props.subject?.kind ?? "run"],
            position: props.position,
            activeCount: props.activeCount,
            nextKeyLabel: props.nextKeyLabel,
            dismissKeyLabel: props.dismissKeyLabel,
        }),
    );

    return (
        <Show when={props.subject}>
            {() => (
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
                // The frame colour is CONSTANT across every subject state, including degraded. The input's
                // border colour is its focus/mode signal, so a state-coloured frame directly above it
                // would read as a second focus ring and make the real one ambiguous. Subject state lives
                // in the header glyph's role and in the words.
                <box
                    ref={measure}
                    width="100%"
                    flexShrink={0}
                    flexDirection="column"
                    backgroundColor={theme().bgRaised}
                    border={["top"]}
                    borderStyle={stroke.panel}
                    borderColor={theme().border}
                    title={legend()}
                    titleColor={theme().fgMuted}
                    paddingLeft={space.sm}
                    paddingRight={space.sm}
                >
                    {/* The header row is the panel's CLICK TARGET for navigation, and only it — a click
                        anywhere on the panel would hijack the drag that starts a text selection over the
                        frontier lines. The row carries no navigation label: the position and the chords
                        are the region's, so they ride the legend, and the border is drawn by the box
                        rather than being a child that could carry a handler. The click therefore stays
                        here because it is the only safe target, not because it is co-located with its
                        indicator. Inert with a single active subject. */}
                    <box width="100%" onMouseDown={() => props.activeCount > 1 && props.onNext()}>
                        <Show when={run()}>
                            {(r: Accessor<ActiveRunProgress>) => (
                                <text>
                                    <Fg role={stale() ? "fgMuted" : "warning"}>{`${GLYPHS.circleHalf} `}</Fg>
                                    <Fg role={stale() ? "fgMuted" : "fg"}>{r().name}</Fg>
                                    {/* Bare counts, deliberately — the rail renders the same figure as a meter, and
                                        two meters would read as two widgets showing one run. */}
                                    <Fg role="fgMuted">{`  ${r().done}/${r().total}`}</Fg>
                                    <Fg role="fgMuted">{`  ${GLYPHS.middot} ${age(r().startedAt) ?? GLYPHS.emDash}`}</Fg>
                                    <Show when={stale()}>
                                        <Fg role="fgMuted">{`  ${GLYPHS.middot} unavailable`}</Fg>
                                    </Show>
                                </text>
                            )}
                        </Show>

                        {/* The profile's header is the run's minus everything a profile does not have: no
                            count, because a profile is a single agent loop with no step decomposition and
                            therefore no denominator. A synthesized `total: 1` was rejected — it would put a
                            completion meter on screen for work that has no steps to complete, and the
                            panel's whole credibility is that its numbers are the ledger's, which makes an
                            invented denominator worse than none.

                            The marker is the pair the rail's running-profile line uses, not the run's own:
                            one piece of work should look like itself across both surfaces that show it, and
                            borrowing the run's marker would make a profile read as a run in the one place
                            the two sit side by side in a single navigable set. Staleness mutes it exactly as
                            it mutes a run's. */}
                        <Show when={profile()}>
                            {(p: Accessor<ActiveProfileProgress>) => (
                                <text>
                                    <Fg role={stale() ? "fgMuted" : "warning"}>{`${GLYPHS.warning} `}</Fg>
                                    <Fg role={stale() ? "fgMuted" : "fg"}>{PROFILE_NAME}</Fg>
                                    <Fg role="fgMuted">{`  ${GLYPHS.middot} ${age(p().startedAt) ?? GLYPHS.emDash}`}</Fg>
                                    <Show when={stale()}>
                                        <Fg role="fgMuted">{`  ${GLYPHS.middot} unavailable`}</Fg>
                                    </Show>
                                </text>
                            )}
                        </Show>
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
                        reader does not have.

                        One row for either kind of subject: it is the same fact — what the focused
                        subject's agent is doing — reported through the same stream, so a per-kind copy
                        would be two renderings of one line drifting apart. */}
                    <Show when={props.activity}>
                        {(a: Accessor<string>) => (
                            <text>
                                <Fg role="fgMuted">{`    ${a()}`}</Fg>
                            </text>
                        )}
                    </Show>
                </box>
            )}
        </Show>
    );
}
