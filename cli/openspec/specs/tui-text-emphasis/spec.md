# tui-text-emphasis Specification

## Purpose
TBD - created by archiving change inflexa-design-system. Update Purpose after archive.
## Requirements
### Requirement: Text-emphasis vocabulary exposed as inline JSX components

The "Type & emphasis" scale SHALL be exposed as composable inline JSX components in `src/tui/components/emphasis.tsx` — `<Bold>`, `<Italic>`, `<Underline>`, `<Dim>`, `<Reverse>`, and `<Fg role={…}>` — each emitting a single opentui inline span so they nest inside a `<text>` and compose beside each other. Call sites in `src/tui/` SHALL use these components and SHALL NOT hand-compose opentui's `t`/`bold`/`dim`/`italic`/`underline`/`reverse`/`fg`/`bg` primitives directly. `emphasis.tsx` is the ONLY module permitted to touch those primitives and the `style={{…}}` span channel they require. No new dependency is added — the components wrap APIs already shipping in `@opentui/core`/`@opentui/solid`.

`<Reverse>` SHALL render inverse video as an EXPLICIT fg/bg swap on the span `style` — `{ fg: theme().bg, bg: theme().fg }` — NOT the `{ inverse: true }` attribute: opentui bakes the inverse swap into the cell and, with `bg` unset, collapses both colors to a solid invisible block. App code SHALL never call `@opentui/core`'s `reverse()` either (defective in 0.4.0: it passes `{reverse:true}` which `createTextAttributes` never reads). `<Italic>` and `<Dim>` render terminal-dependently (many `tmux`/Terminal.app setups drop the attribute), so italic/dim text SHALL be wrapped in a muted `<Fg>` so meaning survives when the attribute is dropped. `<Fg>`'s `role` SHALL be a `ThemeColors` key, never a hex.

#### Scenario: Call sites use the components, not the raw primitives

- **WHEN** a component needs styled inline text (bold, dim, italic, underline, reverse, or colored)
- **THEN** it imports the matching component from `emphasis.tsx`, and no `src/tui/` file outside `emphasis.tsx` imports `t`/`bold`/`dim`/`italic`/`underline`/`reverse`/`fg`/`bg` from `@opentui/core`

#### Scenario: The semantic mapping is documented, not wrapped

- **WHEN** a developer needs to know which component to use for which purpose
- **THEN** the mapping is a reference table in `CLAUDE.md`, and no `src/tui/text.ts` (or equivalent forwarding re-export module) exists

### Requirement: Inline styled text composes via the emphasis components, not nested `<text>` or call-site `style` props

Inline mixed-style text SHALL be composed by nesting the emphasis components inside a single `<text>` element (e.g. `<Fg role="fgMuted"><Italic>{text}</Italic></Fg>`). A nested block `<text>` (rejected as a `<text>` child at runtime) and a call-site `<span style={{ … }}>` (which trips `solid/style-prop`) SHALL NOT be used; the `style={{…}}` span channel is confined to `emphasis.tsx` with a scoped eslint-disable explaining why it is the only sanctioned channel. Colors resolve through `theme()`; glyphs through `GLYPHS`.

#### Scenario: A colored inline segment uses a component

- **WHEN** a line mixes default text with a colored or emphasized segment (e.g. a tool name in the `tool` role within a muted line)
- **THEN** it is built as `<Fg role="tool">read_file</Fg>` inside a single `<text>`, with no nested block `<text>` and no call-site `style={{ … }}`

### Requirement: Selection / cursor highlighting uses `<Reverse>`

UI that highlights a selected or cursor-focused row (config sections, list pickers) SHALL express the highlight with `<Reverse>` (inverse video) rather than an ad-hoc background fill or the dead `reverse()` helper, so selection rendering is consistent and uses the working inverse path.

#### Scenario: The selected config section is inverse-highlighted

- **WHEN** the user scrolls/selects a section in the inflexa config screen
- **THEN** the active section row is rendered with `<Reverse>`

### Requirement: The type scale is shown in the design gallery

The design gallery SHALL include a "Type & emphasis" panel that renders each style (bold, regular, dim, italic, underline, reverse) beside its semantic label, mirroring the design system's type-scale panel, using the emphasis components. Each specimen SHALL be **visibly rendered in every built-in theme** — the specimen word itself, not merely its label, SHALL resolve an explicit theme foreground meeting the text contrast floor. A panel whose labels render while the styles they demonstrate are unreadable does not satisfy this requirement: the panel is the canonical reference for the emphasis vocabulary, so a specimen that cannot be seen documents nothing.

#### Scenario: Gallery shows the emphasis scale

- **WHEN** the design gallery opens
- **THEN** it shows a panel listing bold/regular/dim/italic/underline/reverse, each rendered in its actual style with its use label

#### Scenario: Every specimen is readable under a light theme

- **WHEN** the "Type & emphasis" panel renders under `github-light`
- **THEN** each specimen word — bold, regular, dim, italic, underline, and reverse — resolves a theme foreground at ≥ 4.5:1 against the surface behind it, with none falling through to the renderable's white default

### Requirement: The emphasis wrappers carry no color and are only legal inside a resolved foreground

`<Bold>`, `<Italic>`, `<Underline>`, and `<Dim>` SHALL set a terminal attribute only — never a foreground. `<Bold>`/`<Italic>`/`<Underline>` emit `<b>`/`<i>`/`<u>` spans and `<Dim>` emits a `{ dim: true }` span; none passes `fg`, so each inherits whatever foreground its ancestor resolved. Placed inside an `fg`-less `<text>`, that inherited value is opentui's opaque-white default, which is unreadable on every light theme.

Each of the four SHALL therefore appear only inside an `<Fg role={…}>` or inside a `<text>` that carries an explicit `fg`. `<Fg>` and `<Reverse>` are the only emphasis components that resolve a color themselves — `<Fg>` by setting the span foreground from a `ThemeColors` role, `<Reverse>` by setting foreground and background together — and are consequently the only two that may be the outermost colored element of a span.

This subsumes, and states the mechanism behind, the existing rule that italic and dim text be wrapped in a muted `<Fg>`: that wrapping is required not only so meaning survives an attribute-dropping terminal, but because without it the text has no color at all.

#### Scenario: A bold specimen resolves a theme color

- **WHEN** `<Bold>` renders inside an `<Fg role="fg">` or inside a `<text fg={theme().fg}>`
- **THEN** its span resolves that theme's `fg`, and the same text placed in an `fg`-less `<text>` with no `<Fg>` ancestor is a violation

#### Scenario: Dim is wrapped for color, not only for attribute survival

- **WHEN** `<Dim>` is used to render meta text
- **THEN** it is nested inside a muted `<Fg>`, so the text remains both readable and correctly colored on a terminal that drops the DIM attribute

#### Scenario: Reverse needs no wrapper

- **WHEN** `<Reverse>` renders a selection or cursor row
- **THEN** it resolves both foreground and background itself and is correct without an enclosing `<Fg>`

