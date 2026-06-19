import { onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";

import { theme } from "../theme.ts";
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
    useKeyboard((key) => {
        if (key.name === "escape") props.onCancel();
    });
    return (
        <DialogPanel title={props.title} width="60%" padY footer="Enter submit · Esc cancel">
            <input
                ref={(r: InputRenderable) => {
                    inputRef = r;
                }}
                focused
                width="100%"
                value={props.initialValue ?? ""}
                placeholder={props.placeholder ?? ""}
                placeholderColor={theme().muted}
                textColor={theme().fg}
                backgroundColor={theme().bg}
                focusedBackgroundColor={theme().bgFocused}
                onSubmit={() => props.onSubmit(inputRef?.value ?? "")}
            />
        </DialogPanel>
    );
}
