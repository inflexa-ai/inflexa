# key-bindings Specification (delta)

## ADDED Requirements

### Requirement: Dialog-entry layers gate on their entry being topmost

A keymap layer belonging to a dialog SHALL be registered through the dialog host's `useDialogBindings` wrapper, which ANDs the layer's `enabled` with its stack entry's reactive `isTop`. This qualifies the mode-stack rule that a mode-less layer is active in every mode: modal-over-modal cannot be expressed by the mode stack (both entries are "modal"), so within the dialog stack, entry-topmost gating — not mode — decides which dialog's keys are live. The keymap engine itself SHALL NOT special-case dialogs; `isTop` is an ordinary reactive `enabled` input re-evaluated per keystroke.

#### Scenario: Stacked dialog suspends the keys beneath it

- **WHEN** dialog B is pushed on top of dialog A and a chord bound only by A is pressed
- **THEN** A's binding does not fire while B is top, and fires again once B closes

#### Scenario: Engine stays dialog-agnostic

- **WHEN** `keymap.ts` is read after the change
- **THEN** it contains no dialog-stack imports or special cases; the gating lives in the dialog host's wrapper

### Requirement: No unmodified printable keys in layers coexisting with focused text inputs

A layer that can be active while a text input or textarea is focused MUST NOT bind unmodified printable keys (bare letters, digits, or space): the engine dispatches before the focused editor and `preventDefault`s matches, so such a binding steals typed characters from the input. Bare printable keys remain allowed in layers that can never coexist with a focused editor (e.g. `q` in a read-only results dialog, NORMAL-mode vim keys gated by focus `target`). The config screen's form layer SHALL comply by being suspended (via dialog-entry gating or an `enabled` gate) whenever a prompt dialog is open above it.

#### Scenario: Typing into a prompt over the config form

- **WHEN** the config screen's postgres-field prompt is open and the user types `s`, `q`, or space
- **THEN** the character is inserted into the prompt's input; no form action (save, exit, toggle) fires

#### Scenario: Read-only dialog may bind bare keys

- **WHEN** a dialog containing no text input (e.g. `ResultsDialog`) binds `q` to close
- **THEN** the binding is compliant because no focused editor can coexist with it
