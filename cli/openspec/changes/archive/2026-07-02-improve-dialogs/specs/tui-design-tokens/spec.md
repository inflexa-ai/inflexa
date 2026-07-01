# tui-design-tokens Specification (delta)

## ADDED Requirements

### Requirement: Dialog size presets use clamped fixed dimensions; only static-content dialogs are content-height

`src/lib/design_system.ts` SHALL define the dialog size presets (`dialogSize`, keys `md`/`lg`/`xl`) as fixed column widths clamped by a percentage, not paired percentages: each preset SHALL carry a fixed `width` in columns (`md: 64`, `lg: 88`, `xl: 116` — calibration values, tunable) and a `maxWidth` percentage clamp (`90%`) so panels shrink on narrow terminals but never balloon on wide ones. Heights follow the same fixed+clamp shape for tiers whose content changes while the dialog is open: `lg` (pickers, whose lists filter) SHALL fix its height in rows (`20`, clamped by `maxHeight: 80%`) and `xl` SHALL fix its height (`85%`) — a panel that resizes as its content changes mid-interaction is worse UX than trailing empty rows. Only `md` SHALL be content-height (`height: undefined`, `maxHeight: 80%`), because its content (a prompt line, a confirm message) is static for the dialog's lifetime. No preset SHALL pair a percentage width with a percentage height, because terminal cells are ~2× taller than wide and paired percentages render square-or-portrait panels whose proportions track the terminal's instead of the content's.

#### Scenario: Wide terminal does not balloon a prompt

- **WHEN** an `md` dialog renders on a 250-column terminal
- **THEN** its panel is 64 columns wide, not a percentage of the terminal width

#### Scenario: Narrow terminal clamps instead of overflowing

- **WHEN** an `md` dialog renders on a 60-column terminal
- **THEN** its panel width is clamped to 90% of the terminal, not the fixed 64 columns

#### Scenario: Filtering never resizes a picker

- **WHEN** an `lg` picker's list is filtered from many rows down to a few
- **THEN** the panel height does not change — overflow scrolls, shortfall leaves empty rows

#### Scenario: Short prompt shrinks to its content

- **WHEN** an `md` dialog's static body is shorter than its `maxHeight` allows
- **THEN** the panel is only as tall as its content — no fixed-height empty region below it

#### Scenario: Fixed height clamps on short terminals

- **WHEN** an `lg` dialog renders on a terminal shorter than its fixed row height allows
- **THEN** the panel height is clamped to the `maxHeight` percentage and the body scrolls
