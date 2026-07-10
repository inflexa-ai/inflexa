import { createSignal, onCleanup, For, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import { GLYPHS, MARKERS, space } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { Bold, Fg } from "./emphasis.tsx";

/** Props for {@link BootIndicator}. */
export type BootIndicatorProps = {
    /**
     * When set, render the TERMINAL failed state — the boot-error taxonomy's actionable message in
     * an error tone — instead of the live booting spinner. Omit (the booting case) to show the
     * animated braille spinner + elapsed readout. One component spans both states because the host
     * mounts it across the whole not-`ready` window (`booting → failed`), swapping only which branch
     * renders — never remounting.
     */
    message?: string;
};

/**
 * The embedded-runtime boot indicator, the boot analogue of {@link ThinkingIndicator}: while the
 * runtime boots it shows a braille spinner (spinning on its own interval so a slow boot reads as
 * actively working, not frozen) with a live elapsed readout and a short label; once boot FAILS it
 * shows the actionable boot-error message in an error tone as a terminal state — never a hang.
 *
 * Purely presentational and self-animating — the host gates mounting to the not-`ready` window and
 * supplies the failed `message` (a primitive, so this stays a pure `components/` widget with no
 * `hooks/`/`modules/` import). Both states enter the design gallery.
 */
export function BootIndicator(props: BootIndicatorProps): JSX.Element {
    const [frame, setFrame] = createSignal(0);
    const [age, setAge] = createSignal("0s");
    // Captured at mount: the host mounts this when boot begins, unmounts it when the runtime is ready
    // (or the user quits from the failed state).
    const start = Date.now();
    // The timer keeps ticking if the boot then FAILS (message set) — harmless: the failed branch
    // ignores frame()/age(), it is a terminal state the user quits from, and onCleanup clears the
    // interval on unmount. Kept identical to ThinkingIndicator rather than special-casing a stop.
    const timer = setInterval(() => {
        setFrame((f) => (f + 1) % GLYPHS.spinner.length);
        setAge(Date.relativeAge(start));
    }, 80);
    onCleanup(() => clearInterval(timer));
    return (
        <Show
            when={props.message}
            fallback={
                <box flexDirection="row" paddingBottom={space.sm}>
                    <text>
                        {/* frame() is always in-bounds (% length); circleHalf is a dead-safe fallback for the optional index. */}
                        <Fg role="accent">{`${GLYPHS.spinner[frame()] ?? GLYPHS.circleHalf} booting harness runtime`}</Fg>
                        <Fg role="fgMuted">{` ${GLYPHS.middot} ${age()}`}</Fg>
                    </text>
                </box>
            }
        >
            {(message: Accessor<string>) => (
                <box flexDirection="column" paddingBottom={space.sm}>
                    {/* describeBootError returns ONE actionable message that is sometimes multi-line
                        (a "what failed" line plus remedy lines); split so each row paints on its own
                        line rather than relying on text wrapping. First line carries the error marker
                        + tone; the remedy lines read as muted follow-on, mirroring ErrorBlock. */}
                    <For each={message().split("\n")}>
                        {(line, i) => (
                            <Show when={i() === 0} fallback={<text fg={theme().fgMuted}>{line}</text>}>
                                <text fg={theme()[MARKERS.error.role]}>
                                    <Bold>
                                        {MARKERS.error.glyph} {line}
                                    </Bold>
                                </text>
                            </Show>
                        )}
                    </For>
                </box>
            )}
        </Show>
    );
}
