import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { InputRenderable } from "@opentui/core";

import { theme } from "../theme.ts";

/** Chrome tier for {@link TextInput}: controls border presence. */
export type TextInputChrome = "compact" | "bare";

/** Props for {@link TextInput}. */
export type TextInputProps = {
    /** Controls border presence. No `"full"` tier — TextInput has no mode concept needing a footer. */
    chrome: TextInputChrome;
    /** Placeholder text shown when the input is empty. */
    placeholder?: string;
    /** Initial text value (seeded on mount, not reactive). */
    initialValue?: string;
    /**
     * When true, dims the text and hides the cursor to signal that input is locked — the same
     * visual contract as TextArea's `busy`. Suppressing submit is the host's job (the input still
     * fires `onSubmit`; hosts like PromptDialog gate it on their busy state).
     */
    busy?: boolean;
    /**
     * Grab focus on mount (default true — the filter-first dialogs). List-first hosts like the
     * file picker pass false so the widget mounts in their NORMAL mode with the input blurred.
     */
    autoFocus?: boolean;
    /** Called when the input gains or loses focus. The component tracks focus internally. */
    onFocusChange?: (focused: boolean) => void;
    /** Receives the input renderable on mount (the host owns focus). */
    onRef?: (r: InputRenderable) => void;
    /** Invoked on every keystroke with the current text value. */
    onInput?: (value: string) => void;
    /**
     * Invoked with the current text when the user presses enter, mirroring TextArea's submit
     * contract at the renderable level. Omit it and enter stays a no-op for the input itself —
     * hosts like SelectDialog let their list's keymap layer handle enter instead.
     */
    onSubmit?: (value: string) => void;
};

/**
 * Shared single-line input primitive with themed styling, per-keystroke `onInput`, and optional
 * enter-to-submit. Wraps opentui's `<input>` — no mode concept (always INSERT), no newline
 * mechanism (strictly single-line). Uncontrolled: focus state is owned internally. Clicking the
 * border chrome focuses the input. Two chrome tiers: `"compact"` (bordered, border color shifts
 * on focus) and `"bare"` (no border).
 */
export function TextInput(props: TextInputProps): JSX.Element {
    // Seeded from autoFocus so a widget mounted blurred renders blurred chrome from the first
    // frame — the renderable emits no `blurred` event at mount to correct a wrong seed.
    // eslint-disable-next-line solid/reactivity -- seed-once: autoFocus is a mount-time contract
    const [focused, setFocused] = createSignal(props.autoFocus ?? true);
    let ref: InputRenderable | null = null;

    const isBare = () => props.chrome === "bare";

    function handleClick(): void {
        ref?.focus();
    }

    const input = (
        <input
            // Inline ref callback (not a named function) so the reactive reads below stay inside a
            // scope the lint rule recognizes — a named `ref={handleRef}` is flagged as a reactive
            // variable used in JSX. The `r.on(...)` subscriptions are imperative opentui event
            // registrations, not a Solid tracked scope: their handlers read props lazily at
            // focus/blur time (staying current), so no reactive dependency is dropped.
            ref={(r: InputRenderable) => {
                ref = r;
                // opentui defaults scrollMargin to 0.2 (20% of viewport width), which wastes ~17
                // columns in a typical dialog — text scrolls left before filling the available
                // space. 0.02 (~2 cols) keeps a minimal look-ahead for the cursor while reclaiming
                // the wasted space. Going to 0 causes the input's content width to push the dialog
                // wider (yoga's measureFunc reports the full text width when no scroll margin
                // absorbs it).
                r.editorView.setScrollMargin(0.02);
                // eslint-disable-next-line solid/reactivity -- r.on() is an event subscription, not a tracked scope; the prop read fires at focus time
                r.on("focused", () => {
                    setFocused(true);
                    props.onFocusChange?.(true);
                });
                // eslint-disable-next-line solid/reactivity -- r.on() is an event subscription, not a tracked scope; the prop read fires at blur time
                r.on("blurred", () => {
                    setFocused(false);
                    props.onFocusChange?.(false);
                });
                props.onRef?.(r);
            }}
            focused={props.autoFocus ?? true}
            width="100%"
            value={props.initialValue}
            placeholder={props.placeholder ?? ""}
            placeholderColor={theme().fgMuted}
            textColor={props.busy ? theme().fgMuted : theme().fg}
            backgroundColor={theme().bg}
            focusedBackgroundColor={theme().bgActive}
            cursorColor={props.busy ? theme().bg : theme().fg}
            onInput={(v: string) => props.onInput?.(v)}
            onSubmit={() => props.onSubmit?.(ref?.value ?? "")}
        />
    );

    // bare: no border, but still a height-1 wrapper — InputRenderableOptions omits `height`, and
    // inside an auto-height parent the bare input otherwise resolves to zero rows (invisible).
    // compact: bordered with focus-dependent border color, click-to-focus.
    return (
        <Show
            when={!isBare()}
            fallback={
                <box width="100%" height={1} flexShrink={0}>
                    {input}
                </box>
            }
        >
            <box width="100%" border borderColor={focused() ? theme().borderFocus : theme().border} paddingLeft={1} paddingRight={1} onMouseUp={handleClick}>
                {input}
            </box>
        </Show>
    );
}
