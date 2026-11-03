# Spec Delta

## MODIFIED Requirements

### Requirement: WCAG AA contrast across the rendered pair matrix

Every (foreground token, background token) pair that a TUI component actually renders SHALL meet WCAG 2.1 AA contrast in every built-in theme that renders it: **≥ 4.5:1** for text, **≥ 3:1** for non-text UI (borders, focus frames, large glyph markers), **≥ 1.2:1** for a diff band against `bg`. The set of rendered pairs (the "pair matrix") SHALL be maintained as data in a contrast test (`src/lib/test/design_system.contrast.test.ts`) that enumerates every pair × every applicable theme and fails on any violation, with each matrix row carrying a reference to the component that renders it. A component that begins rendering a token on a background not present in the matrix SHALL add that pair to the matrix in the same change.

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

