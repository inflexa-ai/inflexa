import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { BoxRenderable } from "@opentui/core";

import { GLYPHS, size, space } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { useBindings, KEYS, MODE_BASE } from "../keymap.ts";
import { TextInput } from "./text_input.tsx";
import { Bold, Fg } from "./emphasis.tsx";

/** Which decision surface the prompt is currently showing. */
type PromptMode = "choice" | "feedback";

/** Props for {@link AskPrompt}. */
export type AskPromptProps = {
    /** Short headline naming what needs approval (the ask's title). */
    title: string;
    /** The exact action awaiting approval, shown verbatim and emphasized so the user approves what they see. */
    command: string;
    /** Optional secondary line with more context about the action. */
    detail?: string;
    /** How many further asks are waiting behind this one; drives the `+N more` hint (0 hides it). */
    queuedCount: number;
    /**
     * True while an answer is in flight: the action keys are inert and the feedback input dims, so a
     * second keypress cannot double-answer before the gateway resolves.
     */
    busy?: boolean;
    /**
     * Which surface the prompt opens on. Defaults to `"choice"`. Used ONLY to seed the internal mode
     * signal once at mount so a static host (the design gallery) can exhibit the feedback surface
     * directly — it is NOT reactive after mount, and live flow still enters feedback by pressing `n`.
     */
    initialMode?: "choice" | "feedback";
    /**
     * True for a static gallery exhibit — two inertnesses in one flag. The feedback input mounts blurred
     * so it never steals the surrounding pane's focus (the same inertness the dialog showcase threads
     * into its editors), AND a click on a choice option is a no-op: a click needs no focus, so without
     * this an exhibit click on `n` would flip the exhibit into feedback mode and its auto-focusing input
     * would steal the gallery's focus. Live docks leave it unset — clicks answer, and reaching feedback
     * by pressing `n` should focus the fresh input.
     */
    inert?: boolean;
    /** Answer the head ask: approve just this call (`once`) or record a standing grant (`always`). */
    onApprove: (kind: "once" | "always") => void;
    /** Reject the head ask, optionally with feedback the model sees (omitted when the entry was empty). */
    onReject: (feedback?: string) => void;
    /**
     * Receives the prompt's own focusable renderable on mount. The host focuses it (the queueMicrotask
     * ref pattern) when an ask becomes active and restores composer focus when the queue drains — the
     * widget never grabs focus itself, it only hands the host the handle.
     */
    onFocusReady?: (r: BoxRenderable) => void;
};

/**
 * The docked approval prompt for a pending `ctx.ask`: a full-width, non-collapsing row painted with
 * the panel background so it can sit directly below the chat's flexGrow scrollbox (the 1-cell
 * scrollbox-bleed rule) without transcript content bleeding through its gaps.
 *
 * It is laid out as marker gutter + content column, the same fixed `size.gutter` the transcript
 * blocks above it align to, so the dock reads as one more block in that column rather than a
 * differently-indented strip. The caution glyph sits in that gutter — OUTSIDE the mode switch — for
 * two reasons: it marks the whole ask rather than decorating the title line, and holding it still
 * across both modes keeps the content from shifting horizontally as the user toggles with `n`/`esc`.
 *
 * It captures one decision at a time across two local modes:
 *   - **choice** — the box itself holds focus; bare `y` / `a` / `n` are approve-once, approve-always,
 *     and reject.
 *   - **feedback** — reached from `n`: a {@link TextInput} for optional reject feedback; enter submits
 *     (an empty entry means no feedback), esc returns to choice.
 *
 * Its ONE key layer is gated on the prompt's own focus `target` (the outer box, of which the feedback
 * input is a descendant), which is the only thing that makes bare printable keys legal — a layer that
 * can coexist with a focused editor must never bind bare printables. The bindings switch on mode so
 * feedback mode binds only esc, leaving every typed character to the input. Pure props + callbacks:
 * the widget knows nothing about the harness, the gateway, or the pending-asks store.
 */
