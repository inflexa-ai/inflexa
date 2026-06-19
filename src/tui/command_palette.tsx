import { createMemo, For, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";

import { theme } from "./theme.ts";
import { SelectList, type SelectItem } from "./select_list.tsx";
import type { Command, CommandContext } from "./commands.tsx";

// The palette UI layer: the single dispatch verb, the command palette itself, and the two
// reusable dialog shells (`PromptDialog`, `ResultsDialog`). The searchable list engine lives
// in `select_list.tsx`. Command *definitions* live in `commands.tsx`; this file only knows how
// to display and run them, so it imports `commands.tsx` for types ONLY — `App` injects the
// concrete `commands` array as a prop, keeping the runtime dependency one-directional
// (commands.tsx → command_palette.tsx).

/** Run a command with the in-app capability surface. The single funnel every entry point uses. */
export async function runCommand(cmd: Command, ctx: CommandContext): Promise<void> {
    await cmd.run(ctx);
}

/** The command palette: a thin adapter mapping commands to {@link SelectList} rows + dispatch. */
export function CommandPalette(props: { ctx: CommandContext; commands: Command[] }): JSX.Element {
    const items = createMemo<SelectItem<Command>[]>(() =>
        props.commands
            .filter((c) => c.enabled?.(props.ctx) ?? true)
            .map((c) => ({ value: c, title: c.title, description: c.description, hint: c.keybind, category: c.category })),
    );
    return (
        <SelectList
            title="Commands"
            placeholder="Search commands…"
            items={items()}
            emptyText="No matching commands"
            grouped
            onCancel={() => props.ctx.closeDialog()}
            onSelect={(cmd) => {
                // Close the palette BEFORE running, so a command that opens its own dialog
                // replaces (not stacks on) the palette.
                props.ctx.closeDialog();
                void runCommand(cmd, props.ctx);
            }}
        />
    );
}

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
        <box
            width="60%"
            flexDirection="column"
            backgroundColor={theme().bgPanel}
            border
            borderColor={theme().borderActive}
            title={props.title}
            titleColor={theme().accent}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
        >
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
            <text fg={theme().muted}>Enter submit · Esc cancel</text>
        </box>
    );
}

/** A read-only, scrollable list of lines with an empty-state message. Esc/q/Enter close. */
export function ResultsDialog(props: { title: string; lines: string[]; emptyText: string; onClose: () => void }): JSX.Element {
    let scrollRef: ScrollBoxRenderable | null = null;
    onMount(() => queueMicrotask(() => scrollRef?.focus()));
    useKeyboard((key) => {
        if (key.name === "escape" || key.name === "q" || key.name === "return") props.onClose();
    });
    return (
        <box
            width="70%"
            height="60%"
            flexDirection="column"
            backgroundColor={theme().bgPanel}
            border
            borderColor={theme().borderActive}
            title={props.title}
            titleColor={theme().accent}
            paddingLeft={1}
            paddingRight={1}
        >
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
            <text fg={theme().muted}>↑/↓ scroll · Esc/q close</text>
        </box>
    );
}
