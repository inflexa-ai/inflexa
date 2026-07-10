# theme-system Specification

## Purpose
TBD - created by archiving change add-selectable-themes. Update Purpose after archive.
## Requirements
### Requirement: Reactive theme registry and accessor

`src/tui/theme.ts` SHALL expose the active theme through a Solid signal so that colors read in the TUI are reactive. It SHALL provide reactive accessors over a registry of built-in themes — the registry and its type shapes (`Theme`/`ThemeColors`/`ThemeSyntax`) living in the dependency-light, solid-js-free design-system module `src/lib/design_system.ts` — keyed by a `ThemeId` domain type (a string-literal union, never a raw `string`), an accessor `theme()` returning the active theme's flat color tokens, a `setTheme(id: ThemeId)` mutator, an accessor for the active theme id, and a derived `syntaxStyle()` accessor giving the active theme's markdown highlight style. `theme.ts` SHALL NOT import `src/lib/config.ts`; the `ThemeId`/`themeIds`/`DEFAULT_THEME_ID` constants SHALL live in a solid-js-free module so the config layer can validate the persisted theme without loading the reactive registry on non-TUI command paths.

#### Scenario: Components read colors reactively

- **WHEN** a component reads `theme().accent` (or any token) inside JSX and `setTheme` is later called with a different id
- **THEN** that surface repaints with the new color without a process restart and without manual per-node updates

#### Scenario: Unknown id is not representable

- **WHEN** code attempts to pass a value that is not a member of `ThemeId` to `setTheme`
- **THEN** TypeScript rejects it at compile time (the id set is a domain type, not `string`)

### Requirement: Expanded semantic token vocabulary

The theme token set SHALL be a standards-grounded functional vocabulary, grouped by prefix, with these roles and meanings:

- **Surfaces**: `bg` (app background), `bgRaised` (elevated chrome — header/status bars, rail, panels), `bgActive` (hovered/selected/focused element background).
- **Foreground (three tiers)**: `fg` (primary text), `fgMuted` (labels, meta, hints — the floor for information-bearing secondary text), `fgSubtle` (decorative only — see below).
- **Borders (two tiers)**: `border` (subtle dividers and frames), `borderFocus` (focused/active region).
- **On-color**: `onAccent` (text/icons placed on a filled accent or status background).
- **Accent**: `accent` (primary accent, focus, links), `secondary` (secondary accent).
- **Status**: `success`, `warning`, `error`, `info`.
- **Domain**: `user`, `assistant`, `tool`, `thinking`.
- **Diff**: `diffAddedBg`, `diffRemovedBg` (row bands behind added/removed diff lines; per-theme tints of `success`/`error` toward `bg`). Diff sign columns and line numbers reuse `success`/`error`/`fgMuted` — no dedicated tokens.

`fgSubtle` SHALL color only content whose loss does not impair task completion (pure decoration: unselected gutter glyphs, separator dots). Information-bearing text — keybind hints, durations, ids, message meta, step labels — SHALL use `fgMuted` or stronger. `fgSubtle` SHALL measure at least 3:1 against every background it renders on (perceivable), while being exempt from the 4.5:1 text threshold as decoration; this keeps the three foreground tiers visually distinct instead of collapsing `fgSubtle` into a second `fgMuted`.

Every token SHALL be present and non-empty in every built-in theme; partial themes SHALL NOT be representable in the `Theme` type. The vocabulary supersedes the prior names: `bgPanel`→`bgRaised`, `bgFocused`→`bgActive`, `muted`→`fgMuted`, `borderActive`→`borderFocus`, `warn`→`warning`, and the prior `selected` role is folded into `bgActive`. The design doc's example role names (`surface`/`raised`/`fgFaint`/`id`/`ok`/`danger`) SHALL NOT be used; the standard nouns (`success`/`error`, the `bg*/fg*/border*` grouping) are authoritative. No hex SHALL be inlined at any call site; colors SHALL be read as `theme().<role>` inside a tracking scope.

#### Scenario: All tokens present in every built-in

