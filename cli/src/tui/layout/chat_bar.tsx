import { createSignal } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";

import { GLYPHS } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { NEWLINE_LABEL } from "../keymap.ts";
import { TextArea } from "../components/text_area.tsx";
import { Bold, Fg } from "../components/emphasis.tsx";

/** Props for {@link ChatBar}. */
export type ChatBarProps = {
    /** Receives the textarea renderable on mount (the host owns buffer access). */
    onTextareaRef: (r: TextareaRenderable) => void;
    /** Invoked when the user submits the message. */
    onSubmit: () => void;
    /**
     * Called when the textarea gains or loses focus. The host uses this for scroll-mode key gating
     * (vim keys are live only when blurred). The ChatBar itself observes focus internally for the
     * INSERT/NORMAL footer display.
     */
    onFocusChange?: (focused: boolean) => void;
    /**
     * Why the input is gated (submits refused by the host), or absent when the input is open. Drives
     * the empty-buffer placeholder so the affordance itself explains why typing goes nowhere yet:
     *   - `"booting"` — the runtime is still coming up; a first message can be pre-typed and sends once
     *     ready;
     *   - `"failed"` — boot hit a terminal error (its actionable reason renders above the bar); typing
     *     here will not send.
     * The textarea stays editable in either state; only the host's submit is gated.
     */
    gate?: "booting" | "failed";
};

/**
 * The chat input bar: a `TextArea` with `chrome="full"` plus an external mode footer row.
 * NORMAL mode gets a distinct background (`bgActive`) and accent color so the user knows vim
 * scroll keys are live and typing won't insert. The footer shows the newline-key hint (a
 * textarea-level affordance) — global keybind hints live only in the status bar. The host keeps
 * the textarea ref so it can read/clear the buffer and restore focus when a dialog closes.
 */
export function ChatBar(props: ChatBarProps) {
    const [focused, setFocused] = createSignal(true);

    return (
        // flexShrink={0}: the input is essential chrome — it must always keep its rows. Without it,
        // opentui defaults a "100%"-width (non-numeric) box to flexShrink=1, so on a short terminal
        // (e.g. a tmux 2x2 pane) the whole bar gets squeezed below its border min and the textarea
        // content paints above the bottom border. The Chat stream (flexGrow + minHeight=0) yields instead.
        <box width="100%" flexDirection="column" flexShrink={0}>
            <TextArea
                chrome="full"
                minHeight={3}
                maxHeight={8}
                placeholder={
                    props.gate === "failed"
                        ? `Boot failed ${GLYPHS.emDash} see the message above`
                        : props.gate === "booting"
                          ? `Booting harness runtime${GLYPHS.ellipsis}`
                          : `Type a message${GLYPHS.ellipsis}`
                }
                onRef={(r) => props.onTextareaRef(r)}
                onSubmit={() => props.onSubmit()}
                onFocusChange={(f) => {
                    setFocused(f);
                    props.onFocusChange?.(f);
                }}
            />
            <box width="100%" flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={focused() ? undefined : theme().bgActive}>
                <text fg={focused() ? theme().fgMuted : theme().accent}>
                    {focused() ? (
                        "INSERT"
                    ) : (
                        <Bold>
                            <Fg role="accent">NORMAL</Fg>
                        </Bold>
                    )}
                </text>
                <box flexGrow={1} />
                <text fg={theme().fgSubtle}>{NEWLINE_LABEL} newline</text>
            </box>
        </box>
    );
}
