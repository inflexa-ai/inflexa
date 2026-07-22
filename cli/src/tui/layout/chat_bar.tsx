import { createSignal, Show } from "solid-js";
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
     * Whether the composer opens in INSERT (default true — the chat exists to be typed into). Seeds the
     * footer's mode word from the first frame; real focus is the host's job (it drives the renderable
     * handed back by {@link ChatBarProps.onTextareaRef}), which is why the seed is decoupled from a
     * self-grab. A host mounting the bar as a non-primary widget — a design-gallery exhibit — passes
     * false for a blurred NORMAL exhibit, or true to showcase the INSERT footer without ever taking the
     * surrounding surface's focus.
     */
    autoFocus?: boolean;
    /**
     * The mode-scoped interrupt affordance rendered after the mode word while a turn is busy, or
     * absent when the honesty gates say nothing to promise (idle, dialog stacked, ask docked). The
     * host derives label + `armed` from the live bindings and hands it down as data — `ChatBar` keeps
     * its no-domain-imports rule. `armed` selects the "again to interrupt" confirm styling; the INSERT
     * variant (the one-press abort chord) never arms.
     */
    interruptHint?: { label: string; armed: boolean };
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
 * scroll keys are live and typing won't insert. After the mode word the footer carries the
 * mode-scoped interrupt hint (a data prop — see {@link ChatBarProps.interruptHint}) and, on the
 * right, the newline-key hint; global keybind hints live only in the status bar. The host keeps
 * the textarea ref so it can read/clear the buffer and restore focus when a dialog closes.
 */
export function ChatBar(props: ChatBarProps) {
    // Seed from autoFocus so a blurred mount renders NORMAL from the first frame — the renderable
    // emits no blur event at mount to correct a wrong seed (mirrors TextArea's own seed).
    // eslint-disable-next-line solid/reactivity -- seed-once: autoFocus is a mount-time contract, then focus events drive the signal
    const [focused, setFocused] = createSignal(props.autoFocus ?? true);

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
                // The inner textarea never self-grabs: the host owns real focus and drives it through the
                // renderable handed back by `onTextareaRef` (the chat focuses it on mount, and hands it to
                // the pane on esc). Decoupling the display seed (below) from a self-grab is what lets a
                // showcase mount the bar in INSERT without the surrounding surface's focus being stolen.
                autoFocus={false}
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
                {/* The mode-scoped interrupt hint sits directly after the mode word it describes. Its own
                <text> carries an explicit fg so the armed ("again to interrupt") state reads in warn while
                the resting hint stays muted; a leading middot separates it from the mode word. warn (not
                accent) keeps the armed hint distinct from the accent NORMAL word on the same bgActive row,
                on light themes included. */}
                <Show when={props.interruptHint} keyed>
                    {(hint: { label: string; armed: boolean }) => (
                        <text fg={hint.armed ? theme().warning : theme().fgMuted}>{` ${GLYPHS.middot} ${hint.label}`}</text>
                    )}
                </Show>
                <box flexGrow={1} />
                <text fg={theme().fgMuted}>{NEWLINE_LABEL} newline</text>
            </box>
        </box>
    );
}
