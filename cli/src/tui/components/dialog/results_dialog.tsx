import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { GLYPHS } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel, parseChord } from "../../keymap.ts";
import { useDialogBindings, useDialogCancel, useDialogEntry } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { ScrollPane, SCROLL_HINT } from "../scroll_pane.tsx";

/**
 * An optional single-key action offered in the {@link ResultsDialog} footer — the affordance a
 * point-in-time results view exposes (e.g. `r re-profile`). Rendered as a footer hint and bound via
 * `useDialogBindings`, both gated on `enabled`; a disabled action shows no hint and binds nothing.
 */
export type ResultsAction = {
    /** The single-key chord string (e.g. `"r"`), parsed to a chord — bare printables only, see below. */
    key: string;
    /** Footer hint label (e.g. `re-profile`). */
    label: string;
    /** Both the binding and the hint are live only when true. */
    enabled: boolean;
    /** Run when the key is pressed while enabled. */
    onAction: () => void;
};

/**
 * A read-only, scrollable list of lines with an empty-state message. Esc (host) / q / Enter close. An
 * optional {@link ResultsAction} adds a single-key footer affordance; with no `action` prop the dialog
 * renders identically to one that never offered an action.
 */
export function ResultsDialog(props: { title: string; lines: string[]; emptyText: string; action?: ResultsAction; onClose: () => void }): JSX.Element {
    const dialog = useDialogEntry();

    useDialogCancel(() => props.onClose());

    // The footer hint: scroll + close, plus the action's `key label` when the action is enabled. A
    // disabled action stays absent (no hint) so the string matches the actionless dialog exactly. The
    // action's `enabled` is fixed for a dialog instance (this is a point-in-time view), so the string
    // is effectively static — DialogPanel paints it as a full-width row (the scrollbox-bleed rule).
    const footer = (): string => {
        const base = `${SCROLL_HINT} ${GLYPHS.middot} ${chordLabel(KEYS.escape)}/${chordLabel(KEYS.q)} close`;
        const action = props.action;
        return action?.enabled ? `${base} ${GLYPHS.middot} ${action.key} ${action.label}` : base;
    };

    // Scroll keys come from ScrollPane's focus-target layer; focus itself is host-applied (the
    // pane must be the focused renderable for those keys to gate on). `q` (and the optional action
    // key) are bare printables but compliant: no text input can coexist with them in this dialog. The
    // action binding is gated on `enabled` — a disabled action is inert.
    useDialogBindings(() => ({
        bindings: [
            { chord: KEYS.q, run: () => props.onClose() },
            { chord: KEYS.enter, run: () => props.onClose() },
            ...(props.action?.enabled ? [{ chord: parseChord(props.action.key), run: () => props.action?.onAction() }] : []),
        ],
    }));

    return (
        <DialogPanel title={props.title} size="lg" footer={footer()}>
            <ScrollPane focusOnMount={false} onRef={(r: ScrollBoxRenderable) => dialog?.setInitialFocus(r)} flexGrow={1} width="100%" paddingTop={1}>
                <Show when={props.lines.length > 0} fallback={<text fg={theme().fgMuted}>{props.emptyText}</text>}>
                    <For each={props.lines}>{(line) => <text fg={theme().fg}>{line}</text>}</For>
                </Show>
            </ScrollPane>
        </DialogPanel>
    );
}
