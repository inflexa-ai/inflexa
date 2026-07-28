## ADDED Requirements

### Requirement: Run-activity panel actions are declarative bindings

Panel navigation, dismissal, and restore SHALL be declared as bindings in a reactive layer
and dispatched through the central keymap. No component SHALL install its own keyboard
handler or test key names directly for these actions.

Their displayed labels SHALL be derived from their chords rather than hand-written beside them, so
a remapped binding cannot advertise a key it no longer answers to.

The panel's layer SHALL be suspended while a dialog is open, through the existing mode stack, so
a panel chord cannot fire underneath an open prompt.

#### Scenario: Panel actions dispatch centrally

- **WHEN** the user presses the panel's navigation or dismiss chord
- **THEN** the action runs through the central keymap dispatch, with no component-level key handler involved

#### Scenario: Labels follow their chords

- **WHEN** a panel binding is remapped
- **THEN** the label shown for it changes with it

#### Scenario: A dialog suspends the panel's keys

- **WHEN** any dialog is open over the chat screen
- **THEN** the panel's own bindings are inert until it closes

### Requirement: Panel chords stay terminal-deliverable and discoverable

The panel's chords SHALL follow the existing chord vocabulary: modifier chords SHALL use Ctrl
rather than Alt, since terminals deliver Alt unreliably and one platform composes it into a
character; no unmodified printable key SHALL be bound in a layer that coexists with a focused text
input; and labels SHALL be lowercase.

Each binding SHALL carry a description and group so it appears in the which-key overlay without
being documented separately.

The panel's restore action SHALL additionally be reachable as a command in the palette, so a user
who has dismissed the panel and does not recall the chord can bring it back — mirroring how the
sidebar toggle is exposed both ways.

#### Scenario: No Alt-based chord is introduced

- **WHEN** the panel's bindings are declared
- **THEN** none of them uses Alt as a modifier

#### Scenario: Typing in the composer is unaffected

- **WHEN** the input is focused and the user types printable characters
- **THEN** no panel binding intercepts them

#### Scenario: The bindings document themselves

- **WHEN** the user opens the which-key overlay with the panel's leader prefix pending
- **THEN** the panel's actions are listed with their descriptions

#### Scenario: Restore is reachable without the chord

- **WHEN** the panel has been dismissed and the user opens the command palette
- **THEN** a command restores the panel
