import type { JSX } from "solid-js";

import { GLYPHS } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { useBindings, KEYS, chordLabel } from "../../keymap.ts";
import { DialogPanel } from "./dialog_panel.tsx";

/**
 * A simple acknowledgement dialog: title, message, dismiss. Both enter and esc close it — there is
 * no distinct confirm/cancel outcome (use {@link ConfirmDialog} for that). The caller's `onClose`
 * is responsible for popping the dialog stack (e.g. `workspace.closeDialog()`).
 */
export function AlertDialog(props: {
    /** Panel title shown in the border chrome. */
    title: string;
    /** The body message, rendered in the muted foreground. */
    message: string;
    /** Called on enter or esc — the single dismiss action. */
    onClose: () => void;
}): JSX.Element {
    useBindings(() => ({
        bindings: [
            { chord: KEYS.enter, run: () => props.onClose(), desc: "Dismiss", group: "Dialog" },
            { chord: KEYS.escape, run: () => props.onClose(), desc: "Dismiss", group: "Dialog" },
        ],
    }));

    return (
        <DialogPanel title={props.title} size="md" padY footer={`${chordLabel(KEYS.enter)} ok ${GLYPHS.middot} ${chordLabel(KEYS.escape)} close`}>
            <text fg={theme().fgMuted}>{props.message}</text>
        </DialogPanel>
    );
}
