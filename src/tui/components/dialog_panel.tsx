import { Show } from "solid-js";
import type { JSX } from "solid-js";

import { theme } from "../theme.ts";

/** A box dimension: a cell count, `"auto"`, or a percentage string — the subset opentui accepts. */
type Dimension = number | "auto" | `${number}%`;

/**
 * The shared chrome for every modal dialog: a bordered panel painted with the panel
 * background, an accent-colored title, and an optional muted footer-hint line rendered as
 * the last row. Pure presentation — it owns NO keyboard or focus, because list navigation,
 * input submit, and scroll differ per widget, so each composing dialog keeps its own
 * `useKeyboard` and focus-on-mount. Callers supply only the body via `children` plus the
 * panel size and footer text.
 */
export function DialogPanel(props: {
    /** Panel title, rendered in the border in the accent color. */
    title: string;
    /** Panel width — a percentage string (e.g. `"70%"`) or a cell count. */
    width: Dimension;
    /** Panel height; omit to size to content (the short prompt panel). */
    height?: Dimension;
    /** When true, adds top+bottom padding of 1 — breathing room for short panels. */
    padY?: boolean;
    /** The muted hint line shown as the last row (e.g. `"↑/↓ move · Enter select · Esc cancel"`). */
    footer?: string;
    /** The dialog body. */
    children: JSX.Element;
}): JSX.Element {
    return (
        <box
            width={props.width}
            height={props.height}
            flexDirection="column"
            backgroundColor={theme().bgPanel}
            border
            borderColor={theme().borderActive}
            title={props.title}
            titleColor={theme().accent}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={props.padY ? 1 : undefined}
            paddingBottom={props.padY ? 1 : undefined}
        >
            {props.children}
            <Show when={props.footer}>
                <text fg={theme().muted}>{props.footer}</text>
            </Show>
        </box>
    );
}
