import { createSignal } from "solid-js";
import { SyntaxStyle } from "@opentui/core";

import { DEFAULT_THEME_ID, markdownStyles, themes, type ThemeColors, type ThemeId } from "../lib/design_system.ts";

// Reactive accessor layer for themes. The id list, palette data, and type shapes
// live in the dependency-light, solid-js-free `src/lib/design_system.ts` (so `config.ts`
// can validate the persisted theme without loading this reactive layer); this file
// adds the active-theme signal on top. All TUI colors come from the ACTIVE theme —
// never inline hex in components, and read colors via `theme().<token>` inside a
// tracking scope so switching repaints reactively. `setTheme(id)` is the only
// mutator; the active theme is seeded from persisted config at TUI launch.

const [activeThemeId, setActiveThemeId] = createSignal<ThemeId>(DEFAULT_THEME_ID);

/** Active theme id — read inside a tracking scope for reactivity. */
export const themeId = activeThemeId;

export function setTheme(id: ThemeId): void {
    setActiveThemeId(id);
}

/**
 * Active theme's flat color tokens. Read as `theme().<token>` in JSX so a
 * switch repaints; reading once outside a tracking scope freezes the value.
 */
export function theme(): ThemeColors {
    return themes[activeThemeId()].colors;
}

/** A transient status-line notice surfaced in the TUI (the stdout-free feedback channel). */
export type Notice = {
    /** Severity, which selects the notice color. */
    kind: "info" | "warn" | "error";
    /** The message shown to the user. */
    text: string;
};

/**
 * The active theme's color for a notice kind. Reads the theme reactively so it recolors on
 * switch. Layout-agnostic — callers decide foreground vs background (the chat banner inverts it
 * as a bar; the config screen uses it as text color). Lives here because it is a theme accessor:
 * a notice kind maps onto the palette's matching semantic role.
 */
export function noticeColor(kind: Notice["kind"]): string {
    const t = theme();
    return kind === "warn" ? t.warning : kind === "error" ? t.error : t.info;
}

/**
 * Active theme's markdown highlight style. Built lazily and cached per theme:
 * the built-in palettes are immutable, so each theme's native SyntaxStyle is
 * constructed at most once (total ≤ #themes) and never freed during the process
 * — no disposal/use-after-free concern. Reading the active-id signal keeps it
 * reactive (so `<markdown>` recolors on switch); being a plain function keeps it
 * lazy, so processes that render no markdown (e.g. `inf config`, which previews
 * themes live) never build a style.
 */
const syntaxStyleCache = new Map<ThemeId, SyntaxStyle>();
export function syntaxStyle(): SyntaxStyle {
    const id = activeThemeId();
    let style = syntaxStyleCache.get(id);
    if (!style) {
        // Code-block scopes (themes[id].syntax) + markdown prose scopes (markdownStyles), so the
        // same SyntaxStyle colors both fenced code and the surrounding markdown (headings, emphasis…).
        style = SyntaxStyle.fromStyles({ ...themes[id].syntax, ...markdownStyles(themes[id].colors) });
        syntaxStyleCache.set(id, style);
    }
    return style;
}
