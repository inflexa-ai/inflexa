import type { TextareaRenderable, KeyBinding } from "@opentui/core";

import { GLYPHS } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { SUBMIT_CHORD, NEWLINE_CHORD, chordLabel } from "../keymap.ts";
import { Bold, Fg } from "../components/emphasis.tsx";

/** Props for {@link InputBar}. */
export type InputBarProps = {
    /** Receives the textarea renderable on mount (the host owns focus + buffer access). */
    onTextareaRef: (r: TextareaRenderable) => void;
    /** Invoked when the user submits the message. */
    onSubmit: () => void;
    /**
     * Whether the textarea currently holds focus. Drives the INSERT/NORMAL mode word and the border
     * tint: blurring the input (esc) enters NORMAL "scroll" mode where the vim scroll keys are live.
     */
    focused: () => boolean;
};

// Enter submits; Ctrl+J inserts a newline. These stay at the textarea/renderable level (not the
// global keymap engine) because they are cursor-aware editing actions the engine can't see; the
// chords are still sourced from the keymap so the submit/newline keys have a single definition.
// Shift+Enter is a silent bonus for kitty-protocol-capable terminals (where shift on Enter is
// reliably delivered); in legacy terminals it's indistinguishable from Enter and harmlessly no-ops.
const keyBindings: KeyBinding[] = [
    { name: SUBMIT_CHORD.key, action: "submit" },
    { name: NEWLINE_CHORD.key, ctrl: NEWLINE_CHORD.ctrl, action: "newline" },
    { name: "return", shift: true, action: "newline" },
];

/**
 * The chat input bar: the bordered textarea plus a mode footer row (`INSERT` / `NORMAL`).
 * NORMAL mode gets a distinct background (`bgActive`) and accent color so the user knows vim
 * scroll keys are live and typing won't insert. The footer shows the newline-key hint (a
 * textarea-level affordance) — global keybind hints live only in the status bar. The host keeps
 * the textarea ref so it can read/clear the buffer and restore focus when a dialog closes.
 */
export function InputBar(props: InputBarProps) {
    return (
        // flexShrink={0}: the input is essential chrome — it must always keep its rows. Without it,
        // opentui defaults a "100%"-width (non-numeric) box to flexShrink=1, so on a short terminal
        // (e.g. a tmux 2x2 pane) the whole bar gets squeezed below its border min and the textarea
        // content paints above the bottom border. The Chat stream (flexGrow + minHeight=0) yields instead.
        <box width="100%" flexDirection="column" flexShrink={0}>
            <box
                width="100%"
                minHeight={3}
                maxHeight={8}
                borderColor={props.focused() ? theme().borderFocus : theme().border}
                border
                paddingLeft={1}
                paddingRight={1}
            >
                <textarea
                    ref={(r: TextareaRenderable) => props.onTextareaRef(r)}
                    focused
                    width="100%"
                    placeholder={`Type a message${GLYPHS.ellipsis}`}
                    placeholderColor={theme().fgMuted}
                    textColor={theme().fg}
                    backgroundColor={theme().bg}
                    focusedBackgroundColor={theme().bgActive}
                    keyBindings={keyBindings}
                    onSubmit={() => props.onSubmit()}
                />
            </box>
            <box width="100%" flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={props.focused() ? undefined : theme().bgActive}>
                <text fg={props.focused() ? theme().fgMuted : theme().accent}>
                    {props.focused() ? (
                        "INSERT"
                    ) : (
                        <Bold>
                            <Fg role="accent">NORMAL</Fg>
                        </Bold>
                    )}
                </text>
                <box flexGrow={1} />
                <text fg={theme().fgSubtle}>{chordLabel(NEWLINE_CHORD)} newline</text>
            </box>
        </box>
    );
}
