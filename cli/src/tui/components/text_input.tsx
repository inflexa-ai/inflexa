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
    /** Called when the input gains or loses focus. The component tracks focus internally. */
    onFocusChange?: (focused: boolean) => void;
    /** Receives the input renderable on mount (the host owns focus). */
    onRef?: (r: InputRenderable) => void;
    /** Invoked on every keystroke with the current text value. */
    onInput?: (value: string) => void;
};

/**
 * Shared single-line input primitive with themed styling and per-keystroke `onInput`. Wraps
 * opentui's `<input>` — no mode concept (always INSERT), no submit/newline chords. Uncontrolled:
 * focus state is owned internally. Clicking the border chrome focuses the input. Two chrome
 * tiers: `"compact"` (bordered, border color shifts on focus) and `"bare"` (no border).
 */
export function TextInput(props: TextInputProps): JSX.Element {
    const [focused, setFocused] = createSignal(true);
    let ref: InputRenderable | null = null;

    const isBare = () => props.chrome === "bare";

    function handleRef(r: InputRenderable): void {
        ref = r;
        // opentui defaults scrollMargin to 0.2 (20% of viewport width), which wastes ~17 columns in
        // a typical dialog — text scrolls left before filling the available space. 0.02 (~2 cols)
        // keeps a minimal look-ahead for the cursor while reclaiming the wasted space. Going to 0
        // causes the input's content width to push the dialog wider (yoga's measureFunc reports the
        // full text width when no scroll margin absorbs it).
        r.editorView.setScrollMargin(0.02);
        // eslint-disable-next-line solid/reactivity -- opentui renderable event handler; r.on() is an event subscription, not a reactive scope
        r.on("focused", () => {
            setFocused(true);
            props.onFocusChange?.(true);
        });
        r.on("blurred", () => {
            setFocused(false);
            props.onFocusChange?.(false);
        });
        props.onRef?.(r);
    }

    function handleClick(): void {
        ref?.focus();
    }

    const input = (
        <input
            ref={handleRef}
            focused
            width="100%"
            placeholder={props.placeholder ?? ""}
            placeholderColor={theme().fgMuted}
            textColor={theme().fg}
            backgroundColor={theme().bg}
            focusedBackgroundColor={theme().bgActive}
            onInput={(v: string) => props.onInput?.(v)}
        />
    );

    // bare: no border. compact: bordered with focus-dependent border color, click-to-focus.
    return (
        <Show when={!isBare()} fallback={input}>
            <box width="100%" border borderColor={focused() ? theme().borderFocus : theme().border} paddingLeft={1} paddingRight={1} onMouseUp={handleClick}>
                {input}
            </box>
        </Show>
    );
}
