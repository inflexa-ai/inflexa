import { createMemo, Show, type Accessor } from "solid-js";

import { GLYPHS, space, MARKERS } from "../../lib/design_system.ts";
import type { ThemeColors } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/**
 * How a run card resolves against the ledger right now.
 *
 * There is no `live` kind, and that is the point: a running run resolves to no state at all, so the
 * card shows its launch record until the run settles (see {@link RunCardBlock}).
 */
export type RunCardState =
    /** No run row could be found for this card's id — the ledger was pruned, or the DB was replaced. */
    | { kind: "unavailable" }
    /**
     * The run reached a terminal status, and this is the record of how it ended.
     *
     * `done`/`total` are OPTIONAL because a terminal run has left the live progress snapshot, taking
     * its step counts with it — and a reloaded transcript never had them. Omitted rather than
     * defaulted: `0/0 steps` on a run that completed successfully is a false claim, and fetching a
     * step ledger per card would be a query per line of scroll-back.
     */
    | { kind: "settled"; status: string; done?: number; total?: number; durationMs: number | null; error: string | null };

/** Props for {@link RunCardBlock}. */
export type RunCardBlockProps = {
    /** The launched run's id — shown under the title, and the key its ledger state is resolved by. */
    runId: string;
    /** Run title; falls back to the id when the harness card carries none. */
    title: string;
    /** How many steps the launched plan holds, as recorded at launch. */
    stepCount: number;
    /**
     * The run's state as of now, resolved by `runId` against the live ledger.
     *
     * Absent means "not resolved" — a host that does not track runs (the design gallery, a
     * render test) gets the launch-record card the block has always rendered. It is NOT the same as
     * `unavailable`, which is a positive finding that the run could not be found.
     */
    state?: RunCardState;
};

/** The glyph and tone for a settled run's terminal status. */
function settledMark(status: string): { glyph: string; role: keyof ThemeColors } {
    switch (status) {
        case "completed":
            return { glyph: GLYPHS.check, role: "success" };
        case "failed":
        case "canceled":
            return { glyph: GLYPHS.cross, role: "error" };
        default:
            // `partial`, `suspended_insufficient_funds`, and anything the harness adds later: not a
            // success, not an error, and shown in the neutral warn tone rather than guessed at.
            return { glyph: GLYPHS.circle, role: "warning" };
    }
}

/**
 * The run-card block: the launch record, plus whatever the run has since become.
 *
 * A run card is the conversation's memory of a launch, so it is never hidden and never removed —
 * signalling completion by making a widget vanish is the defect this exists to remove, and a card
 * that disappeared would erase the launch from a reloaded transcript entirely.
 *
 * The card is a RECORD, not an instrument: it carries no live progress at any point in its life.
 * Live `done/total` belongs to the two surfaces that own live state — the sidebar RUNS rail (which
 * renders the meter) and the run-activity panel (whose counts are deliberately bare text, precisely
 * so two surfaces do not read as two widgets showing one run). A meter here would be the same figure
 * a third time, and would defeat that argument for the other two. So the card has two shapes beyond
 * the launch record it always renders:
 *
 *  - **settled** — a compact outcome line (status, counts, duration, and the reason when it did not
 *    succeed), which is what the reader of a scroll-back transcript came for.
 *  - **unavailable** — the identity it recorded, and an honest note that the run could not be
 *    resolved. Never a fabricated status.
 */
export function RunCardBlock(props: RunCardBlockProps) {
    const heading = (): string => props.title || props.runId;
    // The launch-time step count, or the settled one once resolved — the ledger knows better than the
    // card's recorded number, which was written before any step existed.
    const total = createMemo((): number => {
        const s = props.state;
        const resolved = s?.kind === "settled" ? s.total : undefined;
        return resolved !== undefined && resolved > 0 ? resolved : props.stepCount;
    });
    const steps = (): string => `${total()} step${total() === 1 ? "" : "s"}`;

    return (
        <box flexDirection="column" paddingBottom={space.sm}>
            <text>
                <Fg role={MARKERS.run.role}>{`${MARKERS.run.glyph} `}</Fg>
                <Fg role="fg">{heading()}</Fg>
                <Fg role="fgMuted">{` ${GLYPHS.middot} ${steps()}`}</Fg>
            </text>
            <text paddingLeft={space.md}>
                <Fg role="fgMuted">{props.runId}</Fg>
            </text>

            <Show when={props.state?.kind === "settled" ? props.state : undefined}>
                {(done: Accessor<Extract<RunCardState, { kind: "settled" }>>) => (
                    <box flexDirection="column" paddingLeft={space.md}>
                        <text>
                            <Fg role={settledMark(done().status).role}>{`${settledMark(done().status).glyph} `}</Fg>
                            <Fg role="fg">{done().status}</Fg>
                            <Show when={done().total !== undefined}>
                                <Fg role="fgMuted">{` ${GLYPHS.middot} ${done().done ?? 0}/${done().total} steps`}</Fg>
                            </Show>
                            <Show when={done().durationMs !== null}>
                                <Fg role="fgMuted">{` ${GLYPHS.middot} ${Date.formatDuration(done().durationMs ?? 0)}`}</Fg>
                            </Show>
                        </text>
                        {/* The reason is the whole value of a failed card in scroll-back — without it the
                            reader has to go looking for what a card already knows. */}
                        <Show when={done().error}>
                            {(reason: Accessor<string>) => (
                                <text>
                                    <Fg role="error">{reason()}</Fg>
                                </text>
                            )}
                        </Show>
                    </box>
                )}
            </Show>

            <Show when={props.state?.kind === "unavailable"}>
                <text paddingLeft={space.md}>
                    <Fg role="fgMuted">{`${GLYPHS.emDash} run unavailable`}</Fg>
                </text>
            </Show>
        </box>
    );
}
