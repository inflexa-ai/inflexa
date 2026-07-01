# dialog-system Specification (delta)

## ADDED Requirements

### Requirement: Dialog stack with mounted, hidden, inert lower entries

The dialog host (`src/tui/components/dialog/dialog_host.tsx`) SHALL maintain a LIFO stack of dialog entries and SHALL keep every entry mounted while it is on the stack. Non-top entries SHALL be hidden (not rendered to the screen) and inert (their key layers inactive), but their component state (signals, input buffers, cursors) SHALL be preserved. The host SHALL expose to each entry, via context, a reactive `isTop` accessor and a hook (`useDialogBindings`) that registers a keymap layer gated on that entry being topmost. Pushing a dialog on top of another SHALL NOT destroy the lower dialog's state; closing the top SHALL reveal the lower dialog exactly as it was.

#### Scenario: Lower dialog survives stacking

- **WHEN** dialog A contains typed input and dialog B is pushed on top, then B is closed
- **THEN** A is visible again with its typed input and cursor state intact

#### Scenario: Lower dialog keys are inert

- **WHEN** two dialogs are stacked and a key bound by the lower dialog (via `useDialogBindings`) is pressed
- **THEN** the lower dialog's binding does not fire; only the top entry's layers and mode-independent app layers may handle the key

#### Scenario: Only the top entry is painted

- **WHEN** two dialogs are stacked
- **THEN** only the top dialog's panel is visible on screen; the lower entry renders nothing visible

### Requirement: Single close funnel with reasons

The host SHALL expose `dialogClose(reason)` with `reason ∈ "cancel" | "dismiss" | "commit"` (default `"commit"` — a bare programmatic close is the tail of a submit/select flow, which is what lets existing `ws.closeDialog()` call sites keep working unchanged) as the ONLY way a dialog leaves the stack (including `dialogReplace`/`dialogClear` sweeps, which SHALL report `"dismiss"`). Every dismissal gesture SHALL route through it with an explicit reason: the host's esc binding closes with `"cancel"`, click-outside and the app's ctrl+c dismissal close with `"dismiss"`. A push-time `onClose(reason)` callback SHALL be the single lifecycle hook, fired on every path; content-dialog `onCancel`/`onClose` props SHALL be invoked from it (via the host's `useDialogCancel`/`useDialogClose` hooks), never from a parallel per-gesture path, and nested `dialogClose` calls made from within close-hook dispatch SHALL be swallowed so legacy `ws.closeDialog()` handler bodies cannot double-pop a stacked dialog.

#### Scenario: Cancel cleanup runs on every gesture

- **WHEN** a dialog pushed with an `onClose` callback is dismissed via esc, via click-outside, or via ctrl+c
- **THEN** `onClose` fires exactly once per dismissal with reason `"cancel"`, `"dismiss"`, and `"dismiss"` respectively

#### Scenario: Commit is distinguishable from cancel

- **WHEN** a prompt is submitted and its flow closes the dialog
- **THEN** the entry's `onClose` receives `"commit"`, allowing callers to separate confirm cleanup from cancel cleanup

### Requirement: Host-owned structural keys with per-dialog close interception

The host SHALL own a single esc binding (active while the stack is non-empty) that closes the top entry with reason `"cancel"`; content dialogs SHALL NOT each bind their own esc-to-cancel layer. A dialog entry MAY register an `onRequestClose(reason) → boolean` interceptor (via `useDialogCloseGuard`); when it returns false, the close is vetoed and the entry stays open. A busy `PromptDialog` SHALL veto all reasons — busy blocks submit AND every dismissal gesture. The app's abort chord SHALL escalate past a veto on a quick SECOND press: the first vetoed press stops at the veto (the dialog shows its own feedback — a dirty-config arm, a busy spinner), and a second press within the escalation window proceeds to the abort's next tier, keeping a panic exit within two keystrokes without letting a single accidental ctrl+c blow past a dirty-form guard.

#### Scenario: One esc binding closes any dialog

- **WHEN** any content dialog is open and esc is pressed
- **THEN** the host's binding closes it with reason `"cancel"`; no content dialog defines its own esc layer

#### Scenario: Busy prompt is dismissal-proof

- **WHEN** a `PromptDialog` is busy and the user presses esc, clicks outside, or presses ctrl+c once
- **THEN** the dialog stays open and its busy state is unaffected

#### Scenario: Abort escalates past a veto on the second press

- **WHEN** a vetoing dialog is open and the abort chord is pressed twice in quick succession
- **THEN** the first press stops at the veto (the dialog stays open) and the second press proceeds to the abort's next tier (stream abort / quit) rather than doing nothing

### Requirement: Click model — outside dismisses only on full outside click, inside stays capturable

The overlay SHALL dismiss the top dialog (reason `"dismiss"`) only when BOTH the mouse-down and the mouse-up occur outside the content panel; a press inside the panel followed by a release outside SHALL NOT dismiss. The existing text-selection guard SHALL be preserved (a drag-release that ends a selection does not dismiss). Mouse events inside the content panel SHALL remain deliverable to inner components (click-to-focus inputs, button rows) and SHALL NOT propagate to the scrim's dismiss handler.

#### Scenario: Press inside, release outside

- **WHEN** the user presses the mouse inside the dialog panel, drags, and releases over the scrim
- **THEN** the dialog stays open

#### Scenario: Full click outside dismisses

- **WHEN** the user presses and releases the mouse over the scrim with no active text selection
- **THEN** the top dialog closes with reason `"dismiss"`

#### Scenario: Inner components receive clicks

- **WHEN** the user clicks a button or input inside the dialog panel
- **THEN** the inner component's mouse handler fires and the dialog does not dismiss

### Requirement: Initial focus is declared by the dialog and applied by the host

Each dialog entry SHALL declare its initial focus target through the host (via the entry context), and the host SHALL apply it when the entry becomes top — on push, and again when a covering entry closes and reveals it. Dialog components SHALL NOT race their own mount-time focus grabs against the overlay. At the 0→N boundary the host SHALL save and blur the app's focused renderable, and at N→0 restore it (verifying it is still in the tree) — the existing save/restore contract is unchanged. Renderable focus SHALL be the single source of truth for which widget consumes unbound keys; any dialog rendering a visual "active" indicator over focusable widgets SHALL keep that indicator consistent with renderable focus (moving the indicator moves renderable focus).

#### Scenario: Focus lands on the declared target

- **WHEN** a dialog declaring its input as the initial focus target is pushed
- **THEN** that input is the focused renderable once the dialog is top, without the dialog running its own mount-time focus microtask

#### Scenario: Revealed dialog regains focus

- **WHEN** a covering dialog closes and reveals the entry beneath
- **THEN** the revealed entry's declared focus target is focused again

#### Scenario: Visual active state tracks renderable focus

- **WHEN** a form dialog's tab cycle moves the visual active indicator from its text field to an option row
- **THEN** the text field's renderable is blurred, so unbound printable keys no longer insert into it
