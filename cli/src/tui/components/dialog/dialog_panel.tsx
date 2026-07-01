import { Show } from "solid-js";
import type { JSX } from "solid-js";

import { dialogSize, stroke, type DialogSize } from "../../../lib/design_system.ts";
import { theme } from "../../theme.ts";
import { dialogPanelMouseDown, dialogPanelMouseUp } from "./dialog_host.tsx";

/**
 * The shared chrome for every modal dialog: a bordered panel painted with the panel
 * background, an optional accent-colored title, and an optional muted footer-hint line rendered as
 * the last row. It owns NO keyboard or focus — list navigation, input submit, and scroll differ
 * per widget, so each composing dialog declares its own keymap layer (via the dialog host's
 * `useDialogBindings`) and the host applies focus. Its ONE behavior is click containment
 * (`dialogPanelMouseDown/Up`): the panel is the only element that knows its own bounds, so it
 * stops mouse propagation to the overlay's click-outside-to-dismiss scrim. Callers supply only
 * the body via `children` plus the panel size, tone, and footer text.
 *
 * Sizing comes from the {@link dialogSize} design-system presets — no raw width/height escape
 * hatches. Width is fixed columns clamped by `maxWidth`; height is content-driven under
 * `maxHeight` for `md`/`lg` and fixed only for `xl`, so short dialogs shrink to their rows.
 */
export function DialogPanel(props: {
    /** Panel title, rendered in the border in the accent color. Optional — omit for an untitled bordered panel. */
    title?: string;
    /** Named size preset from the design system — `md` (prompt), `lg` (picker), or `xl` (showcase). */
    size: DialogSize;
    /** `danger` swaps in the double `stroke.danger` border in the error color — destructive confirms only. */
    tone?: "default" | "danger";
    /** When true, adds top+bottom padding of 1 — breathing room for short panels. */
    padY?: boolean;
    /** The muted hint line shown as the last row (e.g. `"↑/↓ move · Enter select · Esc cancel"`). */
    footer?: string;
    /** The dialog body. */
    children: JSX.Element;
}): JSX.Element {
    const dims = () => dialogSize[props.size];
    const danger = () => props.tone === "danger";

    return (
        <box
            width={dims().width}
            maxWidth={dims().maxWidth}
            height={dims().height}
            maxHeight={dims().maxHeight}
            flexDirection="column"
            backgroundColor={theme().bgRaised}
            border
            borderStyle={danger() ? stroke.danger : stroke.overlay}
            borderColor={danger() ? theme().error : theme().borderFocus}
            title={props.title}
            titleColor={props.title ? (danger() ? theme().error : theme().accent) : undefined}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={props.padY ? 1 : undefined}
            paddingBottom={props.padY ? 1 : undefined}
            onMouseDown={dialogPanelMouseDown}
            onMouseUp={dialogPanelMouseUp}
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
