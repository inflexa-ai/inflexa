## Why

inf-cli ships a single hard-coded Tokyo Night palette in `src/tui/theme.ts`; users cannot pick a look that fits their terminal or taste, and because the palette is a static object even a config-time choice could not be applied without restarting. Themes are a baseline affordance for a daily-driver TUI, and the Solid renderer already makes live, no-restart switching cheap.

## What Changes

- Convert `src/tui/theme.ts` from a static `as const` object into a small reactive registry: a built-in theme set, a Solid signal holding the active theme, an accessor (`theme()`) the UI reads, and `setTheme(id)` to switch live.
- Expand the token vocabulary from the current 12 flat roles to a richer semantic set — adds `bgPanel`, `borderActive`, `secondary`, `info`, and a `syntax` group that finally styles markdown/code blocks (today rendered with OpenTUI's default `SyntaxStyle`). Existing token names are preserved, so the change is additive — no rename churn.
- Ship ~5 curated dark built-in themes: `tokyo-night` (default, identical to today's palette), `catppuccin-mocha`, `gruvbox-dark`, `nord`, `rose-pine`.
- Add a theme picker to the existing `inf config` TUI: a visible list of themes that previews live as you navigate, the choice persists on save and reverts on discard — reusing the screen's existing draft/saved/dirty machinery.
- Persist the selection as a new `theme` key in `config.json`, validated against the known theme ids. Schema evolution is backward-compatible: existing configs without a `theme` key (and unknown ids) fall back to the default without dropping other settings.
- Migrate the two consumers (`src/tui/app.tsx`, `src/cli/config.tsx`) from `theme.X` to the reactive `theme().X`, and convert any module-level precomputed color constants to reactive reads so switching repaints them.

## Capabilities

### New Capabilities

- `theme-system`: the reactive theme registry, expanded semantic token vocabulary, built-in themes, live switching, persistence in `config.json`, and the `inf config` theme picker.

### Modified Capabilities

<!-- none — no existing spec's requirements change; theme.ts and the config TUI are not covered by an existing spec -->

## Impact

- `src/lib/themes.ts` (new): the `Theme`/`ThemeColors`/`ThemeSyntax` type shapes and the built-in `themes` registry (palette data) — dependency-light (no solid-js, no renderer).
- `src/tui/theme.ts`: static object → reactive accessor layer over the `lib/themes.ts` registry (`theme()`, `setTheme`, and a `syntaxStyle()` accessor for markdown highlighting — lazy, cached per theme); expanded token set.
- `src/tui/theme_ids.ts` (new): solid-js-free `ThemeId`/`themeIds`/`DEFAULT_THEME_ID`, so the config layer can validate the persisted theme without pulling the reactive registry (and solid-js) onto non-TUI command paths.
- `src/lib/config.ts`: `configSchema` gains `theme` (zod enum of `ThemeId`, with default + `.catch` for backward compatibility); `Config` type follows via `z.infer`.
- `src/cli/config.tsx`: theme picker row, live preview, revert-on-discard; reactive color reads.
- `src/tui/app.tsx`: reactive `theme()` reads; consumes the shared `syntaxStyle()` from `theme.ts`.
- TUI launch (`launchTui`, `launchConfig`): initialize the active theme from persisted config before `render()`.
- No new dependencies (zod already present). No new top-level command.
