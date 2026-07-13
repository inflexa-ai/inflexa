import { Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

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
    // NON-keyed Show with the accessor form. Each sidebar refresh mints a FRESH ActiveRunProgress object,
    // so `keyed` (which re-runs children on reference change) would tear down and rebuild the whole
    // RunBlock subtree on every ~5s poll tick. Non-keyed mounts once on the null→present edge and
    // unmounts on present→null; `progress` is Show's non-null-narrowed accessor, so reading through it
    // (`progress().name`, …) updates each RunBlock prop fine-grained in place — no `!`, no remount.
    return (
        <Show when={activeRunProgress()}>
            {/* `progress` is Show's non-null-narrowed accessor for the truthy branch (the opentui/solid
                JSX types don't infer it, so it is annotated); Show only runs this child while the signal
                is non-null, so `progress()` is always an `ActiveRunProgress`. */}
            {(progress: Accessor<ActiveRunProgress>) => (
                <box width="100%" flexShrink={0} backgroundColor={theme().bg} paddingLeft={1} paddingRight={1}>
                    <RunBlock
                        name={progress().name}
                        tag={progress().tag}
                        done={progress().done}
                        total={progress().total}
                        steps={progress().steps}
                        maxSteps={6}
                        hint={false}
                    />
                </box>
            )}
        </Show>
    );
}
