# tui-input-primitives Specification

## Purpose

Shared themed text-entry primitives for the TUI: `TextArea` (multi-line, mode-tracking, submit/newline chords) and `TextInput` (single-line, per-keystroke), each with chrome tiers so hosts compose the right amount of border/mode UI.

## Requirements

### Requirement: TextArea component with themed styling and mode tracking

The system SHALL provide a `TextArea` component in `src/tui/components/text_area.tsx` that wraps opentui's `<textarea>` with the standard themed color contract: `textColor` from `theme().fg`, `placeholderColor` from `theme().fgMuted`, `backgroundColor` from `theme().bg`, `focusedBackgroundColor` from `theme().bgActive`. It SHALL accept a `placeholder` string, an optional `initialValue`, an optional `height` (defaulting to textarea auto-sizing), an `onSubmit` callback receiving the textarea's plain text, an `onRef` callback receiving the `TextareaRenderable`, and a reactive `focused` accessor that drives mode display and border color.

#### Scenario: Themed colors applied

- **WHEN** a `TextArea` renders
- **THEN** its text color, placeholder color, background, and focused background come from `theme()` — no inline hex values

#### Scenario: Submit callback fires on Enter

- **WHEN** the user presses Enter while the textarea is focused
- **THEN** the `onSubmit` callback is called with the textarea's `plainText`

#### Scenario: Ref callback exposes the renderable

- **WHEN** `TextArea` mounts
- **THEN** the `onRef` callback receives the `TextareaRenderable`, allowing the host to read/clear the buffer and manage focus

### Requirement: TextArea chrome tiers

`TextArea` SHALL accept a `chrome` prop with three tiers: `"full"`, `"compact"`, and `"bare"`.

- **`"full"`**: renders a bordered box with `paddingLeft`/`paddingRight` of 1. The border color SHALL be `theme().borderFocus` when focused (INSERT mode) and `theme().border` when blurred (NORMAL mode). The component SHALL NOT render a footer row — the host (e.g. ChatBar) adds its own footer externally.
- **`"compact"`**: renders a bordered box identical to `"full"`, but also renders the mode word (`INSERT` or `NORMAL`) in the border title via opentui's `title` box prop, right-aligned (`titleAlignment="right"`). The title color SHALL be `theme().fgMuted` for INSERT and `theme().accent` for NORMAL. No footer row.
- **`"bare"`**: renders the textarea with no border and no mode text. The mode signal is the background color shift only (`bgActive` when focused, `bg` when blurred).

#### Scenario: Full chrome has border but no footer

- **WHEN** `TextArea` renders with `chrome="full"`
- **THEN** it shows a bordered box with focus-dependent border color and no footer row

#### Scenario: Compact chrome shows mode in border title

- **WHEN** `TextArea` renders with `chrome="compact"` and the textarea is focused
- **THEN** the border title reads "INSERT" in `theme().fgMuted`

#### Scenario: Compact chrome shows NORMAL in border title

- **WHEN** `TextArea` renders with `chrome="compact"` and the textarea is blurred
- **THEN** the border title reads "NORMAL" in `theme().accent` and the border color is `theme().border`

#### Scenario: Bare chrome has no border

- **WHEN** `TextArea` renders with `chrome="bare"`
- **THEN** no border is rendered and no mode text is displayed — mode signal is background color only

### Requirement: TextArea submit and newline chords at the renderable level

`TextArea` SHALL configure opentui's renderable-level `keyBindings` for submit and newline, sourced from `SUBMIT_CHORD` and `NEWLINE_CHORD` in `keymap.ts`. The submit binding SHALL map Enter to the `"submit"` action. The newline binding SHALL map Ctrl+J to the `"newline"` action. A bonus Shift+Enter SHALL also map to `"newline"` for kitty-protocol-capable terminals. These stay at the renderable level (not the keymap engine) because they are cursor-aware editing actions.

#### Scenario: Enter submits

- **WHEN** the user presses Enter in the textarea
- **THEN** the textarea fires its submit action (which triggers `onSubmit`)

#### Scenario: Ctrl+J inserts a newline

- **WHEN** the user presses Ctrl+J in the textarea
- **THEN** a newline is inserted at the cursor position

#### Scenario: Shift+Enter inserts a newline on capable terminals

- **WHEN** the user presses Shift+Enter on a kitty-protocol terminal
- **THEN** a newline is inserted at the cursor position

