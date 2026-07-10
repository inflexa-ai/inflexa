import { createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";

import { GLYPHS, MARKERS, space } from "../../lib/design_system.ts";
import { Fg } from "./emphasis.tsx";

/**
 * The live "thinking" indicator: a braille spinner in the thinking-marker color plus a live elapsed
 * readout, shown while the assistant is busy. Mirrors `ThinkingBlock`'s `◆ thinking` styling, but
 * the marker SPINS on its own interval so a slow turn reads as actively working, not frozen.
 *
 * Purely presentational and self-animating — the caller gates mounting (e.g. `<Show when={busy}>`),
 * and because the component mounts only for that window, the interval lives exactly as long as the
 * spin and `onCleanup` clears it when the turn ends. No props: the elapsed clock starts at mount.
 */
export function ThinkingIndicator(): JSX.Element {
    const [frame, setFrame] = createSignal(0);
    const [age, setAge] = createSignal("0s");
    // Captured at mount: callers mount this when the turn goes busy, unmount it when it settles.
    const start = Date.now();
    const timer = setInterval(() => {
        setFrame((f) => (f + 1) % GLYPHS.spinner.length);
        setAge(Date.relativeAge(start));
    }, 80);
    onCleanup(() => clearInterval(timer));
    return (
        <box flexDirection="row" paddingBottom={space.sm}>
            <text>
                {/* frame() is always in-bounds (% length); the marker glyph is a dead-safe fallback for the optional index. */}
                <Fg role={MARKERS.thinking.role}>{`${GLYPHS.spinner[frame()] ?? MARKERS.thinking.glyph} thinking`}</Fg>
                <Fg role="fgMuted">{` ${GLYPHS.middot} ${age()}`}</Fg>
            </text>
        </box>
    );
}
