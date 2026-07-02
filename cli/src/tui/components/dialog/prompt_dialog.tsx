import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";

import { GLYPHS } from "../../../lib/design_system.ts";
import { KEYS, chordLabel } from "../../keymap.ts";
import { useDialogCancel, useDialogCloseGuard, useDialogEntry } from "./dialog_host.tsx";
import { DialogPanel } from "./dialog_panel.tsx";
import { TextArea } from "../text_area.tsx";
import { TextInput } from "../text_input.tsx";

/**
 * A text prompt dialog: title, optional description, a text field, enter-to-submit. The single
 * prompt widget for all text-entry dialogs. The `multiline` prop selects the primitive: off (the
 * default) renders the single-line `TextInput` — enter submits, nothing can insert a newline, and
 * no INSERT/NORMAL mode word appears (a modal has no reachable NORMAL mode; esc closes the dialog
 * via the host); on renders the multi-line `TextArea` with the submit/newline chords and `height`
 * honored. Both use `chrome="bare"` — the dialog panel border is the sole chrome.
 *
 * Esc/cancel is the HOST's: the dialog binds no keys itself. It participates in the close funnel
 * via its entry handle — `onCancel` fires for every non-commit close (esc, click-outside, ctrl+c),
 * and the busy state vetoes ALL closes, making an in-flight operation dismissal-proof.
 */
export function PromptDialog(props: {
    /** Panel title shown in the border chrome. */
    title: string;
    /** `danger` renders the destructive-confirm chrome (double border, error color) — type-to-confirm deletes. */
    tone?: "default" | "danger";
    /** Optional JSX description rendered between the title and the text field. */
    description?: () => JSX.Element;
    /** Placeholder text when the field is empty. */
    placeholder?: string;
    /** Initial field value. */
    value?: string;
    /** When true, renders a multi-line TextArea instead of the single-line TextInput. */
    multiline?: boolean;
    /** TextArea row height when `multiline` (defaults to 3). Ignored for single-line prompts. */
    height?: number;
    /** When true, the input is dimmed and unfocusable, submit is disabled, and every close is vetoed. */
    busy?: boolean;
    /** Message shown in the footer while `busy` is true (defaults to "Working…"). */
    busyText?: string;
    /** Called with the field's plain text when the user submits. */
    onSubmit: (value: string) => void;
    /** Called when the dialog closes for any non-commit reason (esc, click-outside, ctrl+c). */
    onCancel: () => void;
}): JSX.Element {
    const dialog = useDialogEntry();
    // Showcased exhibits must not grab focus at mount: the editor's `focused` prop acts below
    // the inert handle's reach, so autoFocus is threaded off explicitly.
    const autoFocus = !(dialog?.inert ?? false);
    // Input extends Textarea in opentui, so one ref type covers both primitives.
    let editRef: TextareaRenderable | undefined;
    const [spinFrame, setSpinFrame] = createSignal(0);

    useDialogCloseGuard(() => !props.busy);
    useDialogCancel(() => props.onCancel());

    createEffect(() => {
        if (!props.busy) return;
        const timer = setInterval(() => {
            setSpinFrame((f) => (f + 1) % GLYPHS.spinner.length);
        }, 80);
        onCleanup(() => {
            clearInterval(timer);
            setSpinFrame(0);
        });
    });

    function submit(text: string): void {
        if (props.busy) return;
        props.onSubmit(text);
    }

    function handleRef(r: TextareaRenderable): void {
        editRef = r;
        r.gotoLineEnd();
        if (!props.busy) dialog?.setInitialFocus(r);
    }

    createEffect(() => {
        if (!editRef || editRef.isDestroyed) return;
        if (props.busy) {
            editRef.blur();
        } else if (dialog?.isTop()) {
            // isTop guards the grab: a covered prompt must not steal focus back from the dialog
            // above it, and a gallery-embedded showcase (null handle) must not grab at all.
            editRef.focus();
        }
    });

    const footer = (): string =>
        props.busy
            ? `${GLYPHS.spinner[spinFrame()]} ${props.busyText ?? `Working${GLYPHS.ellipsis}`}`
            : `${chordLabel(KEYS.enter)} submit ${GLYPHS.middot} ${chordLabel(KEYS.escape)} cancel`;

    return (
        <DialogPanel title={props.title} size="md" tone={props.tone} padY footer={footer()}>
            <box gap={1}>
                <Show when={props.description} keyed>
                    {(desc: () => JSX.Element) => desc()}
                </Show>
                <Show
                    when={props.multiline}
                    fallback={
                        <TextInput
                            chrome="bare"
                            autoFocus={autoFocus}
                            placeholder={props.placeholder}
                            initialValue={props.value}
                            busy={props.busy}
                            onRef={handleRef}
                            onSubmit={submit}
                        />
                    }
                >
                    <TextArea
                        chrome="bare"
                        autoFocus={autoFocus}
                        height={props.height ?? 3}
                        placeholder={props.placeholder}
                        initialValue={props.value}
                        busy={props.busy}
                        onRef={handleRef}
                        onSubmit={submit}
                    />
                </Show>
            </box>
        </DialogPanel>
    );
}
