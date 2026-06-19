import { For, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";

import { theme } from "../theme.ts";
import { DialogPanel } from "./dialog_panel.tsx";

/** A read-only, scrollable list of lines with an empty-state message. Esc/q/Enter close. */
export function ResultsDialog(props: { title: string; lines: string[]; emptyText: string; onClose: () => void }): JSX.Element {
    let scrollRef: ScrollBoxRenderable | null = null;
    onMount(() => queueMicrotask(() => scrollRef?.focus()));
    useKeyboard((key) => {
        if (key.name === "escape" || key.name === "q" || key.name === "return") props.onClose();
    });
    return (
        <DialogPanel title={props.title} width="70%" height="60%" footer="↑/↓ scroll · Esc/q close">
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
