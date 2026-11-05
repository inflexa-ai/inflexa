import type { Renderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import type { JSX } from "solid-js";

import { KEYS, MODE_BASE, useBindings, type Chord } from "../tui/keymap.ts";

/**
 * The INSERT↔NORMAL companion wiring of app.tsx's chat: esc (textarea-targeted) FOCUSES the pane —
 * never a bare blur — and the pane-targeted companion layer returns to the input. The keymap render
 * harnesses register it because the focus-gating contract under test (keys live iff the pane is
 * focused) needs both destinations to exist with production's own chords.
 */
export function usePaneFocusCompanions(pane: () => ScrollBoxRenderable | null, composer: () => TextareaRenderable | null): void {
    useBindings(() => ({
        mode: MODE_BASE,
        target: composer(),
        bindings: [{ chord: KEYS.escape, run: () => pane()?.focus() }],
    }));
    useBindings(() => ({
        mode: MODE_BASE,
        target: pane(),
        bindings: [{ chord: { key: "i" }, run: () => composer()?.focus() }],
    }));
}

/**
 * A minimal lower-priority observer for the chords the layer under test may DECLINE: each binding
 * records that the key reached it instead. `preventDefault: false` so the key ALSO reaches the
 * textarea's own caret handling — the observers watch the fall-through without suppressing what
 * falls through, which is what lets a case assert real caret movement rather than only the absence
 * of a claimed step.
 */
export function useFallThroughProbe(target: () => Renderable | null, probes: { chord: Chord; run: () => void }[]): void {
    useBindings(() => ({
        mode: MODE_BASE,
        target: target(),
        priority: -10,
        bindings: probes.map(({ chord, run }) => ({ chord, run, preventDefault: false })),
    }));
}

/**
 * A textarea that grabs focus one microtask after its ref lands, and reports the renderable. This is
 * the INSERT-mode baseline of the keymap harnesses: production mounts the composer focused, so a
 * chord's meaning depends on that focus being real, not asserted.
 */
export function FocusedComposer(props: { onRef: (ta: TextareaRenderable) => void }): JSX.Element {
    return (
        <textarea
            ref={(r: TextareaRenderable) => {
                queueMicrotask(() => r.focus());
                props.onRef(r);
            }}
        />
    );
}
