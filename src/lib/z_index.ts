/**
 * The single source of stacking order for absolutely-positioned TUI layers, the
 * way `theme` is for colors and `GLYPHS` for glyphs. A stacking order is a
 * cross-cutting contract — layers declared in different files must agree on who
 * sits above whom — so it lives in one named ladder rather than as raw numbers
 * scattered at call sites. The level names follow the de-facto design-system
 * vocabulary (Bootstrap's `$zindex-*`, Chakra's `zIndices`, MUI's `zIndex`).
 *
 * Ordered low → high; higher paints on top. There is deliberately no `0` level:
 * `zIndex={0}` is the default, so a named constant for it would buy nothing.
 * Steps of 10 leave room to slot a new level between two existing ones without
 * renumbering everything below it.
 */
export const zIndex = {
    /** Inline menus opened from in-flow content. */
    dropdown: 10,
    /** Pinned chrome that rides above scrolling content but below modals. */
    sticky: 20,
    /** A modal dialog and the scrim that dims the rest of the screen for it. */
    modal: 30,
    /** Popovers/menus that may open over a modal. */
    popover: 40,
    /** Transient toasts/notices — surface over an open modal. */
    toast: 50,
    /** Ephemeral hover hints — top of the stack, above everything. */
    tooltip: 60,
} as const;
