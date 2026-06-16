import { createSignal } from "solid-js";
import { SyntaxStyle } from "@opentui/core";

import { DEFAULT_THEME_ID, type ThemeId } from "./theme_ids.ts";
import { themes, type ThemeColors } from "../lib/themes.ts";

// Reactive accessor layer for themes. The palette data and type shapes live in
// the dependency-light `src/lib/themes.ts`; theme IDs in the solid-js-free
// `theme_ids.ts` (so `config.ts` can validate the persisted theme without
// loading this reactive layer). All TUI colors come from the ACTIVE theme —
// never inline hex in components, and read colors via `theme().<token>` inside a
// tracking scope so switching repaints reactively. `setTheme(id)` is the only
// mutator; the active theme is seeded from persisted config at TUI launch.

const [activeThemeId, setActiveThemeId] = createSignal<ThemeId>(DEFAULT_THEME_ID);

// Active theme id — read inside a tracking scope for reactivity.
export const themeId = activeThemeId;

export function setTheme(id: ThemeId): void {
    setActiveThemeId(id);
}

// Active theme's flat color tokens. Read as `theme().<token>` in JSX so a
// switch repaints; reading once outside a tracking scope freezes the value.
export function theme(): ThemeColors {
    return themes[activeThemeId()].colors;
}

// Active theme's markdown highlight style. Built lazily and cached per theme:
// the built-in palettes are immutable, so each theme's native SyntaxStyle is
// constructed at most once (total ≤ #themes) and never freed during the process
// — no disposal/use-after-free concern. Reading the active-id signal keeps it
// reactive (so `<markdown>` recolors on switch); being a plain function keeps it
// lazy, so processes that render no markdown (e.g. `inf config`, which previews
// themes live) never build a style.
const syntaxStyleCache = new Map<ThemeId, SyntaxStyle>();
export function syntaxStyle(): SyntaxStyle {
    const id = activeThemeId();
    let style = syntaxStyleCache.get(id);
    if (!style) {
        style = SyntaxStyle.fromStyles({ ...themes[id].syntax });
        syntaxStyleCache.set(id, style);
    }
    return style;
}
