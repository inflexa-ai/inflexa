## ADDED Requirements

### Requirement: Escape clears the active text selection first

The chat app SHALL register a mode-less keymap layer that binds `esc` to clear the renderer's
active mouse text selection (`renderer.clearSelection()`), enabled only while a selection with
non-empty selected text exists (`renderer.getSelection()?.getSelectedText()` — the app's
established "real selection" predicate, since a plain click on selectable text creates an empty
`Selection`). The layer's priority SHALL sit above the dialog host's esc layer and below the abort
layer, so with a selection active `esc` deselects and does nothing else — the dialog stays open,
the textarea keeps focus — and with no selection the layer is disabled and `esc` falls through to
its existing behaviors unchanged (close dialog, INSERT→NORMAL, chord abort). The binding SHALL
only clear; it MUST NOT copy (copy-on-select already writes the clipboard on mouse-up). The keymap
engine's pending-leader-sequence abort runs before all layers by design; `esc` pressed mid-chord
aborts the chord and leaves the selection for the next press — an accepted interaction.

#### Scenario: Esc deselects instead of closing a dialog

- **WHEN** text is selected inside an open dialog and the user presses `esc`
- **THEN** the selection clears and the dialog remains open; a second `esc` closes it

#### Scenario: Esc deselects without leaving INSERT

- **WHEN** text is selected while the chat textarea is focused and the user presses `esc`
- **THEN** the selection clears and the textarea keeps focus; a second `esc` switches to NORMAL as before

#### Scenario: No selection means no behavior change

- **WHEN** no text selection exists and the user presses `esc` anywhere in the TUI
- **THEN** `esc` behaves exactly as it did before this requirement (the layer is disabled)

#### Scenario: An empty click-selection does not arm the layer

- **WHEN** the user clicks (without dragging) on selectable text, creating an empty selection, and presses `esc`
- **THEN** `esc` falls through to its existing behavior — the layer arms only on non-empty selected text
