import { onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { InputRenderable } from "@opentui/core";

import { GLYPHS } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { useBindings, KEYS, chordLabel } from "../keymap.ts";
import { DialogPanel } from "./dialog_panel.tsx";

/** A single-line text prompt. Enter submits the raw value; Esc cancels. */
export function PromptDialog(props: {
    title: string;
    placeholder?: string;
    initialValue?: string;
    onSubmit: (value: string) => void;
    onCancel: () => void;
}): JSX.Element {
    let inputRef: InputRenderable | null = null;
    onMount(() => queueMicrotask(() => inputRef?.focus()));
    // Enter is the input's own onSubmit (left unbound here so it falls through to the focused input).
    useBindings(() => ({
        bindings: [{ chord: KEYS.escape, run: () => props.onCancel() }],
    }));
    return (
        <DialogPanel title={props.title} width="60%" padY footer={`${chordLabel(KEYS.enter)} submit ${GLYPHS.middot} ${chordLabel(KEYS.escape)} cancel`}>
            <input
                ref={(r: InputRenderable) => {
                    inputRef = r;
                }}
                focused
                width="100%"
                value={props.initialValue ?? ""}
                placeholder={props.placeholder ?? ""}
                placeholderColor={theme().fgMuted}
                textColor={theme().fg}
                backgroundColor={theme().bg}
                focusedBackgroundColor={theme().bgActive}
                onSubmit={() => props.onSubmit(inputRef?.value ?? "")}
            />
        </DialogPanel>
    );
}
