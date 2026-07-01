# tui-input-primitives Specification (delta)

## ADDED Requirements

### Requirement: TextInput enter-submit callback

`TextInput` SHALL accept an optional `onSubmit?: (value: string) => void`, invoked with the input's current text when the user presses enter, mirroring `TextArea`'s submit contract at the renderable level. When `onSubmit` is omitted, enter SHALL remain a no-op for the input (existing callers — e.g. `SelectList`'s filter, whose enter is handled by its keymap layer — are unaffected). `TextInput` SHALL NOT gain a newline mechanism; it remains strictly single-line.

#### Scenario: Enter submits the value

- **WHEN** a `TextInput` with `onSubmit` is focused and the user presses enter
- **THEN** `onSubmit` receives the input's current text

#### Scenario: Omitting onSubmit preserves existing behavior

- **WHEN** a `TextInput` without `onSubmit` is focused and the user presses enter
- **THEN** the input itself does nothing with the key; a host keymap layer may still handle it
