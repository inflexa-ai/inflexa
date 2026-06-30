import { Show } from "solid-js";
import type { JSX } from "solid-js";

import { dialogSize, type DialogSize } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";

/**
 * The shared chrome for every modal dialog: a bordered panel painted with the panel
 * background, an optional accent-colored title, and an optional muted footer-hint line rendered as
 * the last row. Pure presentation — it owns NO keyboard or focus, because list navigation,
 * input submit, and scroll differ per widget, so each composing dialog declares its own keymap
 * layer (`useBindings`) and focus-on-mount. Callers supply only the body via `children` plus the
 * panel size and footer text.
 *
 * Sizing comes from the {@link dialogSize} design-system constant — no raw width/height escape
 * hatches. The three tiers (`md`/`lg`/`xl`) cover every dialog shape: content-height prompts,
 * tall pickers, and full-screen showcases.
 */
export function DialogPanel(props: {
    /** Panel title, rendered in the border in the accent color. Optional — omit for an untitled bordered panel. */
    title?: string;
    /** Named size preset from the design system — `md` (prompt), `lg` (picker), or `xl` (showcase). */
    size: DialogSize;
    /** When true, adds top+bottom padding of 1 — breathing room for short panels. */
    padY?: boolean;
    /** The muted hint line shown as the last row (e.g. `"↑/↓ move · Enter select · Esc cancel"`). */
    footer?: string;
    /** The dialog body. */
    children: JSX.Element;
}): JSX.Element {
    const dims = () => dialogSize[props.size];

    return (
        <box
            width={dims().width}
            height={dims().height}
            flexDirection="column"
            backgroundColor={theme().bgRaised}
            border
            borderColor={theme().borderFocus}
            title={props.title}
            titleColor={props.title ? theme().accent : undefined}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={props.padY ? 1 : undefined}
            paddingBottom={props.padY ? 1 : undefined}
        >
            {props.children}
            <Show when={props.footer}>
                <box width="100%" flexShrink={0} backgroundColor={theme().bgRaised}>
                    <text fg={theme().fgMuted}>{props.footer}</text>
                </box>
            </Show>
        </box>
    );
}
