import type { JSX } from "solid-js";

import { GLYPHS } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { KEYS, chordLabel } from "../../keymap.ts";
import { useDialogBindings, useDialogCancel } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";

/**
 * A simple acknowledgement dialog: title, message, dismiss. Enter acknowledges; esc (the host's
 * structural binding) and click-outside also close — there is no distinct confirm/cancel outcome
 * (use {@link ConfirmDialog} for that). The caller's `onClose` is responsible for popping the
 * dialog stack (e.g. `workspace.closeDialog()`); non-commit closes reach it via the funnel.
 */
export function AlertDialog(props: {
    /** Panel title shown in the border chrome. */
    title: string;
    /** The body message, rendered in the muted foreground. */
    message: string;
    /** The single dismiss action, fired on enter, esc, or click-outside. */
    onClose: () => void;
}): JSX.Element {
    useDialogCancel(() => props.onClose());

    useDialogBindings(() => ({
        bindings: [{ chord: KEYS.enter, run: () => props.onClose(), desc: "Dismiss", group: "Dialog" }],
    }));

    return (
        <DialogPanel title={props.title} size="md" padY footer={`${chordLabel(KEYS.enter)} ok ${GLYPHS.middot} ${chordLabel(KEYS.escape)} close`}>
            <text fg={theme().fgMuted}>{props.message}</text>
        </DialogPanel>
    );
}
