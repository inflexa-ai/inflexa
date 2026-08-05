## MODIFIED Requirements

### Requirement: Dialog size presets use clamped fixed dimensions; only static-content dialogs are content-height

`src/lib/design_system.ts` MUST define the dialog size presets (`dialogSize`, keys `md`, `lg`,
and `xl`) as fixed column widths with a percentage clamp, and never as a pair of percentages.

Each preset MUST carry a fixed `width` in columns, which is a calibration value that you can
tune: `md: 64`, `lg: 108`, and `xl: 116`. Each preset MUST carry a `maxWidth` clamp of `90%`.
Thus a panel becomes smaller on a narrow terminal, and it never grows on a wide one.

`lg` MUST hold a row that carries facts beside its name. A file entry spends about 35 columns
on its permissions, its size, and its date. A picker that then truncates the names defeats its
own purpose.

A height obeys the same fixed-and-clamp shape, for each tier whose content changes while the
dialog is open. `lg` (a picker, whose list filters) MUST fix its height at `28` rows, with a
`maxHeight` clamp of `80%`. That leaves about 20 rows for the list after the chrome of the
panel, which is a working set and not a keyhole. `xl` MUST fix its height at `85%`.

A panel that resizes as its content changes is worse than trailing empty rows.

Only `md` MUST be content-height (`height: undefined`, `maxHeight: 80%`). Its content is a
prompt line or a confirm message, and that content is static for the life of the dialog.

No preset MUST pair a percentage width with a percentage height. A terminal cell is about 2
times taller than it is wide. Thus a pair of percentages gives a square panel or a portrait
panel, whose proportions track the terminal instead of the content.

A test of these dimensions MUST read them from `dialogSize`, and MUST NOT restate the numbers.
A duplicated number turns each legitimate change of the calibration into a red test. It also
proves nothing about the fixed-against-fraction behavior that the test claims.

#### Scenario: A wide terminal gives the fixed width

- **WHEN** an `lg` panel renders on a 200-column terminal
- **THEN** it measures the `width` of the preset, and not a fraction of 200

#### Scenario: A narrow terminal gives the clamp

- **WHEN** an `lg` panel renders on a 40-column terminal
- **THEN** it measures 36 columns, which is the `maxWidth` clamp

#### Scenario: A filter does not resize the panel

- **WHEN** a filter reduces a picker from 30 rows to 2 rows
- **THEN** the panel holds the `height` of the preset, with trailing empty rows

#### Scenario: A short terminal clamps the height

- **WHEN** an `lg` panel renders on a 15-row terminal
- **THEN** it measures 12 rows or fewer, and its chrome stays complete
