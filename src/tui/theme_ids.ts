// Theme identifiers, kept free of solid-js (and the reactive theme registry) so
// the config layer can validate the persisted theme without dragging a UI
// framework onto non-TUI command paths: `src/index.ts` reads config at startup
// for every command (`inf login`, `whoami`, …), so `config.ts` importing the
// full `theme.ts` would eagerly load solid-js everywhere. Both `theme.ts` and
// `config.ts` import these constants from here instead.

// Ordered id list — single source of truth for the picker order, the `ThemeId`
// union, and the config zod enum.
export const themeIds = ["tokyo-night", "catppuccin-mocha", "gruvbox-dark", "nord", "rose-pine"] as const;

export type ThemeId = (typeof themeIds)[number];

export const DEFAULT_THEME_ID: ThemeId = "tokyo-night";
