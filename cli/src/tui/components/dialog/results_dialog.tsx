import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { GLYPHS } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel } from "../../keymap.ts";
import { useDialogBindings, useDialogCancel, useDialogEntry } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { ScrollPane, SCROLL_HINT } from "../scroll_pane.tsx";

/** A read-only, scrollable list of lines with an empty-state message. Esc (host) / q / Enter close. */
export function ResultsDialog(props: { title: string; lines: string[]; emptyText: string; onClose: () => void }): JSX.Element {
    const dialog = useDialogEntry();

    useDialogCancel(() => props.onClose());

    // Scroll keys come from ScrollPane's focus-target layer; focus itself is host-applied (the
    // pane must be the focused renderable for those keys to gate on). `q` is a bare printable but
    // compliant: no text input can coexist with it in this dialog.
    useDialogBindings(() => ({
        bindings: [
            { chord: KEYS.q, run: () => props.onClose() },
            { chord: KEYS.enter, run: () => props.onClose() },
        ],
    }));

    return (
        <DialogPanel title={props.title} size="lg" footer={`${SCROLL_HINT} ${GLYPHS.middot} ${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`}>
            <ScrollPane focusOnMount={false} onRef={(r: ScrollBoxRenderable) => dialog?.setInitialFocus(r)} flexGrow={1} width="100%" paddingTop={1}>
                <Show when={props.lines.length > 0} fallback={<text fg={theme().fgMuted}>{props.emptyText}</text>}>
                    <For each={props.lines}>{(line) => <text fg={theme().fg}>{line}</text>}</For>
                </Show>
            </ScrollPane>
        </DialogPanel>
    );
}
