## 1. Theme types and reactive registry (`src/tui/theme.ts`)

- [x] 1.1 Verify the `SyntaxStyle` API in the installed `@opentui/core@0.4.0`: confirm `SyntaxStyle.fromStyles` exists, its argument shape, and the exact set of accepted token keys (`keyword`, `string`, `comment`, …). The installed type is the source of truth for the `syntax` group keys. **Prerequisite for 1.2 and 2.1–2.2** — the verified keys define the `syntax` group and gate theme authoring.
- [x] 1.2 Define domain types (the `Theme`/`ThemeColors`/`ThemeSyntax` shapes in `src/lib/themes.ts`; `ThemeId` in `theme_ids.ts`): `ThemeId` (string-literal union of the built-in ids), `ThemeColors` (the 16 flat color tokens — the existing 12 plus `bgPanel`, `borderActive`, `secondary`, `info`), `ThemeSyntax` (keyed by the verified `SyntaxStyle` token names, each `{ fg: string; bold?: boolean; italic?: boolean }`), and `Theme` (`{ id: ThemeId; name: string; variant: "dark"; colors: ThemeColors; syntax: ThemeSyntax }`).
- [x] 1.3 Replace the static `export const theme` with the built-in `themes: Record<ThemeId, Theme>` registry in `src/lib/themes.ts` and a reactive accessor layer in `src/tui/theme.ts`: the `theme()` accessor returning the active theme's `colors`, a centralized `syntaxStyle()` accessor that lazily builds and caches the markdown `SyntaxStyle` per theme, a `createSignal` over the active id, an active-id accessor, and `setTheme(id: ThemeId)`. Keep `ThemeId`/`themeIds`/`DEFAULT_THEME_ID` in a solid-js-free `src/tui/theme_ids.ts` (imported by both `theme.ts` and `config.ts`) so the config layer never loads the reactive registry. Do NOT import `src/lib/config.ts` (keep the dependency arrow one-directional).

## 2. Built-in themes

- [x] 2.1 Author `tokyo-night` with color values byte-for-byte identical to the pre-change palette, plus the four new tokens and a `syntax` group sourced from the Tokyo Night palette.
- [x] 2.2 Author `catppuccin-mocha`, `gruvbox-dark`, `nord`, and `rose-pine` from their canonical palettes, each filling every `ThemeColors` and `ThemeSyntax` token (no `undefined`).

## 3. Config persistence (`src/lib/config.ts`)

- [x] 3.1 Import `ThemeId`/`themeIds`/`DEFAULT_THEME_ID` from `theme_ids.ts` and extend `configSchema` with `theme: z.enum(themeIds).catch(DEFAULT_THEME_ID).default(DEFAULT_THEME_ID)`; `Config` follows via `z.infer`.
- [x] 3.2 Ensure the closed-fail fallback in `readConfig()` includes the default `theme`; confirm an old config (no `theme`) and a config with an unknown `theme` both parse successfully and preserve `telemetry`.

## 4. Launch initialization

- [x] 4.1 In `launchTui` (`src/cli/tui.tsx`) and `launchConfig` (`src/cli/config.tsx`), call `setTheme(readConfig().theme)` before `void render(...)`, alongside the existing data resolution.

## 5. Migrate consumers to reactive reads

- [x] 5.1 `src/tui/app.tsx`: change all `theme.X` reads to `theme().X`; consume the centralized `syntaxStyle()` accessor from `theme.ts` (replacing the module-level `SyntaxStyle.create()`) and pass `syntaxStyle()` to `<markdown>`; use `bgPanel` for the header bar background (the top `box`, ~line 178) and `borderActive` for the input container border (the textarea `box`, ~line 227, which is always focused).
- [x] 5.2 `src/cli/config.tsx`: change all `theme.X` reads to `theme().X`; rewrite the module-level `noticeColors` map as a reactive read of `theme()` (route the "info" notice to the new `info` token); use `bgPanel` for the config header bar background (the top `box`, ~line 98).

## 6. Theme picker in the config TUI (`src/cli/config.tsx`)

- [x] 6.1 Add `theme` to the draft/saved state model and extend `dirty()` to compare `draft.theme` vs `saved.theme`.
- [x] 6.2 Render the built-in themes as a vertical selectable list (the draft selection marked radio-style), folded into the screen's up/down row navigation. Moving the highlight onto a theme row calls `setTheme(id)` for live preview and sets `draft.theme = id`. Keep up/down moving across all rows and space/enter toggling the `telemetry` boolean.
- [x] 6.3 Persist `theme` on save (`writeConfig({ ...draft })`); on the quit-with-unsaved-changes discard path, call `setTheme(saved().theme)` to revert the live preview.

## 7. Verification

- [x] 7.1 Run `bun run typecheck` (confirms no import cycle, all themes satisfy `Theme`, no raw-string ids) and `bun run lint`; fix findings.
- [ ] 7.2 Manually exercise live switching in `inf config`: navigate the theme list (every config surface incl. notices and chrome recolors live), save and relaunch (selection persisted), and discard after preview (reverts to saved theme).
- [ ] 7.3 Launch the chat TUI with a non-default theme and confirm message text, role labels, header `bgPanel`, focused-input `borderActive`, error banner, and markdown code blocks all reflect it.
- [x] 7.4 Backward-compat checks: a `config.json` with `telemetry` but no `theme` loads with telemetry preserved; a `config.json` with a bogus `theme` id falls back to default with telemetry preserved.
- [ ] 7.5 Spot-check at least one theme in a non-truecolor terminal (`COLORTERM` unset) to confirm OpenTUI's downsampling keeps it legible.
- [x] 7.6 Run `bun run format:file` on every touched file under `src/`.
