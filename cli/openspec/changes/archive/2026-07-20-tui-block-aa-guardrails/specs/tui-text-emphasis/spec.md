## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: The type scale is shown in the design gallery

The design gallery SHALL include a "Type & emphasis" panel that renders each style (bold, regular, dim, italic, underline, reverse) beside its semantic label, mirroring the design system's type-scale panel, using the emphasis components. Each specimen SHALL be **visibly rendered in every built-in theme** — the specimen word itself, not merely its label, SHALL resolve an explicit theme foreground meeting the text contrast floor. A panel whose labels render while the styles they demonstrate are unreadable does not satisfy this requirement: the panel is the canonical reference for the emphasis vocabulary, so a specimen that cannot be seen documents nothing.

#### Scenario: Gallery shows the emphasis scale

- **WHEN** the design gallery opens
- **THEN** it shows a panel listing bold/regular/dim/italic/underline/reverse, each rendered in its actual style with its use label

#### Scenario: Every specimen is readable under a light theme

- **WHEN** the "Type & emphasis" panel renders under `github-light`
- **THEN** each specimen word — bold, regular, dim, italic, underline, and reverse — resolves a theme foreground at ≥ 4.5:1 against the surface behind it, with none falling through to the renderable's white default
