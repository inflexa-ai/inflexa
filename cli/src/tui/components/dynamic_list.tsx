import type { JSX } from "solid-js";

import { ListCore, type ListProps, type SelectItem } from "./list_core.tsx";

/** Props for {@link FixedList}'s reactive sibling: items are tracked, not read once. */
export type DynamicListProps<T> = ListProps<T> & {
    /** The current row set — reactive; replace it freely (directory listings, live queries). */
    items: readonly SelectItem<T>[];
};

/**
 * The list primitive for a changing row set. Sources like directory listings mint fresh item
 * objects on every update, where reference-keyed rendering would tear down and rebuild every row —
 * so rows render with `<Index>` (position-keyed): slots update their content in place. Pure list —
 * no chrome, no input, no esc; see `list_core.tsx`.
 */
export function DynamicList<T>(props: DynamicListProps<T>): JSX.Element {
    return <ListCore {...props} strategy="index" />;
}
