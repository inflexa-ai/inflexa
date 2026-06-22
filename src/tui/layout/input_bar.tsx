import type { TextareaRenderable, KeyBinding } from "@opentui/core";

import { theme } from "../theme.ts";

/** Props for {@link InputBar}. */
export type InputBarProps = {
    /** Receives the textarea renderable on mount (the host owns focus + buffer access). */
    onTextareaRef: (r: TextareaRenderable) => void;
    /** Invoked when the user submits the message. */
    onSubmit: () => void;
};

// Enter submits; Option/Alt+Enter inserts a newline (opentui delivers Option as Meta).
const keyBindings: KeyBinding[] = [
    { name: "return", action: "submit" },
    { name: "return", meta: true, action: "newline" },
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
        <box width="100%" flexDirection="column">
            <box width="100%" minHeight={3} maxHeight={8} borderColor={theme().borderActive} border paddingLeft={1} paddingRight={1}>
                <textarea
                    ref={(r: TextareaRenderable) => props.onTextareaRef(r)}
                    focused
                    width="100%"
                    placeholder="Type a message…"
                    placeholderColor={theme().muted}
                    textColor={theme().fg}
                    backgroundColor={theme().bg}
                    focusedBackgroundColor={theme().bgFocused}
                    keyBindings={keyBindings}
                    onSubmit={() => props.onSubmit()}
                />
            </box>
            <box width="100%" flexDirection="row" paddingLeft={1} paddingRight={1}>
                <text fg={theme().muted}>INSERT</text>
                <box flexGrow={1} />
                <text fg={theme().muted}>xhigh /effort</text>
            </box>
        </box>
    );
}
