## ADDED Requirements

### Requirement: Esc double-press interrupts only from the chat's NORMAL mode

The interrupt SHALL be remappable as `app.interrupt` in `KEYBIND_DEFAULTS` (default `esc`) and SHALL
dispatch as ordinary consuming bindings in the chat's scroll-pane-focused (NORMAL) layer, enabled
only while a turn is busy, no dialog is stacked, and no text selection is active. The first press
SHALL arm the interrupt for a 5-second window; a second press while armed SHALL fire the turn abort.
Esc presses claimed by any other owner SHALL NOT count toward the interrupt: dialog esc closes its
dialog, selection-clear clears the selection, and the composer's esc switches INSERT→NORMAL without
arming. When idle the layer SHALL be disabled, leaving esc dispatch — including NORMAL mode's
deliberate no-op — unchanged.

#### Scenario: Double esc in NORMAL interrupts

- **WHEN** a turn is busy, the chat is the main focus in NORMAL mode, and the user presses esc twice within the window
- **THEN** the turn aborts

#### Scenario: The composer's esc only switches modes

- **WHEN** a turn is busy, the composer is focused, and the user presses esc
- **THEN** focus moves to the scroll pane as before and the interrupt is not armed

#### Scenario: A dialog's esc never counts

- **WHEN** a turn is busy, a dialog is open, and the user presses esc
- **THEN** the dialog closes and the interrupt is neither armed nor fired

#### Scenario: Selection-clear never counts

- **WHEN** a turn is busy, a text selection is active, and the user presses esc
- **THEN** the selection clears and the interrupt is not armed

#### Scenario: Remapping moves both phases

- **WHEN** the config remaps `app.interrupt` to another key
- **THEN** arm and fire follow the new chord and the displayed hint derives from it

### Requirement: Up-arrow in an empty composer retracts the just-sent message

A textarea-targeted layer SHALL bind `up` to the retract action, enabled only while the composer
buffer is empty AND the retract window holds (turn busy, nothing produced — the conversation hook's
gate). Outside that state the binding SHALL be disabled so `up` falls through to normal cursor
movement, and the chord remains free for a future prompt-history recall when idle.

#### Scenario: Up-arrow retracts during the window

- **WHEN** a turn is busy with no output, the composer is empty, and the user presses up
- **THEN** the retract action runs

#### Scenario: A non-empty buffer keeps cursor movement

- **WHEN** the composer holds text and the user presses up
- **THEN** the cursor moves within the buffer and no retract occurs

#### Scenario: Idle up-arrow does nothing

- **WHEN** no turn is in flight and the composer is empty and the user presses up
- **THEN** nothing happens (reserved for future history recall)
