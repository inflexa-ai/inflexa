import { createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

import { GLYPHS } from "../../lib/design_system.ts";
import { runEvery } from "../../lib/timer.ts";

/**
 * The frame-and-age clock the two indicators share: a braille frame that advances on one 80 ms
 * interval, and the elapsed age of the mount. The caller mounts the indicator for its busy window
 * only, so the interval lives exactly as long as the spin and `onCleanup` clears it when the window
 * settles. Each indicator keeps its own layout and tone.
 */
export function useSpinnerClock(): { readonly frame: Accessor<number>; readonly age: Accessor<string> } {
    const [frame, setFrame] = createSignal(0);
    const [age, setAge] = createSignal("0s");
    // Captured at mount: the caller mounts the indicator when its busy window opens and unmounts it
    // when it settles, so the age reads from that window's start.
    const start = Date.now();
    onCleanup(
        runEvery(80, () => {
            setFrame((f) => (f + 1) % GLYPHS.spinner.length);
            setAge(Date.relativeAge(start));
        }),
    );
    return { frame, age };
}