- **WHEN** the project type-checks
- **THEN** each built-in theme object satisfies the `Theme` type with all color tokens (including `fgSubtle`, `onAccent`, `tool`, `thinking`, `diffAddedBg`, `diffRemovedBg`) defined, so no `undefined` color can reach the renderer

#### Scenario: Renamed tokens repoint at every call site

- **WHEN** a consumer previously read `theme().bgPanel`, `theme().bgFocused`, `theme().muted`, `theme().borderActive`, `theme().warn`, or `theme().selected`
- **THEN** it now reads the corresponding new role (`bgRaised`, `bgActive`, `fgMuted`, `borderFocus`, `warning`, `bgActive`) and the old name no longer exists in `ThemeColors`, so any missed site fails compilation

#### Scenario: Three foreground tiers are available

- **WHEN** a component needs primary text, secondary/hint text, or decorative faintness
- **THEN** it reads `theme().fg`, `theme().fgMuted`, or `theme().fgSubtle` respectively — and `fgSubtle` only where losing the content would not impair the task

#### Scenario: Information-bearing hints do not use fgSubtle

- **WHEN** a component renders text the user is expected to read — a keybind hint, duration, id, message meta line, or step label
- **THEN** it colors that text with `fgMuted` (or stronger), never `fgSubtle`

#### Scenario: On-color replaces background reuse

- **WHEN** text or an icon is drawn on a filled accent or status background (e.g. the error banner)
- **THEN** it reads `theme().onAccent` for its foreground, not `theme().bg`

### Requirement: WCAG AA contrast across the rendered pair matrix

Every (foreground token, background token) pair that a TUI component actually renders SHALL meet WCAG 2.1 AA contrast in every built-in theme: **≥ 4.5:1** for text, **≥ 3:1** for non-text UI (borders, focus frames, large glyph markers). The set of rendered pairs (the "pair matrix") SHALL be maintained as data in a contrast test (`src/lib/design_system.contrast.test.ts`) that enumerates every pair × every built-in theme and fails on any violation, with each matrix row carrying a reference to the component that renders it. Because light themes flatten the selection background to `bgActive` while preserving each token's foreground (`applySelectionColors`), `bgActive` SHALL be treated as a background that every text token rendered in the chat stream must satisfy — not only tokens used in interactive states. A component that begins rendering a token on a background not present in the matrix SHALL add that pair to the matrix in the same change.

#### Scenario: A palette edit that breaks AA fails the build

- **WHEN** any built-in theme's token value is changed such that a matrix pair drops below its threshold (4.5:1 text, 3:1 non-text) in any theme
- **THEN** `bun test` fails, naming the theme, the pair, and the measured ratio

#### Scenario: Selected text stays readable in light themes

- **WHEN** chat content is selected under a light theme (selection background flattens to `bgActive`, token foregrounds preserved)
- **THEN** every text token rendered in the stream meets 4.5:1 against `bgActive` in that theme

#### Scenario: Borders meet the non-text minimum

- **WHEN** a panel frame or divider renders with `border` on `bg` in any built-in theme
- **THEN** the pair measures at least 3:1 (frames carry block structure and are not waived as decorative)

### Requirement: Curated built-in themes meet AA while keeping their identity

The CLI SHALL ship multiple curated built-in themes, including the dark themes `tokyo-night`, `catppuccin-mocha`, `gruvbox-dark`, `nord`, `rose-pine` and the light themes `catppuccin-latte`, `github-light`, `solarized-light`, `gruvbox-light`, `one-light`. The default theme SHALL be `tokyo-night`. Every palette SHALL satisfy the rendered pair matrix (see "WCAG AA contrast across the rendered pair matrix"); where an upstream/canonical palette value cannot meet AA on the surfaces it is rendered against, the shipped value SHALL be adjusted by hue-preserving lightness movement (chroma reduced only when lightness alone cannot reach the target in gamut), so each theme keeps its recognizable hue character. Shipped values MAY therefore deviate from canonical upstream palettes; such deviation is deliberate and SHALL NOT be "fixed" by re-syncing with upstream without re-satisfying the matrix.

#### Scenario: Default theme is Tokyo Night and passes the matrix

- **WHEN** a user who has never selected a theme launches the TUI
- **THEN** the active theme is `tokyo-night`, its hue character is recognizably Tokyo Night, and every matrix pair passes AA

