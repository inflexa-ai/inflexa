## MODIFIED Requirements

### Requirement: TextArea component with themed styling and mode tracking

The themed color contract additionally requires `focusedTextColor`, mirroring `textColor`'s value (theme `fg`, or `fgMuted` while busy): opentui's `TextareaRenderable` keeps separate focused/unfocused text colors and its `textColor` setter updates only the unfocused one, so omitting `focusedTextColor` leaves the focused state on opentui's built-in `#FFFFFF` — unreadable on light themes' `bgActive`.

#### Scenario: Themed colors applied

- **WHEN** a `TextArea` renders
- **THEN** its text color, focused text color, placeholder color, background, and focused background come from `theme()` — no inline hex values

#### Scenario: INSERT-mode text is readable on light themes

- **WHEN** the user types into a focused `TextArea` under a light theme
- **THEN** the typed text renders in the theme's `fg` (or `fgMuted` while busy) on `bgActive` — never opentui's white focused-text default

### Requirement: TextInput component with themed styling and per-keystroke callback

The themed color contract additionally requires `focusedTextColor`, exactly as for `TextArea`: `InputRenderable` extends `TextareaRenderable` and inherits the same focused/unfocused split and white focused-state default.

#### Scenario: INSERT-mode text is readable on light themes

- **WHEN** the user types into a focused `TextInput` under a light theme
- **THEN** the typed text renders in the theme's `fg` (or `fgMuted` while busy) on `bgActive` — never opentui's white focused-text default
