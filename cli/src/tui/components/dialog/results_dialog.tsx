import { For, Show } from "solid-js";
import type { JSX } from "solid-js";

import { GLYPHS } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { useBindings, KEYS, chordLabel } from "../../keymap.ts";
import { DialogPanel } from "./dialog_panel.tsx";
import { ScrollPane, SCROLL_HINT } from "../scroll_pane.tsx";

/** A read-only, scrollable list of lines with an empty-state message. Esc/q/Enter close. */
export function ResultsDialog(props: { title: string; lines: string[]; emptyText: string; onClose: () => void }): JSX.Element {
    // Scroll keys (and focus-on-mount) come from ScrollPane; only the close keys are bound here.
    useBindings(() => ({
        bindings: [
            { chord: KEYS.escape, run: () => props.onClose() },
            { chord: KEYS.q, run: () => props.onClose() },
            { chord: KEYS.enter, run: () => props.onClose() },
        ],
    }));
    return (
        <DialogPanel title={props.title} size="lg" footer={`${SCROLL_HINT} ${GLYPHS.middot} ${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`}>
            <ScrollPane flexGrow={1} width="100%" paddingTop={1}>
                <Show when={props.lines.length > 0} fallback={<text fg={theme().fgMuted}>{props.emptyText}</text>}>
                    <For each={props.lines}>{(line) => <text fg={theme().fg}>{line}</text>}</For>
                </Show>
            </ScrollPane>
        </DialogPanel>
    );
}