export function AskPrompt(props: AskPromptProps): JSX.Element {
    // Seed-once: initialMode fixes the mount-time surface (the gallery exhibits feedback directly),
    // then live flow mutates it via keys — the prop is deliberately never re-read after mount.
    const [mode, setMode] = createSignal<PromptMode>(props.initialMode ?? "choice");
    // The prompt's focus target. A plain box is non-focusable by default, so it is opted in on mount
    // (below); focusing it is what activates the key layer, and it stays focused-within while the
    // feedback input — its descendant — holds focus.
    let boxRef: BoxRenderable | null = null;
    // For the choice-option click guard: reading the LIVE selection is how a drag-release is told from a
    // click (see onOptionClick). The same dependency run_block.tsx (also a components/ widget) takes.
    const renderer = useRenderer();

    function approve(kind: "once" | "always"): void {
        // busy = an answer is already in flight; swallow further presses until the gateway resolves.
        if (props.busy) return;
        props.onApprove(kind);
    }

    function enterFeedback(): void {
        if (props.busy) return;
        setMode("feedback");
    }

    function submitFeedback(value: string): void {
        if (props.busy) return;
        // An empty (or whitespace-only) entry means "reject, no feedback" — hand back undefined, not "".
        const trimmed = value.trim();
        props.onReject(trimmed.length > 0 ? trimmed : undefined);
    }

    function backToChoice(): void {
        setMode("choice");
        // The feedback input unmounts on this switch, dropping focus; hand it back to the box so the
        // choice-mode keys stay live (the renderable is not refocusable synchronously — microtask).
        queueMicrotask(() => boxRef?.focus());
    }

    // A click on a choice option routes into the SAME handler its key would (`approve`/`enterFeedback`),
    // so click and key can never drift — the `busy` gate lives inside those handlers and is inherited for
    // free. Two guards fire before it:
    //   - inert: a gallery exhibit must not answer. A click needs no focus, so the focus-target gate that
    //     neuters the bare keys does nothing here — without this an exhibit click on `n` flips it into
    //     feedback mode and its auto-focusing input steals the gallery pane's focus.
    //   - a live text selection: this runs on mouse-UP (never -down, which would fire the instant a
    //     selection drag STARTS over the row — an accidental command approval), and a drag that merely
    //     ENDS on an option fires that mouse-up too. Reading the renderer's LIVE selection distinguishes
    //     the two: a real click carries none. Read live, never press state remembered on mouse-down — a
    //     flag can outlive its gesture (the reasoning documented at run_block.tsx:226-234).
    function onOptionClick(action: "once" | "always" | "reject"): void {
        if (props.inert) return;
        if (renderer.getSelection()?.getSelectedText()) return;
        if (action === "reject") enterFeedback();
        else approve(action);
    }

    // ONE layer, gated on the prompt's focus target. Bare y/a/n are legal ONLY because of that gate:
    // in choice mode the box (never an editor) holds focus; in feedback mode the input is focused and
    // the layer binds solely esc, so every printable falls through to the input. Scoping the binding
    // set to the current mode means the wrong keys are never registered for the visible surface.
    useBindings(() => ({
        mode: MODE_BASE,
        target: boxRef,
        bindings:
            mode() === "choice"
                ? [
                      { chord: { key: "y" }, run: () => approve("once"), desc: "Approve", group: "Approval" },
                      { chord: { key: "a" }, run: () => approve("always"), desc: "Approve always", group: "Approval" },
                      { chord: { key: "n" }, run: enterFeedback, desc: "Reject", group: "Approval" },
                  ]
                : [{ chord: KEYS.escape, run: backToChoice, desc: "Back", group: "Approval" }],
    }));

    return (
        <box
            ref={(r: BoxRenderable) => {
                boxRef = r;
                // Boxes default to non-focusable; opt this one in so the host can focus it and the
                // target-gated key layer engages.
                r.focusable = true;
                props.onFocusReady?.(r);
            }}
            width="100%"
            flexShrink={0}
            flexDirection="row"
            backgroundColor={theme().bgRaised}
            paddingLeft={space.sm}
            paddingRight={space.sm}
        >
            {/* Fixed-width so the content column starts at the same indent on every row and in both
            modes; flexShrink={0} because a narrow terminal must squeeze the text, never the gutter. */}
            <box width={size.gutter} flexShrink={0}>
                <text>
                    <Fg role="warning">{GLYPHS.warning}</Fg>
                </text>
            </box>
            <box flexDirection="column" flexGrow={1}>
                <Show
                    when={mode() === "choice"}
                    fallback={
                        <>
                            <text>
                                <Fg role="fgMuted">{`Reject ${GLYPHS.emDash} add feedback (optional)`}</Fg>
                            </text>
                            <TextInput
                                chrome="compact"
                                placeholder="feedback"
                                autoFocus={!(props.inert ?? false)}
                                busy={props.busy}
                                onSubmit={(v: string) => submitFeedback(v)}
                            />
                            <text>
                                <Fg role="fgMuted">{`enter submit ${GLYPHS.middot} esc back`}</Fg>
                            </text>
                        </>
                    }
                >
                    {/* The title carries no color of its own — <Bold> is attribute-only, so without an
                    enclosing <Fg> it falls through to opentui's white default and vanishes on a light
                    theme's raised panel. */}
                    <text>
                        <Fg role="fg">
                            <Bold>{props.title}</Bold>
                        </Fg>
                    </text>
                    <text>
                        <Fg role="tool">
                            <Bold>{props.command}</Bold>
                        </Fg>
                    </text>
                    <Show when={props.detail}>
                        <text>
                            <Fg role="fgMuted">{props.detail}</Fg>
                        </text>
                    </Show>
                    {/* Each option is its own mouse target because opentui mouse handlers attach to
                    renderables, not inline spans — so the one hint <text> splits into a <text> per
                    option, the middot separators becoming their own muted <text> that carry the spacing.
                    The split is byte-for-byte the old single line: "y approve · a always · n reject". The
                    options are `selectable={false}` — they are buttons, not prose, so a press must not
                    highlight the label as if the click did something other than answer. */}
                    <box flexDirection="row">
                        <text selectable={false} onMouseUp={() => onOptionClick("once")}>
                            <Fg role="accent">
                                <Bold>y</Bold>
                            </Fg>
                            <Fg role="fgMuted"> approve</Fg>
                        </text>
                        <text>
                            <Fg role="fgMuted">{` ${GLYPHS.middot} `}</Fg>
                        </text>
                        <text selectable={false} onMouseUp={() => onOptionClick("always")}>
                            <Fg role="accent">
                                <Bold>a</Bold>
                            </Fg>
                            <Fg role="fgMuted"> always</Fg>
                        </text>
                        <text>
                            <Fg role="fgMuted">{` ${GLYPHS.middot} `}</Fg>
                        </text>
                        <text selectable={false} onMouseUp={() => onOptionClick("reject")}>
                            <Fg role="accent">
                                <Bold>n</Bold>
                            </Fg>
                            <Fg role="fgMuted"> reject</Fg>
                        </text>
                        <Show when={props.queuedCount > 0}>
                            <text>
                                <Fg role="fgSubtle">{`  +${props.queuedCount} more`}</Fg>
                            </text>
                        </Show>
                    </box>
                </Show>
            </box>
        </box>
    );
}
