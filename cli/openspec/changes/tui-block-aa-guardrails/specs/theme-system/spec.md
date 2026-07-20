## ADDED Requirements

### Requirement: Every rendered text span resolves an explicit theme foreground

No text the TUI paints SHALL rely on a renderable's built-in default foreground. opentui seeds a text renderable's default foreground to opaque white (`RGBA.fromValues(1,1,1,1)`), which measures 1.00–1.13:1 against the five light themes' backgrounds — below even the 3:1 non-text floor, and exactly 1.00:1 on `github-light` — so any span that reaches it is unreadable for those users while appearing correct on the dark default theme.

Concretely, in `src/tui/`:

- Every `<text>` element SHALL resolve an explicit foreground, either by carrying `fg={theme().<role>}` itself or by wrapping every information-bearing child in `<Fg role={…}>` or `<Reverse>`. Both shapes are sanctioned: a foreground set on the `<text>` element propagates into child spans that do not override it.
- The emphasis wrappers `<Bold>`, `<Italic>`, `<Underline>`, and `<Dim>` emit no color of their own and SHALL NOT be the outermost colored element of a span; each SHALL sit inside an `<Fg>` or inside an `fg`-bearing `<text>`.
- A bare string literal placed as a child of an `fg`-less `<text>` — including one sitting beside correctly-wrapped `<Fg>` siblings — is the same defect and SHALL NOT be used.
- Contrast floors are those already established by the pair matrix: **≥ 4.5:1** for text and **≥ 3:1** for non-text or decorative content (borders, meter cells, separator glyphs, `fgSubtle`).

This requirement complements, and does not replace, the pair matrix. The matrix validates *declared palette tokens* against backgrounds and is by construction unable to observe text that declares no token at all; this requirement governs what is actually painted. It likewise extends the existing rules that already close this fallthrough for markdown syntax scopes and for embedded renderables — neither of which reaches a block's own `<text>`.

Because the failure is invisible on the default dark theme (white measures 12–18:1 there, readable but off-palette), every new or changed TUI surface SHALL be verified against a light theme, `github-light` being the sharpest case at `bg` = `#ffffff`.

#### Scenario: An fg-less text element is a violation

- **WHEN** a `<text>` element in `src/tui/` renders information-bearing content without an `fg` prop and without wrapping that content in `<Fg>`/`<Reverse>`
- **THEN** it is a violation of this requirement, regardless of how it appears under the default dark theme

#### Scenario: A bold title renders in the theme foreground, not white

- **WHEN** a block renders a marker glyph followed by a bold title under `github-light`
- **THEN** the title span resolves that theme's `fg` at ≥ 4.5:1 against the surface it is painted on, and never `#ffffff`

#### Scenario: Emphasis wrappers inherit a resolved color

- **WHEN** `<Bold>`, `<Italic>`, `<Underline>`, or `<Dim>` renders
- **THEN** it is nested inside an `<Fg>` or an `fg`-bearing `<text>`, so the span resolves a theme color rather than the renderable default

#### Scenario: Decorative spans are held to the non-text floor, not the text floor

- **WHEN** a span consists solely of decorative ornament — box-drawing frame glyphs, progress-meter cells, or separator dots
- **THEN** it is required to meet 3:1 rather than 4.5:1, so the decorative `fgSubtle` and `border` tiers remain distinct from `fgMuted` instead of collapsing into it

#### Scenario: A new surface is checked on a light theme

- **WHEN** a TUI surface is added or its text rendering is changed
- **THEN** its readability is verified under a light theme, not only under the default `tokyo-night`
