## ADDED Requirements

### Requirement: WCAG AA contrast across the rendered pair matrix

Every (foreground token, background token) pair that a TUI component actually renders SHALL meet WCAG 2.1 AA contrast in every built-in theme that renders it: **≥ 4.5:1** for text, **≥ 3:1** for non-text UI (borders, focus frames, large glyph markers), **≥ 1.2:1** for a diff band against `bg`. The set of rendered pairs (the "pair matrix") SHALL be maintained as data in a contrast test (`src/lib/design_system.contrast.test.ts`) that enumerates every pair × every applicable theme and fails on any violation, with each matrix row carrying a reference to the component that renders it. A component that begins rendering a token on a background not present in the matrix SHALL add that pair to the matrix in the same change.

The matrix SHALL resolve a background from what is actually painted beneath the glyph, not from the surface the component nominally sits on:

- A bordered box paints its border glyphs on its **own** `backgroundColor`, so `border` and `borderFocus` SHALL clear the non-text floor against `bgRaised` as well as `bg` — a frame around a raised panel (tool result, sidebar, dialog) never renders against `bg`.
- Syntax scopes render both in the chat stream (`bg`) and inside a tool result's `<code>` panel, which paints its own `bgRaised` fill.
- `bgActive` reaches a token two ways, and only one of them binds every theme. Tokens drawn on a **real** `bgActive` surface (focused editor, list cursor row, unfocused chat-bar footer) SHALL clear their floor against it in every theme. Tokens that reach `bgActive` **only** through the selection highlight SHALL clear it in light themes only: `applySelectionColors` flattens the selection background to `bgActive` while preserving each token's foreground under a light theme, whereas a dark theme falls through to opentui's native per-token inversion, which swaps foreground and background and so preserves the pair's ratio by construction. Binding a selection-only pair on a dark theme would constrain a pair that never renders.

#### Scenario: A palette edit that breaks AA fails the build

- **WHEN** any built-in theme's token value is changed such that a matrix pair drops below its threshold (4.5:1 text, 3:1 non-text) in any theme
- **THEN** `bun test` fails, naming the theme, the pair, and the measured ratio

#### Scenario: Selected text stays readable in light themes

- **WHEN** chat content is selected under a light theme (selection background flattens to `bgActive`, token foregrounds preserved)
- **THEN** every text token rendered in the stream meets 4.5:1 against `bgActive` in that theme

#### Scenario: Borders meet the non-text minimum on the surface they are painted on

- **WHEN** a panel frame or divider renders with `border` or `borderFocus` in any built-in theme
- **THEN** the pair measures at least 3:1 against `bg` **and** against `bgRaised` — a bordered box paints its border glyphs on its own fill, so a raised panel's frame is never measured against `bg` (frames carry block structure and are not waived as decorative)

#### Scenario: Diff bands read as a tint, not as the background

- **WHEN** a diff row band renders in any built-in theme
- **THEN** it measures at least 1.2:1 against `bg`, and the theme's `fg` still measures at least 4.5:1 on the band

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Curated built-in themes with unchanged default

**Reason**: Superseded by "Curated built-in themes meet AA while keeping their identity". The original requirement froze `tokyo-night` byte-for-byte to the pre-themes palette; the AA retune deliberately changes palette values (in the default theme: `fgMuted`, `fgSubtle`, `border`, `syntax.comment`), so byte-fidelity and AA compliance can no longer both hold.

**Migration**: No user action. The default remains `tokyo-night` with its hue identity intact; only failing token values move, validated by the contrast test.
