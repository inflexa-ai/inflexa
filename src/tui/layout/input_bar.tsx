import type { TextareaRenderable, KeyBinding } from "@opentui/core";

import { GLYPHS } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { SUBMIT_CHORD, NEWLINE_CHORD } from "../keymap.ts";

/** Props for {@link InputBar}. */
export type InputBarProps = {
    /** Receives the textarea renderable on mount (the host owns focus + buffer access). */
    onTextareaRef: (r: TextareaRenderable) => void;
    /** Invoked when the user submits the message. */
    onSubmit: () => void;
};

// Enter submits; Option/Alt+Enter inserts a newline (opentui delivers Option as Meta). These stay
// at the textarea/renderable level (not the global keymap engine) because they are cursor-aware
// editing actions the engine can't see; the chords are still sourced from the keymap so the
// submit/newline keys have a single definition.
const keyBindings: KeyBinding[] = [
    { name: SUBMIT_CHORD.key, action: "submit" },
    { name: NEWLINE_CHORD.key, meta: NEWLINE_CHORD.alt, action: "newline" },
];

/**
 * The chat input bar: the bordered textarea plus a single muted footer row of session/mode info
 * (`INSERT` … `xhigh /effort`), hardcoded until those features are integrated. Global keybind
 * hints are deliberately NOT shown here — they live only in the status bar, so the header and
 * this footer never repeat the same keys. The host keeps the textarea ref so it can read/clear
 * the buffer and restore focus when a dialog closes.
 */
export function InputBar(props: InputBarProps) {
    return (
        // flexShrink={0}: the input is essential chrome — it must always keep its rows. Without it,
        // opentui defaults a "100%"-width (non-numeric) box to flexShrink=1, so on a short terminal
        // (e.g. a tmux 2x2 pane) the whole bar gets squeezed below its border min and the textarea
        // content paints above the bottom border. The Chat stream (flexGrow + minHeight=0) yields instead.
        <box width="100%" flexDirection="column" flexShrink={0}>
            <box width="100%" minHeight={3} maxHeight={8} borderColor={theme().borderFocus} border paddingLeft={1} paddingRight={1}>
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
            <box width="100%" flexDirection="row" paddingLeft={1} paddingRight={1}>
                <text fg={theme().fgMuted}>INSERT</text>
                <box flexGrow={1} />
                <text fg={theme().fgMuted}>xhigh /effort</text>
            </box>
        </box>
    );
}
