# tui-text-emphasis Specification

## MODIFIED Requirements

### Requirement: Inline styled text composes via the emphasis components, not nested `<text>` or call-site `style` props

Inline mixed-style text SHALL be composed by nesting the emphasis components inside a single `<text>` element (e.g. `<Fg role="fgMuted"><Italic>{text}</Italic></Fg>`). A nested block `<text>` (rejected as a `<text>` child at runtime) and a call-site `<span style={{ … }}>` (which trips `solid/style-prop`) SHALL NOT be used; the `style={{…}}` span channel is confined to `emphasis.tsx` with a scoped oxlint-disable explaining why it is the only sanctioned channel. Colors resolve through `theme()` with no hex literal in the TUI source; glyphs resolve through `GLYPHS` with no inlined glyph literal (the `syntax-bans` spec holds the two lint bans and their exemption set).

#### Scenario: A colored inline segment uses a component

- **WHEN** a line mixes default text with a colored or emphasized segment (e.g. a tool name in the `tool` role within a muted line)
- **THEN** it is built as `<Fg role="tool">read_file</Fg>` inside a single `<text>`, with no nested block `<text>` and no call-site `style={{ … }}`
