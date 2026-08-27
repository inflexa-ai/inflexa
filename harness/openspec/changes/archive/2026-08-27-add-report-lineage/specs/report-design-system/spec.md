# Report Design System — delta

## ADDED Requirements

### Requirement: The lineage popover is a component of the design system
The popover MUST take each color, each space value, and each type value from the design tokens. The design fixture MUST cover the popover control on a grounded block. Each new CSS class of the popover MUST have an emitting view.

#### Scenario: The fixture covers the popover
- **WHEN** the design fixture renders
- **THEN** one grounded block shows the lineage control, with a document asset that gives it a chain

#### Scenario: No orphan class
- **WHEN** the design sheet gains a popover class
- **THEN** a view emits that class in the rendered page
