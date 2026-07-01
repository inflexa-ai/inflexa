import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";

import { GLYPHS } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { useBindings, KEYS, chordLabel } from "../../keymap.ts";
import { DialogPanel } from "./dialog_panel.tsx";
import { TextArea } from "../text_area.tsx";

/**
 * A text prompt dialog: title, optional description, a textarea input, enter-to-submit,
 * esc-to-cancel. The single prompt widget for all text-entry dialogs — short names (height=1,
 * the default) and longer compositions (height=3+) alike. Supports an optional busy state
 * that dims the input, disables submit, and shows an animated braille spinner.
 */
export function PromptDialog(props: {
    /** Panel title shown in the border chrome. */
    title: string;
    /** Optional JSX description rendered between the title and the textarea. */
    description?: () => JSX.Element;
    /** Placeholder text when the field is empty. */
    placeholder?: string;
    /** Initial textarea value. */
    value?: string;
    /** Textarea row height — 1 for single-line prompts (the default), 3+ for multi-line. */
    height?: number;
    /** When true, the input is dimmed and unfocusable and the busy text is shown. */
    busy?: boolean;
    /** Message shown below the input while `busy` is true (defaults to "Working…"). */
    busyText?: string;
    /** Called with the textarea's plain text when the user submits. */
    onSubmit: (value: string) => void;
    /** Called when the user cancels (esc). */
    onCancel: () => void;
}): JSX.Element {
    let textareaRef: TextareaRenderable | undefined;
    const [spinFrame, setSpinFrame] = createSignal(0);

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

    useBindings(() => ({
        bindings: [{ chord: KEYS.escape, run: () => props.onCancel(), desc: "Cancel", group: "Dialog" }],
    }));

    onMount(() => {
        // eslint-disable-next-line solid/reactivity -- one-time mount: props.busy is read once to gate initial focus; the createEffect below handles subsequent changes
        queueMicrotask(() => {
            if (!textareaRef || textareaRef.isDestroyed) return;
            if (props.busy) return;
            textareaRef.focus();
            textareaRef.gotoLineEnd();
        });
    });

    createEffect(() => {
        if (!textareaRef || textareaRef.isDestroyed) return;
        if (props.busy) {
            textareaRef.blur();
        } else {
            textareaRef.focus();
        }
    });

    const footer = () =>
        props.busy ? `${props.busyText ?? `Working${GLYPHS.ellipsis}`}` : `${chordLabel(KEYS.enter)} submit ${GLYPHS.middot} ${chordLabel(KEYS.escape)} cancel`;

    return (
        <DialogPanel title={props.title} size="md" padY footer={footer()}>
            <box gap={1}>
                <Show when={props.description} keyed>
                    {(desc: () => JSX.Element) => desc()}
                </Show>
                <TextArea
                    chrome="compact"
                    height={props.height ?? 1}
                    placeholder={props.placeholder}
                    initialValue={props.value}
                    busy={props.busy}
                    onRef={(r: TextareaRenderable) => {
                        textareaRef = r;
                    }}
                    onSubmit={submit}
                />
                <Show when={props.busy}>
                    <text fg={theme().fgMuted}>
                        {GLYPHS.spinner[spinFrame()]} {props.busyText ?? `Working${GLYPHS.ellipsis}`}
                    </text>
                </Show>
            </box>
        </DialogPanel>
    );
}
