import { Show } from "solid-js";
import type { JSX } from "solid-js";

import { theme } from "../theme.ts";
import { RunBlock } from "../components/run_block.tsx";
import { activeRunProgress, type ActiveRunProgress } from "../hooks/sidebar_live.ts";

/**
 * The chat column's sticky run-progress row, pinned between the message stream and the input bar.
 * While the open analysis's NEWEST run is non-terminal, {@link activeRunProgress} carries its live
 * progress (published by the sidebar-live refresh loop) and this row renders the run-block vocabulary
 * — the segmented bar, `done/total`, and a bounded step window — so the user tracks the run without
 * opening the runs dialog. When nothing is active the signal is `null` and the row renders nothing
 * (no extra query fires, no row appears); it disappears the moment the run reaches a terminal status.
 *
 * It sits DIRECTLY below the chat stream's `flexGrow` scrollbox, so — exactly like the boot indicator
 * and the dialog footer (see cli/CLAUDE.md "Layout") — it MUST be a full-width box painted with the
 * panel background and `flexShrink={0}`: a bare/transparent row lets the scrollbox's documented 1-cell
 * bleed paint scroll content through it, and the short-terminal squeeze would drop its rows. The
 * opaque painted box reclaims its whole width and keeps its rows; the stream yields the squeeze
 * instead. `maxSteps={6}` bounds the step list so a long run cannot grow the row without limit, and
 * `hint={false}` drops the detach/abort footer — those keys are the chat's to own here, not the row's.
 */
export function RunProgressRow(): JSX.Element {
    return (
        <Show when={activeRunProgress()} keyed>
            {(progress: ActiveRunProgress) => (
                <box width="100%" flexShrink={0} backgroundColor={theme().bg} paddingLeft={1} paddingRight={1}>
                    <RunBlock
                        name={progress.name}
                        tag={progress.tag}
                        done={progress.done}
                        total={progress.total}
                        steps={progress.steps}
                        maxSteps={6}
                        hint={false}
                    />
                </box>
            )}
        </Show>
    );
}
