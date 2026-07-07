import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { TextareaRenderable, KeyBinding } from "@opentui/core";

import { theme } from "../theme.ts";
import { SUBMIT_CHORD, NEWLINE_CHORD } from "../keymap.ts";

/** Chrome tier for {@link TextArea}: controls border presence and mode indicator placement. */
export type TextAreaChrome = "full" | "compact" | "bare";

/** Props for {@link TextArea}. */
export type TextAreaProps = {
    /** Controls border presence and mode indicator placement. */
    chrome: TextAreaChrome;
    /** Placeholder text shown when the buffer is empty. */
    placeholder?: string;
    /** Initial textarea value (seeded on mount, not reactive). */
    initialValue?: string;
    /** Textarea row height — omit for auto-sizing. */
    height?: number;
    /** Minimum height in rows. */
    minHeight?: number;
    /** Maximum height in rows. */
    maxHeight?: number;
    /**
     * When true, dims the text and hides the cursor to signal that input is locked. Submit is
     * suppressed — pressing Enter is a no-op. Used by PromptDialog during async operations.
     */
    busy?: boolean;
    /**
     * Grab focus on mount (default true — prompts exist to be typed into). Hosts rendering the
     * textarea as a non-primary widget (gallery exhibits, showcased dialogs) pass false so it
     * mounts blurred, in NORMAL chrome, without stealing the surface's focus.
     */
    autoFocus?: boolean;
    /**
     * Called when the textarea gains or loses focus. The component tracks focus internally via
     * renderable events — this is a notification, not a control prop. Hosts that gate behavior on
     * focus state (e.g. scroll-mode keys, INSERT/NORMAL display) observe it through this callback.
     */
    onFocusChange?: (focused: boolean) => void;
    /** Receives the textarea renderable on mount (the host owns buffer access). */
    onRef?: (r: TextareaRenderable) => void;
    /** Invoked with the buffer's plain text when the user submits (Enter chord). */
    onSubmit: (text: string) => void;
};

// Enter submits; Ctrl+J inserts a newline. These stay at the textarea/renderable level (not the
// keymap engine) because they are cursor-aware editing actions the engine can't see; the chords
// are still sourced from keymap.ts so the submit/newline keys have a single definition.
// Shift+Enter is a silent bonus for kitty-protocol-capable terminals.
const keyBindings: KeyBinding[] = [
    { name: SUBMIT_CHORD.key, action: "submit" },
    { name: NEWLINE_CHORD.key, ctrl: NEWLINE_CHORD.ctrl, action: "newline" },
    { name: "return", shift: true, action: "newline" },
];

/**
 * Shared textarea primitive with themed styling, internal INSERT/NORMAL mode tracking, and
 * submit/newline chords at the renderable level. Uncontrolled: focus state is owned internally
 * via renderable events, exposed through `onFocusChange`. Clicking anywhere on the bordered
 * chrome also focuses the textarea. Three chrome tiers control visual treatment:
 *
 * - **full** — bordered box (border color signals mode), no footer (host adds its own).
 * - **compact** — bordered box with mode word in the border title (zero extra rows).
 * - **bare** — no border, no mode text; mode signal is background color shift only.
 */
export function TextArea(props: TextAreaProps): JSX.Element {
    // Seeded from autoFocus so a widget mounted blurred renders NORMAL chrome from the first
    // frame — the renderable emits no `blurred` event at mount to correct a wrong seed.
    // eslint-disable-next-line solid/reactivity -- seed-once: autoFocus is a mount-time contract
    const [focused, setFocused] = createSignal(props.autoFocus ?? true);
    let ref: TextareaRenderable | null = null;

    const modeWord = () => (focused() ? "INSERT" : "NORMAL");
    const isBare = () => props.chrome === "bare";

    function handleClick(): void {
        ref?.focus();
    }

    const textarea = (
        <textarea
            // Inline ref callback (not a named function) so the reactive reads below stay inside a
            // scope the lint rule recognizes — a named `ref={handleRef}` is flagged as a reactive
            // variable used in JSX. The `r.on(...)` subscriptions are imperative opentui event
            // registrations, not a Solid tracked scope: their handlers read props lazily at
            // focus/blur time (staying current), so no reactive dependency is dropped.
            ref={(r: TextareaRenderable) => {
                ref = r;
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
            height={props.height}
            initialValue={props.initialValue}
            placeholder={props.placeholder ?? ""}
            placeholderColor={theme().fgMuted}
            textColor={props.busy ? theme().fgMuted : theme().fg}
            backgroundColor={theme().bg}
            focusedBackgroundColor={theme().bgActive}
            cursorColor={props.busy ? theme().bg : theme().fg}
            keyBindings={keyBindings}
            onSubmit={() => {
                if (props.busy) return;
                props.onSubmit(ref?.plainText ?? "");
            }}
        />
    );

    // bare: no border, no mode text — background color shift is the sole mode signal.
    // Clicking the textarea itself handles focus (opentui default).
    // bordered (full/compact): border color signals mode; clicking the border chrome also focuses.
    // compact additionally puts the mode word in the border title (same mechanism as DialogPanel).
    // full has no title — the host (ChatBar) renders the mode in an external footer.
    return (
        <Show when={!isBare()} fallback={textarea}>
            <box
                width="100%"
                minHeight={props.minHeight}
                maxHeight={props.maxHeight}
                borderColor={focused() ? theme().borderFocus : theme().border}
                border
                paddingLeft={1}
                paddingRight={1}
                title={props.chrome === "compact" ? modeWord() : undefined}
                titleAlignment={props.chrome === "compact" ? "right" : undefined}
                titleColor={props.chrome === "compact" ? (focused() ? theme().fgMuted : theme().accent) : undefined}
                onMouseUp={handleClick}
            >
                {textarea}
            </box>
        </Show>
    );
}