#### Scenario: Multiple themes selectable

- **WHEN** the theme picker is opened
- **THEN** all built-in themes are listed and any of them can be made active

#### Scenario: Upstream re-sync cannot regress contrast

- **WHEN** a palette value is updated to track its upstream theme
- **THEN** the contrast test still passes, or the update is rejected

### Requirement: Live theme switching

Calling `setTheme(id)` SHALL repaint the currently-running render root in place — every themed surface in that root recolors on the next frame, with no process restart and no renderer re-creation. The `inflexa config` screen remains a user-facing switch surface, and the chat TUI (`app.tsx`) SHALL ALSO provide in-session switch surfaces via the command palette's "Change theme" command and the embedded Settings dialog. In all cases the switch repaints the running render root in place and the chosen theme is persisted via `writeConfig`. The chat TUI SHALL still apply the persisted theme at launch.

#### Scenario: Config screen recolors live on switch

- **WHEN** the theme is switched while `inflexa config` is running
- **THEN** the config screen's chrome, notices, and theme list recolor on the next frame without a restart

#### Scenario: Chat TUI reflects the saved theme at launch

- **WHEN** the chat TUI starts after a theme was saved
- **THEN** its message text, role labels, borders, and markdown code blocks render in the saved theme

#### Scenario: Chat TUI switches theme in-session via the palette

- **WHEN** the user runs "Change theme" from the command palette and selects a theme
- **THEN** the running chat TUI recolors on the next frame and the selection is persisted via `writeConfig`

### Requirement: Themed markdown and code blocks

Markdown rendered in the chat TUI SHALL derive its syntax highlighting from the active theme via a `syntax` token group, replacing the default `SyntaxStyle`. The `syntax` group SHALL be keyed by the token names accepted by `@opentui/core`'s `SyntaxStyle` (verified against the installed version), each entry carrying at least a foreground color and optionally bold/italic. The style map SHALL register a `"default"` scope mapped to the theme's `fg`, so that any span without a tree-sitter capture — markdown pipe-table data cells, plain text inside fenced blocks, unhighlighted tool output — resolves to a theme color and can never fall through to opentui's built-in `#FFFFFF` default foreground. `theme.ts` SHALL expose a single shared `syntaxStyle()` accessor returning the active theme's `SyntaxStyle`, built lazily and cached per theme so each immutable built-in's style is constructed at most once; switching themes SHALL update what it returns so consuming markdown recolors.

#### Scenario: Code uses the active theme's syntax tokens

- **WHEN** a code block renders in the chat TUI
- **THEN** its keyword/string/comment colors come from the active theme's `syntax` tokens

#### Scenario: Un-captured spans resolve to the theme foreground

- **WHEN** markdown containing a pipe table renders under a light theme
- **THEN** the table's data cells render in the theme's `fg` (readable, ≥4.5:1), not opentui's white default, while header cells keep the `markup.heading` accent styling

#### Scenario: Every theme's style resolves a default scope

- **WHEN** `syntaxStyle()` is built for any built-in theme
- **THEN** resolving the `"default"` scope yields a style whose foreground equals that theme's `fg` (asserted in `theme.test.ts`)

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

The `inflexa config` screen SHALL present the built-in themes as a visible, navigable list that previews live and commits on save, reusing the screen's draft/saved/dirty model. Moving the highlight onto a theme SHALL apply it immediately (live preview) and set it as the draft selection, marking the screen dirty; saving SHALL persist the selection; quitting with unsaved changes and discarding SHALL revert the live theme to the previously-saved one.

#### Scenario: Live preview while navigating the list

- **WHEN** the user moves the highlight across the theme list in `inflexa config`
- **THEN** the entire config screen recolors immediately to the highlighted theme and the screen is marked as having unsaved changes

#### Scenario: Save commits the preview

- **WHEN** the user saves after changing the theme
- **THEN** the new theme is written to `config.json` and remains active

#### Scenario: Discard reverts the preview

- **WHEN** the user previews a different theme, then quits and discards the unsaved change
- **THEN** the live theme reverts to the previously-saved theme rather than remaining on the previewed one

