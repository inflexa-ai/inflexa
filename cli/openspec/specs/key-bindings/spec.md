# key-bindings Specification

## Purpose
TBD - created by archiving change standardize-tui-layout. Update Purpose after archive.
## Requirements
### Requirement: Central platform-neutral keymap

The system SHALL define a single keymap module `src/tui/keymap.ts` as the keybinding ENGINE for the whole TUI. Each bound action maps to its real key chord (or multi-stroke sequence); its display label SHALL be DERIVED from the chord by `chordLabel`, never hand-kept beside it, so a label can never drift from the matching. Labels SHALL be platform-neutral and ALWAYS lowercase `ctrl+`/`alt+` text (e.g. `ctrl+k`, `ctrl+b`, `ctrl+c`, `esc`, `enter`) — identical on macOS, Linux, and Windows. No macOS ⌘/⌥ glyphs are used: terminals do not forward Cmd to the app. The chord-MATCHING core SHALL remain opentui-type-free (the structural `matchChord` plus sequence helpers); only the root handler (`useKeymapRoot`) and the focus-`target` check MAY touch opentui. The module SHALL be the single source of every keybind hint shown anywhere in the TUI — the chat shell, the config screen, and every dialog footer — read via `chordLabel`/`keybindLabel`/`sequenceLabel`, never as an inline literal string. Structural dialog/navigation chords SHALL come from a shared `KEYS` table.

#### Scenario: Labels are identical on every platform

- **WHEN** the keymap renders the open-palette and sidebar-toggle labels
- **THEN** they read `ctrl+k` and `ctrl+b` regardless of the host OS

#### Scenario: Every hint is lowercase

- **WHEN** any keybind hint label is read from the keymap
- **THEN** it contains no uppercase letters (e.g. `ctrl+c`, `esc`, `enter`, never `Ctrl+C` or `Esc`)

#### Scenario: Labels are derived from the chord

- **WHEN** a binding's chord changes (in code or via a config remap)
- **THEN** its displayed hint label updates with no separate label edit, because the label is computed from the chord

#### Scenario: Single source of truth

- **WHEN** a keybind hint is shown anywhere in the TUI (status bar, palette row, dialog footer)
- **THEN** its label string comes from `src/tui/keymap.ts`, not a literal inline string

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

### Requirement: Declarative binding layers dispatched centrally

A component SHALL declare its keys as a reactive layer via `useBindings(() => ({ enabled?, mode?, target?, priority?, bindings }))` rather than owning a `useKeyboard` handler. Exactly one `useKeymapRoot()` per renderer (the chat `App`; the standalone config screen) SHALL install the single root `useKeyboard` that collects the active layers and routes each keystroke to the winning binding. The dispatcher SHALL filter layers by `enabled` and sort by `priority` (insertion order breaking ties), run the first matching binding, and `preventDefault` it by default so a focused textarea does not also consume it. A binding marked `fallthrough` SHALL let lower-priority layers continue to be considered. Key `release` events SHALL be ignored.

#### Scenario: A component declares keys without a raw handler

- **WHEN** a dialog or screen needs key handling
- **THEN** it calls `useBindings(...)` and does not call `useKeyboard` or branch on `key.name` itself

#### Scenario: Higher priority wins a conflict

- **WHEN** two active layers bind the same chord with different priorities
- **THEN** the higher-priority binding runs and the lower one does not

#### Scenario: A disabled layer is inert

- **WHEN** a layer's `enabled` evaluates false at the moment a key is pressed
- **THEN** none of its bindings run, and the key falls through to other layers

### Requirement: Modal capture via a mode stack

The engine SHALL maintain a LIFO mode stack with `currentMode()` returning the top (or `MODE_BASE` when empty). Base-UI layers SHALL tag `mode: MODE_BASE`; opening a dialog SHALL `pushMode(MODE_MODAL)` (tied to the dialog stack, popped when it empties), which suspends every `MODE_BASE` layer at once — with no per-binding `if (dialogOpen)`. A layer that omits `mode` SHALL stay active in any mode (so a dialog's own keys, and the always-on streaming abort, keep working under a modal).

#### Scenario: Opening a dialog suspends the base keymap

- **WHEN** a dialog is open (the modal mode is pushed)
- **THEN** the base-mode palette/sidebar bindings do not fire, while the dialog's own (mode-less) bindings do

#### Scenario: Abort survives a modal

- **WHEN** a stream is running, a dialog is open, and the abort chord is pressed
- **THEN** the mode-less, high-priority abort binding still cancels the stream

### Requirement: Leader key and multi-stroke chord sequences

A binding's key MAY be a multi-stroke sequence. A configurable leader (`app.leader`, default `ctrl+x`) SHALL begin a timed sequence; a `<leader>` token in a key spec SHALL expand to the resolved leader chord, and a comma SHALL denote alternatives. While a sequence is pending: a strict-prefix match SHALL hold the keystroke (arming a timeout of `leaderTimeout` ms after which the pending sequence is abandoned), a full match SHALL run the binding and clear the pending state, Escape SHALL abandon the pending sequence, and Backspace SHALL pop the last stroke.

#### Scenario: A two-stroke sequence completes

- **WHEN** the leader is pressed, then the next stroke of a `<leader>`-prefixed binding
- **THEN** the binding runs only on the second stroke, and the pending state clears

#### Scenario: Escape abandons a half-typed chord

- **WHEN** the leader is pressed and then Escape
- **THEN** no binding runs and the pending sequence is cleared

### Requirement: which-key panel

While a sequence is pending, a which-key panel SHALL auto-appear listing every reachable next stroke, grouped by the bindings' `group`, labelled from each binding's `desc`. The panel SHALL read reactive engine state (`leaderActive`, `pendingSequence`, `reachableKeys`) so it refreshes as the user types into a sequence, and SHALL hide when no sequence is pending. Labels SHALL be the bindings' own metadata — no separate shortcut table.

#### Scenario: The menu shows reachable keys

- **WHEN** the leader is pressed and bindings of the form `<leader>x` exist
- **THEN** the panel lists each `x` with its description, grouped, and hides once the sequence completes or is abandoned

### Requirement: Focus-target scoping

A layer MAY carry a focus `target` renderable; it SHALL be active only while that renderable, or a descendant of it, is the renderer's currently-focused node. This is the fine-grained complement to `mode` for screens with more than one focusable region.

#### Scenario: A target-scoped binding is gated by focus

- **WHEN** a layer specifies a `target` and that target (or a descendant) is not focused
- **THEN** the layer's bindings do not fire, even in the correct mode

### Requirement: User-remappable app keybindings

App-level keys SHALL be remappable via a `keybinds` map in the user config (command id → key string), resolved once over `KEYBIND_DEFAULTS`. An override for an unknown id SHALL be ignored, and an unparseable key value SHALL degrade to a non-matching chord (never an error). Resolution SHALL be load-once (a restart applies a config edit), so no config read occurs on the keystroke path.

#### Scenario: A user remaps a key

- **WHEN** the config sets `keybinds["app.command-palette"]` to `ctrl+p`
- **THEN** Ctrl+P opens the command palette and its displayed hint reads `ctrl+p`

#### Scenario: A stray override does not break config

- **WHEN** the config contains an unknown keybind id or an unparseable key value
- **THEN** config still loads and the affected entry is simply ignored

