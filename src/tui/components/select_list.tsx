import { randomUUIDv7 } from "bun";
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";

import { theme } from "../theme.ts";
import { DialogPanel } from "./dialog_panel.tsx";

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

// Score a subsequence match of `query` against `target`: -1 for no match, else higher is
// better. Consecutive hits and an early first hit are rewarded so "op" ranks "Open…" above a
// scattered match. Case-insensitive; an empty query is a neutral 0 (everything matches).
function subsequenceScore(query: string, target: string): number {
    if (query === "") return 0;
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    let qi = 0;
    let score = 0;
    let streak = 0;
    let last = -2;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            streak = ti === last + 1 ? streak + 1 : 1;
            score += streak + (ti === 0 ? 5 : 0);
            last = ti;
            qi++;
        }
    }
    return qi === q.length ? score : -1;
}

// Rank items by a fuzzy match, weighting a title hit 2x over a category-only hit. An empty
// query preserves the caller's order (so category grouping stays contiguous).
function rankItems<T>(items: SelectItem<T>[], query: string): SelectItem<T>[] {
    const q = query.trim();
    if (q === "") return items;
    const scored: Array<{ item: SelectItem<T>; score: number; i: number }> = [];
    items.forEach((item, i) => {
        const titleScore = subsequenceScore(q, item.title);
        const catScore = subsequenceScore(q, item.category ?? "");
        let score = -1;
        if (titleScore >= 0) score = titleScore * 2 + (catScore >= 0 ? catScore : 0);
        else if (catScore >= 0) score = catScore;
        if (score >= 0) scored.push({ item, score, i });
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.map((s) => s.item);
}

/**
 * A searchable, keyboard-navigable list — the shared engine behind the command palette and
 * every picker. Filters with the inline fuzzy scorer, groups by category when unfiltered,
 * and keeps the highlighted row scrolled into view. It owns its keyboard; because only the
 * top dialog is mounted (see `App`'s dialog host), it is always the active handler.
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

    const ranked = createMemo(() => rankItems(props.items, query()));
    const isGrouped = (): boolean => props.grouped === true && query().trim() === "";

    type Row = { kind: "header"; label: string } | { kind: "item"; item: SelectItem<T>; idx: number };
    const rows = createMemo<Row[]>(() => {
        const out: Row[] = [];
        let lastCat: string | undefined;
        ranked().forEach((item, i) => {
            if (isGrouped() && item.category && item.category !== lastCat) {
                out.push({ kind: "header", label: item.category });
                lastCat = item.category;
            }
            out.push({ kind: "item", item, idx: i });
        });
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

    useKeyboard((key) => {
        if (key.name === "escape") {
            props.onCancel();
            return;
        }
        if (key.name === "up" || (key.ctrl && key.name === "p")) {
            setCursor((i) => Math.max(0, i - 1));
            return;
        }
        if (key.name === "down" || (key.ctrl && key.name === "n")) {
            setCursor((i) => Math.min(ranked().length - 1, i + 1));
            return;
        }
        if (key.name === "return") {
            const item = ranked()[cursor()];
            if (item) props.onSelect(item.value);
        }
    });

    return (
        <DialogPanel title={props.title} width="70%" height="60%" footer="↑/↓ move · Enter select · Esc cancel">
            <input
                ref={(r: InputRenderable) => {
                    inputRef = r;
                }}
                focused
                width="100%"
                placeholder={props.placeholder ?? "Type to filter…"}
                placeholderColor={theme().muted}
                textColor={theme().fg}
                backgroundColor={theme().bg}
                focusedBackgroundColor={theme().bgFocused}
                onInput={(v) => {
                    setQuery(v);
                    setCursor(0);
                }}
            />
            <scrollbox
                ref={(r: ScrollBoxRenderable) => {
                    scrollRef = r;
                }}
                flexGrow={1}
                width="100%"
                paddingTop={1}
            >
                <Show when={ranked().length > 0} fallback={<text fg={theme().muted}>{props.emptyText}</text>}>
                    <For each={rows()}>
                        {(row) =>
                            row.kind === "header" ? (
                                <text fg={theme().muted} attributes={1}>
                                    {row.label}
                                </text>
                            ) : (
                                <box
                                    id={`${lid}-${row.idx}`}
                                    width="100%"
                                    flexDirection="row"
                                    backgroundColor={row.idx === cursor() ? theme().bgFocused : undefined}
                                >
                                    <text fg={row.idx === cursor() ? theme().selected : theme().fg}>
                                        {row.idx === cursor() ? "› " : "  "}
                                        {row.item.title}
                                    </text>
                                    <Show when={row.item.hint}>
                                        <text fg={theme().muted}> {row.item.hint}</text>
                                    </Show>
                                </box>
                            )
                        }
                    </For>
                </Show>
            </scrollbox>
            <Show when={ranked()[cursor()]?.description}>
                <text fg={theme().muted}>{ranked()[cursor()]!.description}</text>
            </Show>
        </DialogPanel>
    );
}
