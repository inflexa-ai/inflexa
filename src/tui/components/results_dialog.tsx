import { For, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { GLYPHS } from "../../lib/glyphs.ts";
import { theme } from "../theme.ts";
import { useBindings, KEYS, chordLabel } from "../keymap.ts";
import { DialogPanel } from "./dialog_panel.tsx";

/** A read-only, scrollable list of lines with an empty-state message. Esc/q/Enter close. */
export function ResultsDialog(props: { title: string; lines: string[]; emptyText: string; onClose: () => void }): JSX.Element {
    let scrollRef: ScrollBoxRenderable | null = null;
    onMount(() => queueMicrotask(() => scrollRef?.focus()));
    // up/down are deliberately unbound: leaving them unhandled lets the focused scrollbox scroll.
    useBindings(() => ({
        bindings: [
            { chord: KEYS.escape, run: () => props.onClose() },
            { chord: KEYS.q, run: () => props.onClose() },
            { chord: KEYS.enter, run: () => props.onClose() },
        ],
    }));
    return (
        <DialogPanel
            title={props.title}
            width="70%"
            height="60%"
            footer={`${chordLabel(KEYS.up)}/${chordLabel(KEYS.down)} scroll ${GLYPHS.middot} ${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`}
        >
            <scrollbox
                ref={(r: ScrollBoxRenderable) => {
                    scrollRef = r;
                }}
                focused
                flexGrow={1}
                width="100%"
                paddingTop={1}
            >
                <Show when={props.lines.length > 0} fallback={<text fg={theme().muted}>{props.emptyText}</text>}>
                    <For each={props.lines}>{(line) => <text fg={theme().fg}>{line}</text>}</For>
                </Show>
            </scrollbox>
        </DialogPanel>
    );
}
