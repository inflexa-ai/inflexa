# key-bindings Specification

## Purpose
TBD - created by archiving change standardize-tui-layout. Update Purpose after archive.
## Requirements
### Requirement: Central platform-neutral keymap

The system SHALL define a single keymap module `src/tui/keymap.ts` mapping each logical action (e.g. open palette, toggle sidebar, abort) to its real key chord plus a fixed display label. Labels SHALL be platform-neutral and ALWAYS lowercase `ctrl+`/`alt+` text (e.g. `ctrl+k`, `ctrl+b`, `ctrl+c`, `esc`, `enter`) — identical on macOS, Linux, and Windows. Lowercase is a fixed rule for every keybind hint shown in the TUI. No macOS ⌘/⌥ glyphs are used: terminals do not forward Cmd to the app, so the project deliberately targets one lowercase Ctrl/Alt convention everywhere. The module SHALL import no platform or opentui APIs (it is pure data plus a structural `matchChord`). It SHALL be the single source of keybind hint strings shown anywhere in the TUI — the chat shell and the config screen (which shares `StatusBar`) — and its action set SHALL include the config screen's keys (e.g. `save`, `exit`, `moveSelection`). The previously hardcoded hint strings in `app.tsx`, `app_config.tsx`, and the palette SHALL be replaced by reads from this module.

#### Scenario: Labels are identical on every platform

- **WHEN** the keymap renders the open-palette and sidebar-toggle labels
- **THEN** they read `ctrl+k` and `ctrl+b` regardless of the host OS

#### Scenario: Every hint is lowercase

- **WHEN** any keybind hint label is read from the keymap
- **THEN** it contains no uppercase letters (e.g. `ctrl+c`, `esc`, `enter`, never `Ctrl+C` or `Esc`)

#### Scenario: Single source of truth

- **WHEN** a keybind hint is shown anywhere in the TUI (status bar, palette row)
- **THEN** its label string comes from `src/tui/keymap.ts`, not a literal inline string

#### Scenario: Config screen hints come from the keymap

- **WHEN** the config screen renders its `StatusBar` key hints (save / exit / move)
- **THEN** those label strings are read from `src/tui/keymap.ts`, not inlined in `app_config.tsx`

### Requirement: Real chords stay terminal-deliverable

The primary navigation chords SHALL use Ctrl, NOT Alt, because terminals deliver Alt/Option unreliably — on macOS the Option key composes a special character (e.g. Option+s → `ß`) instead of sending a modifier, so an Alt chord may never reach the app. Cmd/⌘ is likewise never used — terminals do not forward it. The chord matcher SHALL still accept Alt from EITHER the `option` or the `meta` flag for any binding that opts into it (e.g. the textarea newline), because terminals that DO deliver Alt do so inconsistently. Changing a chord or its label SHALL be a single edit localized to the keymap module.

#### Scenario: Navigation chords are Ctrl

- **WHEN** the palette-open and sidebar-toggle chords are defined
- **THEN** they are `ctrl+k` and `ctrl+b` (Ctrl), not Alt chords

#### Scenario: Invocation chord works on any platform

- **WHEN** Ctrl+K is pressed in the chat
- **THEN** the command palette opens

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

