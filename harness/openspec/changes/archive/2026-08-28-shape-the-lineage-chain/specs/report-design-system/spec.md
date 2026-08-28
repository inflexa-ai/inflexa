# Report Design System — delta

## MODIFIED Requirements

### Requirement: The lineage popover is a component of the design system
The popover MUST take each color, each space value, and each type value from the design tokens. The control is one inline stroke SVG on the 16px grid, drawn in the view, muted at rest and primary on hover. The rail marks the pinned artifact with the primary tint, a raw input with the terminal tint, and a producer row with the mono type. The design fixture MUST cover the popover control on a grounded block. Each new CSS class of the popover MUST have an emitting view.

#### Scenario: The fixture covers the popover
- **WHEN** the design fixture renders
- **THEN** one grounded block shows the branch-glyph control, with a document asset that gives it a chain

#### Scenario: No orphan class
- **WHEN** the design sheet gains a popover class
- **THEN** a view emits that class in the rendered page
