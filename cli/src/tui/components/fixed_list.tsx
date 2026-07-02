import type { JSX } from "solid-js";

import { ListCore, type ListProps, type SelectItem } from "./list_core.tsx";

/** Props for {@link FixedList}: the shared list surface over an immutable items reference. */
export type FixedListProps<T> = ListProps<T> & {
    /**
     * The full row set, fixed for the component's lifetime. Read ONCE at mount — replacing the
     * array later has no effect (use {@link DynamicList} for changing sources). `readonly` is the
     * type-level half of the contract; the read-once mount semantic is the behavioral half.
     */
    items: readonly SelectItem<T>[];
};

/**
 * The list primitive for a fixed row set (pickers over known data: themes, commands, sessions).
 * Because item references are stable for its lifetime, rows render with `<For>` (reference-keyed):
 * filtering reuses and moves surviving rows instead of re-creating them. Pure list — no chrome,
 * no input, no esc; see `list_core.tsx`.
 */
export function FixedList<T>(props: FixedListProps<T>): JSX.Element {
    // eslint-disable-next-line solid/reactivity -- seed-once: the read-once mount semantic IS FixedList's contract (documented on `items`)
    const items = props.items;
    return <ListCore {...props} items={items} strategy="for" />;
}
