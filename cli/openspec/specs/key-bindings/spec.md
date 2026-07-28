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

The retract SHALL bind `up` from BOTH resting states of a fresh send: a pane-targeted layer live
while the stream pane is focused, and a textarea-targeted layer live while the composer is focused
with an empty buffer — each enabled only while the retract window holds (turn busy, nothing produced —
the conversation hook's gate). The pane layer SHALL outrank the pane's scroll layer, so during the
window `up` retracts instead of scrolling; the moment the gate closes (first output, turn end) the
binding disables and `up` reverts to scroll-up — `k` and the page keys scroll throughout. Outside the
window the textarea binding falls through to prompt-history recall, which is gated on the retract
window NOT holding and so claims the composer's `up` exactly when the retract releases it. A
completed retract SHALL seed the composer with the original text and focus it (INSERT, cursor at
end), so send-to-editing is two keys from the post-submit resting state; recall reuses that same
seed completion.

#### Scenario: Up-arrow on the pane retracts and lands in INSERT

- **WHEN** a turn is busy with no output, the pane holds focus (the post-submit state), and the user presses up
- **THEN** the retract runs and, on completion, the composer holds the original text with focus and the cursor at the end

#### Scenario: Up-arrow in the empty composer still retracts

- **WHEN** a turn is busy with no output, the composer is focused and empty, and the user presses up
- **THEN** the retract runs exactly as from the pane

#### Scenario: Scroll keys keep working during the window

- **WHEN** the retract window holds and the user presses `k` (or a page key) on the focused pane
- **THEN** the stream scrolls; only `up` is claimed by the retract

#### Scenario: Up reverts to scroll when the window closes

- **WHEN** the first output has arrived and the user presses up on the focused pane
- **THEN** the stream scrolls up and no retract occurs

#### Scenario: A non-empty buffer keeps cursor movement

- **WHEN** the retract window holds, the composer holds text, and the user presses up
- **THEN** the cursor moves within the buffer and no retract occurs

#### Scenario: Idle up-arrow recalls instead of retracting

- **WHEN** no turn is in flight and the composer is empty and the user presses up
- **THEN** no retract occurs and the press is governed by prompt-history recall

### Requirement: Up/down in the composer recall previously sent prompts

The composer SHALL carry a textarea-targeted layer binding `up` and `down` to prompt-history
recall, so a previously sent message can be brought back for re-sending or editing without
retyping it. The chords SHALL be the structural `KEYS.up`/`KEYS.down` and SHALL NOT be added to
`KEYBIND_DEFAULTS` — like the retract binding they share `up` with, they are conventional and carry
no config surface. Recall is composer-only: the stream pane's `up`/`down` remain scroll keys in
every state.

**Entries.** The history SHALL be the current session's own sent user messages as held by the
conversation store, ordered newest first, with runs of identical consecutive texts collapsed to a
single entry (re-sending the same prompt after a failed turn SHALL cost one recall step, not two).
Only *consecutive* duplicates collapse: identical texts separated by other prompts SHALL remain
distinct entries, and a step SHALL proceed from the entry the user is currently on — never from the
newest entry that happens to share its text. Deriving from the store rather than from a record of what was typed is what makes the exclusions
structural rather than a maintained filter list: docked-ask answers and the `/quit` aliases never
become user messages, so they can never appear; and a retracted prompt is spliced out of the store,
so it leaves no entry behind. History SHALL reach only as far as the store's mounted window — older
turns remain in the thread but are not mounted, and recall SHALL stop at that edge rather than
paging.

**Precedence and gate.** The layer SHALL be enabled whenever the retract window does not hold, so
retract keeps `up` for its window and recall takes over the moment the window closes — including
while a turn is still busy, once output has arrived. Recall SHALL seed the buffer only: it never
submits, and the submit path's existing busy and boot gates are unchanged.

**Entering recall.** From an empty buffer, `up` SHALL seed the newest entry. Entry from an empty
buffer SHALL always resume at the newest entry, so a position left behind by an earlier, abandoned
recall can never resurface.

**Staying in recall.** The layer SHALL remain live while the buffer still equals the entry it
seeded, and SHALL go inert as soon as the buffer differs from it — at which point `up`/`down` are
ordinary cursor movement again. Without this the feature would be unusable at one step deep: the
seed itself makes the buffer non-empty, and a bare empty-buffer gate would hand the next `up` to
cursor movement. The condition SHALL be derived from the live buffer on each keystroke, in the same
way the retract layer re-reads it — never tracked through edit events or a flag that would need
clearing.

**Stepping.** `up` SHALL move toward older entries and SHALL stay at the oldest when there are no
older ones — and that hold SHALL be a true no-op, leaving the buffer AND the caret untouched rather
than re-seeding identical text (which would move the caret to the end). `down` SHALL move toward newer entries; `down` from the newest entry SHALL clear the
buffer and leave recall, restoring the empty composer the user entered from. `down` while not in
recall SHALL fall through to cursor movement.

**Caret rule.** The composer is multi-line and recalled prompts frequently are, so a chord SHALL step
history only from the buffer EDGE it would move away from: `up` recalls only while the caret is on the
first row, `down` only while it is on the last row, and on every row in between both SHALL fall through
to the textarea's own caret movement. Without this a recalled multi-line prompt would hold both arrows
for as long as it sat in the buffer, leaving every row but the last unreachable — the caret could never
be moved to the first line to correct it. A single-line entry occupies the first and last row at once,
so it continues to recall in either direction from a single press. Row position SHALL be read from the
edit buffer, not from wrapped display lines: soft wrapping is presentation, and a chord that behaved
differently at two terminal widths would be indefensible.

**Seeding.** A recalled entry SHALL be placed in the buffer with the cursor at the end, the same
completion the retract seed uses, so a multi-line prompt lands ready to append to.

#### Scenario: Up in an empty composer recalls the newest prompt

- **WHEN** the composer is focused and empty, the retract window does not hold, and the user presses up
- **THEN** the buffer holds the most recently sent prompt with the cursor at the end

#### Scenario: Up again steps to the next-older prompt

- **GIVEN** the composer holds a recalled single-line entry, unedited
- **WHEN** the user presses up
- **THEN** the buffer holds the next-older prompt and no cursor movement occurs

#### Scenario: Up inside a recalled multi-line prompt walks the caret first

- **GIVEN** the composer holds a recalled three-row prompt with the caret on the last row
- **WHEN** the user presses up
- **THEN** the caret moves up one row and the buffer is unchanged
- **AND** only once the caret reaches the first row does a further up recall the next-older prompt

#### Scenario: Down inside a recalled multi-line prompt walks the caret first

- **GIVEN** the composer holds a recalled multi-row prompt with the caret above the last row
- **WHEN** the user presses down
- **THEN** the caret moves down one row and the buffer is unchanged
- **AND** only from the last row does a further down step toward the newer entries

#### Scenario: A single-line entry recalls in one press per direction

- **GIVEN** the composer holds a recalled single-line entry
- **WHEN** the user presses up, and separately down
- **THEN** each steps history immediately — the caret rule costs no extra keystroke when the entry is one row

#### Scenario: Editing a recalled prompt leaves recall

- **GIVEN** the composer holds a recalled entry
- **WHEN** the user edits the text and then presses up
- **THEN** the cursor moves within the buffer and no recall step occurs

#### Scenario: Down from the newest entry restores the empty composer

- **GIVEN** the composer holds the newest entry, reached by one up from an empty buffer
- **WHEN** the user presses down
- **THEN** the buffer is empty and a further down moves the cursor rather than recalling

#### Scenario: Up at the oldest entry stays put

- **GIVEN** the composer holds the oldest available entry, unedited
- **WHEN** the user presses up
- **THEN** the buffer is unchanged
- **AND** the caret is unchanged — a hold at history-top SHALL touch neither, so a caret deliberately placed on an earlier row is not returned to the end

#### Scenario: Entering recall again resumes at the newest

- **GIVEN** the user recalled several entries back, then cleared the composer
- **WHEN** the user presses up on the now-empty buffer
- **THEN** the buffer holds the most recently sent prompt, not the one the abandoned recall stopped at

#### Scenario: Retract outranks recall during its window

- **WHEN** a turn is busy with no output, the composer is focused and empty, and the user presses up
- **THEN** the retract runs and no recall occurs

#### Scenario: Recall is live once the retract window closes mid-turn

- **WHEN** a turn is busy, its first output has arrived, and the user presses up on the focused empty composer
- **THEN** the newest prompt is recalled into the buffer and no turn is submitted

#### Scenario: Consecutive duplicates collapse to one entry

- **GIVEN** the same prompt text was sent twice in a row
- **WHEN** the user recalls back past it
- **THEN** one up reaches it and the next up reaches the prompt sent before the pair

#### Scenario: Repeated non-adjacent prompts each keep their place

- **GIVEN** a prompt was sent, then a different prompt, then the first text again
- **WHEN** the user recalls back to the older occurrence of the repeated text and presses up
- **THEN** the buffer holds the prompt sent immediately before that older occurrence, not the one before the newer occurrence

#### Scenario: Ask answers and quit aliases never enter history

- **GIVEN** the user answered a docked ask from the composer and submitted a `/quit` alias during the session
- **WHEN** the user recalls through the history
- **THEN** neither the answer token nor the alias appears among the entries

#### Scenario: A retracted prompt leaves no entry

- **GIVEN** a sent message was retracted back into the composer
- **WHEN** the user clears the composer and recalls
- **THEN** the retracted text is not an entry, and recall reaches the prompt sent before it

#### Scenario: History reaches only the mounted window

- **WHEN** the user presses up repeatedly from an empty composer in a session with more turns than the store mounts
- **THEN** recall stops at the oldest mounted prompt and no paging occurs

#### Scenario: An empty history leaves the composer alone

- **WHEN** the composer is focused and empty in a session with no sent prompts and the user presses up
- **THEN** nothing happens

#### Scenario: The pane keeps its scroll keys

- **WHEN** the stream pane holds focus outside the retract window and the user presses up or down
- **THEN** the stream scrolls and no recall occurs

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