### Requirement: TextInput component with themed styling and per-keystroke callback

The system SHALL provide a `TextInput` component in `src/tui/components/text_input.tsx` that wraps opentui's `<input>` with the standard themed color contract (same as TextArea: `theme().fg`, `theme().fgMuted`, `theme().bg`, `theme().bgActive`). It SHALL accept a `placeholder` string, an `onInput` callback invoked on every keystroke with the current text value, and an `onRef` callback receiving the `InputRenderable`. It SHALL NOT have mode tracking, submit chords, or newline chords — the `<input>` element serves filter/search patterns where the user is always typing.

#### Scenario: Themed colors applied

- **WHEN** a `TextInput` renders
- **THEN** its text color, placeholder color, background, and focused background come from `theme()`

#### Scenario: Per-keystroke callback fires

- **WHEN** the user types into the input
- **THEN** the `onInput` callback is called with the current text value on every keystroke

#### Scenario: No mode concept

- **WHEN** a `TextInput` is rendered
- **THEN** there is no INSERT/NORMAL mode tracking, no submit chord, and no newline chord

### Requirement: Editors control mount focus via autoFocus

Both `TextArea` and `TextInput` SHALL accept `autoFocus?: boolean` (default `true`): it drives the renderable-level `focused` prop, so `autoFocus={false}` mounts the editor blurred without grabbing the surface's focus (list-first dialogs, gallery exhibits, showcased dialogs). The internal focus signal SHALL be seeded from `autoFocus` so a blurred mount renders blurred/NORMAL chrome from the first frame — the renderable emits no `blurred` event at mount to correct a wrong seed.

#### Scenario: Blurred mount renders truthful chrome

- **WHEN** a compact-chrome editor mounts with `autoFocus={false}`
- **THEN** it renders the blurred border color (and, for TextArea, the NORMAL title) without any focus event having fired

#### Scenario: Default grabs focus

- **WHEN** an editor mounts without `autoFocus`
- **THEN** it mounts focused (the prompt/filter-first default)

### Requirement: TextInput chrome tiers

`TextInput` SHALL accept a `chrome` prop with two tiers: `"compact"` and `"bare"`.

- **`"compact"`**: renders a bordered box with the input inside. Border color SHALL be `theme().borderFocus` when focused and `theme().border` when blurred.
- **`"bare"`**: renders the input with no border.

`TextInput` SHALL NOT support `chrome="full"` — the full tier (with footer row) is a TextArea concept. `TextInput` does not have mode tracking, so no mode word appears in the border title for compact.

#### Scenario: Compact chrome has border

- **WHEN** `TextInput` renders with `chrome="compact"`
- **THEN** it shows a bordered box with focus-dependent border color

#### Scenario: Bare chrome has no border

- **WHEN** `TextInput` renders with `chrome="bare"`
- **THEN** no border is rendered

### Requirement: Design gallery entries for TextArea and TextInput

The design gallery (`src/tui/layout/design_gallery.tsx`) SHALL include entries showcasing both `TextArea` and `TextInput` in all their chrome tiers. The TextArea gallery entries SHALL show both INSERT and NORMAL mode states for each chrome tier. The TextInput gallery entries SHALL show the compact and bare tiers.

#### Scenario: TextArea gallery coverage

- **WHEN** the design gallery renders the TextArea section
- **THEN** it shows TextArea in full/compact/bare chrome, each in both INSERT and NORMAL states

#### Scenario: TextInput gallery coverage

- **WHEN** the design gallery renders the TextInput section
- **THEN** it shows TextInput in compact and bare chrome

### Requirement: TextInput enter-submit callback

`TextInput` SHALL accept an optional `onSubmit?: (value: string) => void`, invoked with the input's current text when the user presses enter, mirroring `TextArea`'s submit contract at the renderable level. When `onSubmit` is omitted, enter SHALL remain a no-op for the input (existing callers — e.g. `SelectDialog`'s filter, whose enter is handled by its list's keymap layer — are unaffected). `TextInput` SHALL NOT gain a newline mechanism; it remains strictly single-line.

#### Scenario: Enter submits the value

- **WHEN** a `TextInput` with `onSubmit` is focused and the user presses enter
- **THEN** `onSubmit` receives the input's current text

#### Scenario: Omitting onSubmit preserves existing behavior

- **WHEN** a `TextInput` without `onSubmit` is focused and the user presses enter
- **THEN** the input itself does nothing with the key; a host keymap layer may still handle it
