## MODIFIED Requirements

### Requirement: Run-activity panel actions are declarative bindings

The panel actions MUST be bindings in a reactive layer, and the central keymap MUST dispatch them. The panel actions are the navigation, the dismissal, the restore, and the abort of the focused run. A component MUST NOT install its own keyboard handler for these actions, and it MUST NOT compare key names directly for them.

The displayed label of each action MUST come from its chord, not from text written beside it. Thus a remapped binding cannot show a key that it no longer answers.

The layer of the panel MUST be suspended while a dialog is open, through the existing mode stack. Thus a panel chord cannot fire under an open prompt, and that includes the confirmation of the abort.

The abort binding MUST be a leader sequence whose final stroke is remappable. Its layer MUST be enabled only while the panel is visible and shows a run.

#### Scenario: Panel actions dispatch centrally

- **WHEN** the user presses the panel's navigation, dismiss, or abort chord
- **THEN** the action runs through the central keymap dispatch, with no component-level key handler involved

#### Scenario: Labels follow their chords

- **WHEN** a panel binding is remapped
- **THEN** the label shown for it changes with it

#### Scenario: A dialog suspends the panel's keys

- **WHEN** any dialog is open over the chat screen
- **THEN** the panel's own bindings are inert until it closes

#### Scenario: The abort binding documents itself only where it acts

- **WHEN** the user opens the which-key overlay with the leader pending
- **THEN** the abort binding is listed while the panel shows a run, and it is absent while the panel shows a profile or is hidden
