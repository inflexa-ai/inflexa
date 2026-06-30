## ADDED Requirements

### Requirement: Reactive theme registry and accessor

`src/tui/theme.ts` SHALL expose the active theme through a Solid signal so that colors read in the TUI are reactive. It SHALL provide reactive accessors over a registry of built-in themes — the registry and its type shapes (`Theme`/`ThemeColors`/`ThemeSyntax`) living in a dependency-light `src/lib/themes.ts` — keyed by a `ThemeId` domain type (a string-literal union, never a raw `string`), an accessor `theme()` returning the active theme's flat color tokens, a `setTheme(id: ThemeId)` mutator, an accessor for the active theme id, and a derived `syntaxStyle()` accessor giving the active theme's markdown highlight style. `theme.ts` SHALL NOT import `src/lib/config.ts`; the `ThemeId`/`themeIds`/`DEFAULT_THEME_ID` constants SHALL live in a solid-js-free module so the config layer can validate the persisted theme without loading the reactive registry on non-TUI command paths.

#### Scenario: Components read colors reactively

- **WHEN** a component reads `theme().accent` (or any token) inside JSX and `setTheme` is later called with a different id
- **THEN** that surface repaints with the new color without a process restart and without manual per-node updates

#### Scenario: Unknown id is not representable

- **WHEN** code attempts to pass a value that is not a member of `ThemeId` to `setTheme`
- **THEN** TypeScript rejects it at compile time (the id set is a domain type, not `string`)

### Requirement: Expanded semantic token vocabulary

The theme token set SHALL retain every existing semantic role with its current meaning (`bg`, `bgFocused`, `border`, `fg`, `muted`, `accent`, `user`, `assistant`, `selected`, `success`, `warn`, `error`) and SHALL add the tokens `bgPanel` (elevated chrome such as header/status bars), `borderActive` (focused/active borders), `secondary` (secondary accent), and `info` (informational notices). Every token SHALL be present and non-empty in every built-in theme; partial themes SHALL NOT be representable in the `Theme` type.

#### Scenario: All tokens present in every built-in

- **WHEN** the project type-checks
- **THEN** each built-in theme object satisfies the `Theme` type with all color tokens defined, so no `undefined` color can reach the renderer

#### Scenario: Existing token names unchanged

- **WHEN** an existing consumer reads a previously-defined token (e.g. `accent`, `bgFocused`)
- **THEN** the token still exists with the same semantic role, requiring only the `theme.X` → `theme().X` reactive-read change

### Requirement: Curated built-in themes with unchanged default

The CLI SHALL ship multiple curated dark built-in themes, including `tokyo-night`, `catppuccin-mocha`, `gruvbox-dark`, `nord`, and `rose-pine`. The default theme SHALL be `tokyo-night`, and its color values SHALL be identical to the palette shipped before this change so that the out-of-the-box appearance is unchanged.

#### Scenario: Default matches the prior palette

- **WHEN** a user who has never selected a theme launches the TUI
- **THEN** the active theme is `tokyo-night` and every token value equals the pre-change palette

#### Scenario: Multiple themes selectable

- **WHEN** the theme picker is opened
- **THEN** all built-in themes are listed and any of them can be made active

### Requirement: Live theme switching

Calling `setTheme(id)` SHALL repaint the currently-running render root in place — every themed surface in that root recolors on the next frame, with no process restart and no renderer re-creation. The `inf config` screen is the user-facing switch surface; the chat TUI (`app.tsx`) provides no in-session switch control and applies the persisted theme at launch.

#### Scenario: Config screen recolors live on switch

- **WHEN** the theme is switched while `inf config` is running
- **THEN** the config screen's chrome, notices, and theme list recolor on the next frame without a restart

#### Scenario: Chat TUI reflects the saved theme at launch

- **WHEN** the chat TUI starts after a theme was saved
- **THEN** its message text, role labels, borders, and markdown code blocks render in the saved theme

### Requirement: Themed markdown and code blocks

Markdown rendered in the chat TUI SHALL derive its syntax highlighting from the active theme via a `syntax` token group, replacing the default `SyntaxStyle`. The `syntax` group SHALL be keyed by the token names accepted by `@opentui/core`'s `SyntaxStyle` (verified against the installed version), each entry carrying at least a foreground color and optionally bold/italic. `theme.ts` SHALL expose a single shared `syntaxStyle()` accessor returning the active theme's `SyntaxStyle`, built lazily and cached per theme so each immutable built-in's style is constructed at most once; switching themes SHALL update what it returns so consuming markdown recolors.

#### Scenario: Code uses the active theme's syntax tokens

- **WHEN** a code block renders in the chat TUI
- **THEN** its keyword/string/comment colors come from the active theme's `syntax` tokens

### Requirement: Theme persistence with backward-compatible config

The selected theme SHALL persist in `config.json` under a `theme` key whose value is validated against the known `ThemeId` set. Schema evolution SHALL be backward-compatible: a `config.json` written before this change (no `theme` key) and a `config.json` containing an unrecognized theme id SHALL both load successfully, fall back to the default theme, and preserve all other settings (e.g. `telemetry`).

#### Scenario: Old config without theme key

- **WHEN** `readConfig()` reads a `config.json` that has `telemetry` but no `theme` key
- **THEN** the parse succeeds, `theme` resolves to the default, and the stored `telemetry` value is preserved (not reset)

#### Scenario: Config with an unknown theme id

- **WHEN** `config.json` contains `theme` set to an id that is not a built-in
- **THEN** the parse succeeds, `theme` falls back to the default, and other settings are preserved

#### Scenario: Selection round-trips

- **WHEN** a user selects a non-default theme and saves
- **THEN** the chosen id is written to `config.json` and is the active theme on the next launch

### Requirement: Theme picker in the config TUI

The `inf config` screen SHALL present the built-in themes as a visible, navigable list that previews live and commits on save, reusing the screen's draft/saved/dirty model. Moving the highlight onto a theme SHALL apply it immediately (live preview) and set it as the draft selection, marking the screen dirty; saving SHALL persist the selection; quitting with unsaved changes and discarding SHALL revert the live theme to the previously-saved one.

#### Scenario: Live preview while navigating the list

- **WHEN** the user moves the highlight across the theme list in `inf config`
- **THEN** the entire config screen recolors immediately to the highlighted theme and the screen is marked as having unsaved changes

#### Scenario: Save commits the preview

- **WHEN** the user saves after changing the theme
- **THEN** the new theme is written to `config.json` and remains active

#### Scenario: Discard reverts the preview

- **WHEN** the user previews a different theme, then quits and discards the unsaved change
- **THEN** the live theme reverts to the previously-saved theme rather than remaining on the previewed one
