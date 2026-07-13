import { randomUUIDv7 } from "bun";
import { createEffect, createMemo, createSignal, For, Index, on, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { rankBy } from "../../lib/fuzzy.ts";
import { GLYPHS, space } from "../../lib/design_system.ts";
import { theme } from "../theme.ts";
import { KEYS } from "../keymap.ts";
import { useDialogBindings } from "./dialog/dialog_host.tsx";
import { Bold } from "./emphasis.tsx";
import { ScrollPane } from "./scroll_pane.tsx";

// The shared engine behind FixedList and DynamicList — its ONLY two callers. Hosts never mount
// ListCore directly: the public contracts (read-once vs reactive items, <For> vs <Index>) live on
// the wrappers; this file owns everything the contracts share (ranking, grouping, cursor,
// selection, rendering, keys). The `SelectItem`/`SelectMode` types are imported from here by
// hosts — types are the one public surface of this file.
//
// A list is ONLY a list: no dialog chrome, no filter input (hosts own a TextInput and pass its
// value as `query`), and no esc binding (dismissal is the dialog host's structural concern).

/** Selection mode: `single` = enter selects-and-submits; `multi` = space toggles, enter confirms. */
export type SelectMode = "single" | "multi";

/**
 * A selectable row. Fields are `readonly` — the enforceable half of FixedList's "immutable
 * reference" contract (the other half is FixedList's read-once mount semantic).
 */
export type SelectItem<T> = {
    /** The value handed to `onSelect`/`onConfirm` when this row is chosen. */
    readonly value: T;
    /** The primary label, the main fuzzy-match target. */
    readonly title: string;
    /** Optional detail shown for the cursor row in the list's bottom detail line. */
    readonly description?: string;
    /** Optional right-aligned muted hint (e.g. a keybind). */
    readonly hint?: string;
    /** Optional group label; rows sharing a category render under one header, surviving filtering. */
    readonly category?: string;
};

/** The props both list primitives share — see {@link FixedList}/{@link DynamicList} for the items contract. */
export type ListProps<T> = {
    /** Reactive filter text from the host's input. Empty/absent renders items in given order. */
    query?: string;
    /** Muted fallback line when no rows survive filtering. */
    emptyText: string;
    /** Warning-colored substitute for `emptyText` (e.g. an unreadable directory). */
    errorText?: string | null;
    /** Selection mode, default `"single"`. */
    mode?: SelectMode;
    /** Multi mode: values rendered pre-selected (●) on mount. Read once. */
    initialSelected?: ReadonlySet<T>;
    /** Single mode: the cursor row was chosen (enter) — select-and-submit in one stroke. */
    onSelect?: (value: T) => void;
    /** Multi mode: the batch was confirmed (enter). */
    onConfirm?: (values: T[]) => void;
    /**
     * Pre-submit interceptor: runs before the default enter behavior in EITHER mode; returning
     * `true` suppresses it (the file picker descends into directories this way).
     */
    onAction?: (value: T) => boolean;
    /** Multi mode: fired after every toggle with the new selection. */
    onSelectionChange?: (values: ReadonlySet<T>) => void;
    /** Multi mode: return `false` to refuse toggling a value (a navigation-only row like `..`). */
    canToggle?: (value: T) => boolean;
    /** Fired when the cursor row changes (`undefined` when the list empties). Hosts that act on
     *  the highlighted row outside the list's own keys (open-in-explorer) mirror it from here. */
    onCursorChange?: (value: T | undefined) => void;
    /** Gate for the whole key layer (default true). */
    enabled?: boolean;
    /**
     * Gate for the bare-printable bindings alone — space-toggle (multi) and the vim cursor keys
     * (j/k/gg/G) — default true. Hosts whose filter input can hold focus MUST pass `!inputFocused`
     * here: the keymap dispatches before the focused editor, so an enabled bare-key binding would
     * steal typed characters (the bare-printable-key rule).
     */
    bareKeysEnabled?: boolean;
};

type ListCoreProps<T> = ListProps<T> & {
    items: readonly SelectItem<T>[];
    /**
     * `for` keys rows by item reference — correct when references are stable across updates
     * (FixedList). `index` keys rows by position — correct when updates mint fresh objects
     * (DynamicList). See HORRIBLE_BUG_FIXES.md entry 1 for why this choice is guarded by
     * `for_scrollbox.render.test.tsx`.
     */
    strategy: "for" | "index";
    /**
     * When set, single-step cursor movement (arrows, ctrl+p/n, j/k) wraps between the first and
     * last rows instead of stopping at them: stepping down off the bottom lands on the top, up
     * off the top on the bottom. Enabled only for a fixed row set, whose ends are stable, so
     * wrapping is a predictable convenience. A reactive source stays clamping — its rows can
     * refilter out from under the cursor, and a wrap there would fling it to a disorienting far
     * end. Page jumps (`moveBy`) and `gg`/`G` clamp regardless.
     */
    wrapNavigation?: boolean;
};

/** Flat position + the header this row must render above itself (it starts a category group). */
type RowMeta = { index: number; header: string | null };

export function ListCore<T>(props: ListCoreProps<T>): JSX.Element {
    // Unique per instance so row ids never collide across stacked/sibling lists.
    const lid = randomUUIDv7();
    const [cursor, setCursor] = createSignal(0);
    // Seed-once: initialSelected is a mount-time seed; the live set is owned here.
    const [selected, setSelected] = createSignal<ReadonlySet<T>>(new Set<T>(props.initialSelected ?? []));
    let scrollRef: ScrollBoxRenderable | null = null;

    const mode = (): SelectMode => props.mode ?? "single";

    const ranked = createMemo<readonly SelectItem<T>[]>(() => {
        const q = (props.query ?? "").trim();
        if (q === "") return props.items;
        return rankBy(props.items, q, [
            { get: (it) => it.title, weight: 2 },
            { get: (it) => it.category ?? "", weight: 1 },
        ]);
    });

    // The grouped [category, items[]][] projection, derived AFTER ranking so a category keeps its
    // header while any of its items survive the filter. Group order = first appearance in ranked
    // order (the best-ranked group rises); uncategorized rows group under "" and get no header.
    const grouped = createMemo<[string, SelectItem<T>[]][]>(() => {
        const m = new Map<string, SelectItem<T>[]>();
        for (const it of ranked()) {
            const key = it.category ?? "";
            const arr = m.get(key);
            if (arr) arr.push(it);
            else m.set(key, [it]);
        }
        return [...m.entries()];
    });

    // What the cursor indexes. Same-category rows are contiguous here by construction.
    const flat = createMemo<SelectItem<T>[]>(() => grouped().flatMap(([, items]) => items));

    // Per-row flat position + group-start header, one O(n) pass instead of per-row indexOf. The
    // header renders INSIDE the row's own box, so scrollChildIntoView on the row brings its
    // header along — no separate header-visibility dance.
    const meta = createMemo<Map<SelectItem<T>, RowMeta>>(() => {
        const m = new Map<SelectItem<T>, RowMeta>();
        let prev = "";
        for (const [i, it] of flat().entries()) {
            const cat = it.category ?? "";
            m.set(it, { index: i, header: cat !== "" && cat !== prev ? cat : null });
            prev = cat;
        }
        return m;
    });

    // Stable per-item ids for the `for` strategy (a row's id must never change once registered —
    // opentui parents map children by id). The `index` strategy uses per-slot ids instead, since
    // there the SLOT is the stable thing and the item is what changes.
    const idOf = createMemo<Map<SelectItem<T>, string>>(() => {
        const m = new Map<SelectItem<T>, string>();
        for (const [i, it] of props.items.entries()) m.set(it, `${lid}-${i}`);
        return m;
    });

    // A new query moves the cursor to the best match (row 0), and a replaced items array (a
    // DynamicList source turning over, e.g. directory navigation) starts the new listing from the
    // top; the clamp below covers shrinks that happen without either.
    createEffect(on([() => props.query, () => props.items], () => setCursor(0), { defer: true }));
    createEffect(() => {
        const n = flat().length;
        setCursor((i) => (n === 0 ? 0 : Math.min(i, n - 1)));
    });
    createEffect(() => {
        const i = cursor();
        const it = flat()[i];
        if (!it) return;
        scrollRef?.scrollChildIntoView(props.strategy === "for" ? (idOf().get(it) ?? "") : `${lid}-slot-${i}`);
    });
    createEffect(() => props.onCursorChange?.(flat()[cursor()]?.value));

    function up(): void {
        setCursor((i) => {
            const n = flat().length;
            if (n === 0) return 0;
            return props.wrapNavigation ? (i - 1 + n) % n : Math.max(0, i - 1);
        });
    }
    function down(): void {
        setCursor((i) => {
            const n = flat().length;
            if (n === 0) return 0;
            return props.wrapNavigation ? (i + 1) % n : Math.min(n - 1, i + 1);
        });
    }
    function moveBy(delta: number): void {
        setCursor((i) => Math.max(0, Math.min(flat().length - 1, i + delta)));
    }
    function toggle(): void {
        const it = flat()[cursor()];
        if (!it) return;
        if (props.canToggle && !props.canToggle(it.value)) return;
        const next = new Set(selected());
        if (next.has(it.value)) next.delete(it.value);
        else next.add(it.value);
        setSelected(next);
        props.onSelectionChange?.(next);
    }
    function submit(): void {
        const it = flat()[cursor()];
        // Multi mode confirms the accumulated BATCH, which outlives the visible rows (a filter
        // matching nothing, an empty/unreadable folder) — enter must still hand it back rather
        // than stranding a selection made elsewhere. Single mode has nothing to submit without
        // a cursor row.
        if (!it) {
            if (mode() === "multi") props.onConfirm?.([...selected()]);
            return;
        }
        if (props.onAction?.(it.value)) return;
        if (mode() === "single") props.onSelect?.(it.value);
        else props.onConfirm?.([...selected()]);
    }

    // Dialog-gated so a stacked dialog suspends these keys (and outside any dialog they suspend
    // while one covers the screen). The thunk re-reads `enabled`/`bareKeysEnabled`/`mode` per
    // keystroke — that lazy re-evaluation is the layer's reactivity. Non-printable keys only:
    // these stay live while a host's filter input is focused (arrows/enter/page keys don't
    // collide with typing).
    useDialogBindings(() => ({
        enabled: props.enabled ?? true,
        bindings: [
            { chord: KEYS.up, run: up },
            { chord: KEYS.prevAlt, run: up },
            { chord: KEYS.down, run: down },
            { chord: KEYS.nextAlt, run: down },
            { chord: KEYS.pageUp, run: () => moveBy(-10) },
            { chord: KEYS.pageDown, run: () => moveBy(10) },
            { chord: KEYS.enter, run: submit },
        ],
    }));
    // The bare-printable layer: vim cursor keys (same physical vocabulary as ScrollPane's scroll
    // keys, but a different feature — they move the CURSOR, so they are declared here, not
    // borrowed from SCROLL_KEYS) plus space-toggle in multi mode. Gated off whenever a focused
    // editor could receive these as characters.
    useDialogBindings(() => ({
        enabled: (props.enabled ?? true) && (props.bareKeysEnabled ?? true),
        bindings: [
            { chord: { key: "j" }, run: down, desc: "Next item", group: "List" },
            { chord: { key: "k" }, run: up, desc: "Previous item", group: "List" },
            { chord: [{ key: "g" }, { key: "g" }], run: () => setCursor(0), desc: "First item", group: "List" },
            { chord: { key: "g", shift: true }, run: () => setCursor(Math.max(0, flat().length - 1)), desc: "Last item", group: "List" },
            ...(mode() === "multi" ? [{ chord: KEYS.space, run: toggle, desc: "Toggle selection", group: "List" }] : []),
        ],
    }));

    // One row: an id-bearing column box (optional group header + the row line), so the scroll
    // effect can bring header and row into view as one child. Everything reads through accessors —
    // <Index> runs each slot body ONCE, so captured plain values would never update.
    function renderRow(item: () => SelectItem<T>, id: () => string): JSX.Element {
        const rowMeta = (): RowMeta | undefined => meta().get(item());
        const isCursor = (): boolean => rowMeta()?.index === cursor();
        const isSel = (): boolean => mode() === "multi" && selected().has(item().value);
        // A row canToggle refuses gets NO gutter (blank keeps column alignment): its value may
        // coincidentally sit in the selection (`..` shares the parent dir's path), and painting
        // ● on a row space refuses to clear would lie about what confirm hands back.
        const gutter = (): string => ((props.canToggle?.(item().value) ?? true) ? `${isSel() ? GLYPHS.circle : GLYPHS.circleHollow} ` : "  ");
        return (
            <box id={id()} width="100%" flexDirection="column">
                <Show when={rowMeta()?.header}>
                    <text fg={theme().fgMuted}>
                        <Bold>{rowMeta()?.header ?? ""}</Bold>
                    </text>
                </Show>
                <box width="100%" flexDirection="row" backgroundColor={isCursor() ? theme().bgActive : undefined}>
                    <Show when={mode() === "multi"}>
                        <text fg={isSel() ? theme().success : theme().fgSubtle}>{gutter()}</text>
                    </Show>
                    <text fg={isCursor() ? theme().secondary : theme().fg}>
                        {mode() === "single" ? (isCursor() ? `${GLYPHS.chevronRight} ` : "  ") : ""}
                        {item().title}
                    </text>
                    <Show when={item().hint}>
                        <text fg={theme().fgMuted}> {item().hint}</text>
                    </Show>
                </box>
            </box>
        );
    }

    return (
        <>
            {/* No paddingTop: padding inside a scrollbox is scrollable content, so any top pad
                scrolls away on the first scroll and never returns (scrollChildIntoView back to row 0
                stops at the content top, not the pad). Separation above the list is static chrome the
                host paints OUTSIDE this surface, never scrollbox padding. */}
            <ScrollPane
                focusOnMount={false}
                onRef={(r: ScrollBoxRenderable) => {
                    scrollRef = r;
                }}
                flexGrow={1}
                width="100%"
                minHeight={0}
            >
                <Show
                    when={flat().length > 0}
                    fallback={<text fg={props.errorText ? theme().warning : theme().fgMuted}>{props.errorText ?? props.emptyText}</text>}
                >
                    {/* strategy is fixed per wrapper (never changes after mount), so a plain ternary
                        — not a <Show> — picks the loop component once. */}
                    {/* eslint-disable solid/reactivity -- false positives on the loop callbacks: For's `item` is a per-node constant (thunked deliberately so renderRow gets one accessor shape), and Index's `item` IS the accessor renderRow tracks */}
                    {props.strategy === "for" ? (
                        <For each={flat()}>
                            {(item) =>
                                renderRow(
                                    () => item,
                                    () => idOf().get(item) ?? "",
                                )
                            }
                        </For>
                    ) : (
                        <Index each={flat()}>{(item, i) => renderRow(item, () => `${lid}-slot-${i}`)}</Index>
                    )}
                    {/* eslint-enable solid/reactivity */}
                </Show>
            </ScrollPane>
            {/* Full-width painted box, not a bare <text>: a fixed row directly below a flexGrow
                scrollbox must opaquely reclaim its row (the yoga one-cell overlap quirk). The
                breathing-room paddingTop lives INSIDE this painted box on purpose — a transparent gap
                row above it would let the scrollbox bleed show through; the painted pad row reclaims
                the bled cell instead. */}
            <Show when={flat()[cursor()]?.description}>
                <box width="100%" flexShrink={0} paddingTop={space.sm} backgroundColor={theme().bgRaised}>
                    <text fg={theme().fgMuted}>{flat()[cursor()]?.description ?? ""}</text>
                </box>
            </Show>
        </>
    );
}
