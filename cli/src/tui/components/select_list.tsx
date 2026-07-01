import { randomUUIDv7 } from "bun";
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";

import { rankBy } from "../../lib/fuzzy.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { useBindings, KEYS, chordLabel } from "../keymap.ts";
import { DialogPanel } from "./dialog/dialog_panel.tsx";
import { Bold } from "./emphasis.tsx";
import { TextInput } from "./text_input.tsx";
import { ScrollPane } from "./scroll_pane.tsx";

// The reusable searchable list: a single fuzzy-filtered, keyboard-navigable, grouped picker
// shared by the command palette and every dialog picker (themes, analyses, sessions). It is
// generic over the chosen value `T` and knows nothing about commands — callers map their data
// to `SelectItem<T>` and handle `onSelect`. Lives in `components/` because it now has callers
// in more than one file (the palette and the command pickers).

/** A selectable row in {@link SelectList}. */
export type SelectItem<T> = {
    /** The value handed to `onSelect` when this row is chosen. */
    value: T;
    /** The primary label, the main fuzzy-match target. */
    title: string;
    /** Optional detail shown for the highlighted row. */
    description?: string;
    /** Optional right-aligned hint (e.g. a keybind). */
    hint?: string;
    /** Optional group header; rows sharing a category are listed under it when unfiltered. */
    category?: string;
};

/**
 * A searchable, keyboard-navigable list — the shared engine behind the command palette and
 * every picker. Filters with the shared `rankBy` fuzzy ranker (weighting a title hit 2× over a
 * category-only hit), groups by category when unfiltered, and keeps the highlighted row scrolled
 * into view. It owns its keyboard; because only the top dialog is mounted (see `App`'s dialog
 * host), it is always the active handler.
 */
export function SelectList<T>(props: {
    title: string;
    placeholder?: string;
    items: SelectItem<T>[];
    emptyText: string;
    grouped?: boolean;
    onSelect: (value: T) => void;
    onCancel: () => void;
}): JSX.Element {
    // Unique per instance so row ids never collide across nested/sibling lists.
    const lid = randomUUIDv7();
    const [query, setQuery] = createSignal("");
    const [cursor, setCursor] = createSignal(0);
    let inputRef: InputRenderable | null = null;
    let scrollRef: ScrollBoxRenderable | null = null;

    const ranked = createMemo(() =>
        rankBy(props.items, query(), [
            { get: (item) => item.title, weight: 2 },
            { get: (item) => item.category ?? "", weight: 1 },
        ]),
    );
    const isGrouped = (): boolean => props.grouped === true && query().trim() === "";

    type Row = { kind: "header"; label: string } | { kind: "item"; item: SelectItem<T>; idx: number };
    const rows = createMemo<Row[]>(() => {
        const out: Row[] = [];
        let lastCat: string | undefined;
        for (const [i, item] of ranked().entries()) {
            if (isGrouped() && item.category && item.category !== lastCat) {
                out.push({ kind: "header", label: item.category });
                lastCat = item.category;
            }
            out.push({ kind: "item", item, idx: i });
        }
        return out;
    });

    // Keep the cursor valid as filtering shrinks the set.
    createEffect(() => {
        const n = ranked().length;
        if (cursor() > n - 1) setCursor(Math.max(0, n - 1));
    });
    // Keep the highlighted row visible.
    createEffect(() => {
        const i = cursor();
        scrollRef?.scrollChildIntoView(`${lid}-${i}`);
    });

    // The renderable isn't ready synchronously; grab focus on the next microtask.
    onMount(() => queueMicrotask(() => inputRef?.focus()));

    function up(): void {
        setCursor((i) => Math.max(0, i - 1));
    }
    function down(): void {
        setCursor((i) => Math.min(ranked().length - 1, i + 1));
    }
    function select(): void {
        const item = ranked()[cursor()];
        if (item) props.onSelect(item.value);
    }

    // No `mode`, so this layer stays live while the host's MODE_BASE keys are suspended. The two
    // emacs-style alternates (ctrl+p/ctrl+n) bind to the same actions as the arrows.
    useBindings(() => ({
        bindings: [
            { chord: KEYS.escape, run: () => props.onCancel() },
            { chord: KEYS.up, run: up },
            { chord: KEYS.prevAlt, run: up },
            { chord: KEYS.down, run: down },
            { chord: KEYS.nextAlt, run: down },
            { chord: KEYS.enter, run: select },
        ],
    }));

    return (
        <DialogPanel
            title={props.title}
            size="lg"
            footer={`${chordLabel(KEYS.up)}/${chordLabel(KEYS.down)} move ${GLYPHS.middot} ${chordLabel(KEYS.enter)} select ${GLYPHS.middot} ${chordLabel(KEYS.escape)} cancel`}
        >
            <TextInput
                chrome="bare"
                placeholder={props.placeholder ?? `Type to filter${GLYPHS.ellipsis}`}
                onRef={(r: InputRenderable) => {
                    inputRef = r;
                }}
                onInput={(v) => {
                    setQuery(v);
                    setCursor(0);
                }}
            />
            {/* Never focused (the filter TextInput holds focus), so ScrollPane's scroll keys stay
            dead — the pane is just the shared scrollbox wrapper; the cursor drives scrolling. */}
            <ScrollPane
                focusOnMount={false}
                onRef={(r: ScrollBoxRenderable) => {
                    scrollRef = r;
                }}
                flexGrow={1}
                width="100%"
                paddingTop={1}
            >
                <Show when={ranked().length > 0} fallback={<text fg={theme().fgMuted}>{props.emptyText}</text>}>
                    <For each={rows()}>
                        {(row) =>
                            row.kind === "header" ? (
                                <text fg={theme().fgMuted}>
                                    <Bold>{row.label}</Bold>
                                </text>
                            ) : (
                                <box
                                    id={`${lid}-${row.idx}`}
                                    width="100%"
                                    flexDirection="row"
                                    backgroundColor={row.idx === cursor() ? theme().bgActive : undefined}
                                >
                                    <text fg={row.idx === cursor() ? theme().secondary : theme().fg}>
                                        {row.idx === cursor() ? `${GLYPHS.chevronRight} ` : "  "}
                                        {row.item.title}
                                    </text>
                                    <Show when={row.item.hint}>
                                        <text fg={theme().fgMuted}> {row.item.hint}</text>
                                    </Show>
                                </box>
                            )
                        }
                    </For>
                </Show>
            </ScrollPane>
            <Show when={ranked()[cursor()]?.description}>
                <box width="100%" flexShrink={0} backgroundColor={theme().bgRaised}>
                    <text fg={theme().fgMuted}>{ranked()[cursor()]!.description}</text>
                </box>
            </Show>
        </DialogPanel>
    );
}
