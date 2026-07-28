import { createMemo, Show, type Accessor } from "solid-js";

import { GLYPHS, space, MARKERS } from "../../lib/design_system.ts";
import type { ThemeColors } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/** How a run card resolves against the ledger right now. */
export type RunCardState =
    /** No run row could be found for this card's id — the ledger was pruned, or the DB was replaced. */
    | { kind: "unavailable" }
    /** The run is still going: live counts drive the meter. */
    | { kind: "live"; done: number; total: number }
    /**
     * The run reached a terminal status: the meter is gone and this is the record.
     *
     * `done`/`total` are OPTIONAL because a terminal run has left the live progress snapshot, taking
     * its step counts with it — and a reloaded transcript never had them. Omitted rather than
     * defaulted: `0/0 steps` on a run that completed successfully is a false claim, and fetching a
     * step ledger per card would be a query per line of scroll-back.
     */
    | { kind: "settled"; status: string; done?: number; total?: number; durationMs: number | null; error: string | null };

/** Props for {@link RunCardBlock}. */
export type RunCardBlockProps = {
    /** The launched run's id — shown under the title, and the key its live state is resolved by. */
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
 * that disappeared would erase the launch from a reloaded transcript entirely. It has three shapes:
 *
 *  - **live** — a progress meter with `done/total`, updating as the run advances.
 *  - **settled** — the meter is GONE, replaced by a compact outcome line (status, counts, duration,
 *    and the reason when it did not succeed). A progress bar frozen mid-run is a false claim in
 *    scroll-back: it reads as work still in flight forever.
 *  - **unavailable** — the identity it recorded, and an honest note that the run could not be
 *    resolved. Never a fabricated status.
 */
export function RunCardBlock(props: RunCardBlockProps) {
    const heading = (): string => props.title || props.runId;
    // The launch-time step count, or the live one once resolved — the ledger knows better than the
    // card's recorded number, which was written before any step existed.
    const total = createMemo((): number => {
        const s = props.state;
        const live = s && s.kind !== "unavailable" ? s.total : undefined;
        return live !== undefined && live > 0 ? live : props.stepCount;
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

            <Show when={props.state?.kind === "live" ? props.state : undefined}>
                {(live: Accessor<Extract<RunCardState, { kind: "live" }>>) => (
                    <text paddingLeft={space.md}>
                        <Fg role="success">{GLYPHS.bar.repeat(live().done)}</Fg>
                        <Fg role="fgSubtle">{GLYPHS.bar.repeat(Math.max(0, live().total - live().done))}</Fg>
                        <Fg role="fgMuted">{`  ${live().done}/${live().total}`}</Fg>
                    </text>
                )}
            </Show>

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
