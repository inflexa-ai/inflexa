import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { useBindings, chordLabel, KEYS, type Chord, type Sequence } from "../keymap.ts";

/**
 * The canonical vim scroll chords — the single source for ScrollPane's bindings and for any
 * footer/hint that names them (via {@link chordLabel}, never a hand-written key literal).
 * Arrows/page/home/end come from {@link KEYS} or are structural; only the vim letters live here.
 */
export const SCROLL_KEYS: { top: Sequence; bottom: Chord; down: Chord; up: Chord; halfDown: Chord; halfUp: Chord } = {
    top: [{ key: "g" }, { key: "g" }],
    bottom: { key: "g", shift: true },
    down: { key: "j" },
    up: { key: "k" },
    halfDown: { key: "d", ctrl: true },
    halfUp: { key: "u", ctrl: true },
};

/** Pre-derived footer hint for the scroll keys (`j/k scroll`) — mirrors `NEWLINE_LABEL`'s pattern. */
export const SCROLL_HINT: string = `${chordLabel(SCROLL_KEYS.down)}/${chordLabel(SCROLL_KEYS.up)} scroll`;

/** Props for {@link ScrollPane}. */
export type ScrollPaneProps = {
    /** Scrollable content. */
    children: JSX.Element;
    /**
     * Focus the pane on mount so its scroll keys are live immediately (default true — the dialog
     * pattern). The chat passes false: there the textarea owns focus and `esc` hands it to the pane.
     */
    focusOnMount?: boolean;
    /**
     * Receives the scrollbox renderable on mount — the imperative escape hatch (mirroring
     * `TextArea.onRef`) for hosts that focus the pane or scroll it programmatically.
     */
    onRef?: (r: ScrollBoxRenderable) => void;
    /** Keep the viewport pinned to newly appended content (the chat stream). */
    stickyScroll?: boolean;
    /** Which edge stickyScroll pins to. */
    stickyStart?: "bottom" | "top";
    /** Flex growth inside the host's column/row. */
    flexGrow?: number;
    /** Minimum height (pass 0 to let a flex column shrink the pane instead of its siblings). */
    minHeight?: number;
    /** Fixed pane height when the host knows its content row count. */
    height?: number;
    /** Pane width. */
    width?: number | `${number}%`;
    /** Enable horizontal overflow and its scrollbar. */
    scrollX?: boolean;
    /** Enable vertical overflow; defaults to opentui's `true`. */
    scrollY?: boolean;
    /** Inner padding. */
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
};

/**
 * The single scroll surface — the ONLY place `<scrollbox>` is composed in the TUI. An
 * **uncontrolled** scrollbox whose scroll position lives in the renderable and whose keyboard
 * handling lives in an internal, focus-gated keymap layer — hosts render children into it with
 * zero keymap wiring. Keys are live exactly while the pane (or a descendant) is focused, so with
 * several panes mounted, focus picks which one scrolls.
 *
 * Cursor-driven hosts (the `FixedList`/`DynamicList` primitives, the config screen's section
 * nav) — where keys move a
 * selection cursor and `scrollChildIntoView` follows — compose it too, but with
 * `focusOnMount={false}` and nothing ever focusing the pane: the key layer never engages, so
 * their cursor semantics are untouched and they still get the one scrollbox wrapper.
 */
export function ScrollPane(props: ScrollPaneProps): JSX.Element {
    let ref: ScrollBoxRenderable | null = null;

    // scrollTo(scrollHeight) clamps to the max scroll AND re-engages stickyScroll's bottom
    // stickiness, so on a sticky pane G/end resume following newly appended content.
    function toBottom(): void {
        if (ref) ref.scrollTo(ref.scrollHeight);
    }
    function toTop(): void {
        ref?.scrollTo(0);
    }

    // The canonical scroll layer. `target` re-reads `ref` per keystroke, so gating engages as soon
    // as the scrollbox mounts. No `mode` gate: a pane inside a dialog must stay live under
    // MODE_MODAL, and focus already arbitrates chat-vs-dialog ownership (opening a dialog blurs the
    // previously focused widget). The set deliberately covers EVERY chord opentui's native
    // focused-scrollbox handler answers (j/k/arrows, pgup/pgdn, home/end): a matched binding
    // preventDefaults, which is what suppresses the native handler — binding the full set keeps its
    // 1/5-viewport steps from leaking through on a key we miss.
    useBindings(() => ({
        target: ref,
        bindings: [
            { chord: SCROLL_KEYS.top, run: toTop, desc: "Scroll to top", group: "Scroll" },
            { chord: SCROLL_KEYS.bottom, run: toBottom, desc: "Scroll to bottom", group: "Scroll" },
            { chord: SCROLL_KEYS.down, run: () => ref?.scrollBy(1), desc: "Scroll down", group: "Scroll" },
            { chord: SCROLL_KEYS.up, run: () => ref?.scrollBy(-1), desc: "Scroll up", group: "Scroll" },
            { chord: KEYS.down, run: () => ref?.scrollBy(1) },
            { chord: KEYS.up, run: () => ref?.scrollBy(-1) },
            { chord: SCROLL_KEYS.halfDown, run: () => ref?.scrollBy(0.5, "viewport"), desc: "Half page down", group: "Scroll" },
            { chord: SCROLL_KEYS.halfUp, run: () => ref?.scrollBy(-0.5, "viewport"), desc: "Half page up", group: "Scroll" },
            { chord: KEYS.pageDown, run: () => ref?.scrollBy(1, "viewport"), desc: "Page down", group: "Scroll" },
            { chord: KEYS.pageUp, run: () => ref?.scrollBy(-1, "viewport"), desc: "Page up", group: "Scroll" },
            { chord: { key: "end" }, run: toBottom },
            { chord: { key: "home" }, run: toTop },
        ],
    }));

    return (
        <scrollbox
            ref={(r: ScrollBoxRenderable) => {
                ref = r;
                // Focus via microtask — the renderable isn't ready synchronously (the standard pattern).
                if (props.focusOnMount ?? true) queueMicrotask(() => r.focus());
                props.onRef?.(r);
            }}
            flexGrow={props.flexGrow}
            minHeight={props.minHeight}
            height={props.height}
            width={props.width}
            scrollX={props.scrollX}
            scrollY={props.scrollY}
            stickyScroll={props.stickyScroll}
            stickyStart={props.stickyStart}
            paddingTop={props.paddingTop}
            paddingBottom={props.paddingBottom}
            paddingLeft={props.paddingLeft}
            paddingRight={props.paddingRight}
        >
            {props.children}
        </scrollbox>
    );
}
