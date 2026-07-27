## ADDED Requirements

### Requirement: A forced full repaint recovers a terminal surface changed behind the renderer

The TUI SHALL provide a forced full repaint that invalidates the renderer's shadow buffer so the next frame rewrites EVERY cell, and SHALL treat this as the sole recovery from screen damage caused outside the renderer.

The need follows from the renderer's design, not from any one terminal: OpenTUI writes DIFFS against a shadow buffer of what it believes is on screen, so a re-render with unchanged content writes nothing at all. Any agent that changes the terminal surface without going through the renderer therefore leaves the shadow buffer stating something false, every surviving cell reads as "already correct", and the display stays wrong indefinitely no matter how many frames follow.

The repaint SHALL NOT leave the alternate screen, because on some terminals (macOS Terminal.app) leaving it dumps the frame into scrollback and so re-causes the damage. It SHALL be idempotent and SHALL touch no application state, so it is safe to invoke at any time and from any mode. It SHALL be one-shot — a single forced frame, never a mode that keeps forcing full frames — so the renderer returns to diffing immediately afterwards and an idle chat continues to cost no frames.

Where the mechanism relies on non-public renderer internals, the implementation SHALL carry a test that asserts the repaint at the BYTE level rather than only in memory, so a dependency upgrade that keeps the internal surface but stops honoring it fails the suite instead of silently degrading the repaint to a no-op.

#### Scenario: A plain re-render writes nothing

- **GIVEN** a rendered chat whose content has not changed
- **WHEN** another frame is rendered without a forced repaint
- **THEN** zero bytes are written to the terminal, which is why damage done outside the renderer is never repaired on its own

#### Scenario: A forced repaint rewrites the whole surface

- **GIVEN** a rendered chat whose content has not changed
- **WHEN** a forced full repaint is requested and the next frame renders
- **THEN** the frame's content is written to the terminal in full, and the renderer remains in the alternate screen

#### Scenario: The forced repaint does not persist

- **WHEN** a forced full repaint has been applied by a frame
- **THEN** the following unchanged frame writes nothing again, so forcing a repaint can never wedge the renderer into permanently writing full frames

### Requirement: An explicit redraw key that survives a modal

The chat SHALL bind a user-remappable `app.redraw` key (default `ctrl+l`, the conventional terminal redraw chord) that requests a forced full repaint, and SHALL register it on a MODE-LESS layer so it stays live in every mode.

Mode-lessness is required, not incidental: screen damage is indifferent to whether a dialog is open, and the wiped surface may itself be a modal — a redraw key that modal capture suspends is unavailable exactly when it is most needed. Leaving the layer unsuspended is safe because the repaint is idempotent and mutates nothing.

The binding SHALL also be reachable as a leader sequence, and THAT sequence SHALL carry the description, so the recovery is discoverable without documentation. The description belongs on the sequence rather than the single-stroke chord because which-key lists only continuations of a pending sequence: metadata on a single stroke can never render, so placing it there would imply documentation that does not exist.

#### Scenario: The redraw key repaints the screen

- **GIVEN** an open chat
- **WHEN** the `app.redraw` key is pressed
- **THEN** the next frame rewrites every cell

#### Scenario: The redraw key still works under a modal

- **GIVEN** a dialog is open, so modal capture has suspended every base-mode layer
- **WHEN** the `app.redraw` key is pressed
- **THEN** the repaint still happens, while base-mode bindings remain suspended

#### Scenario: The redraw is discoverable

- **WHEN** the leader sequence is half-typed and the which-key panel lists the reachable keys
- **THEN** the redraw entry appears with its description, its label derived from the resolved chord

### Requirement: Damage heals on the first input after an idle gap

The chat SHALL force one full repaint on the first input event that arrives after input has been idle for a defined threshold, so that recovery requires no knowledge of a redraw key: the user touches the keyboard and the display returns.

Both keystrokes and pastes SHALL count. A paste arrives as its own event and emits no keystroke, so observing keystrokes alone would leave a user who pastes into the composer looking at a surface that stays wrong — a realistic first action, and incompatible with the promise that any input heals.

The threshold exists to make the heal affordable rather than to detect anything. No terminal reports that it has changed the surface — the damaging action may send no bytes, raise no `SIGWINCH`, and change no focus state — so recovery cannot be detected and MUST be driven by user input. The idle gap exploits the shape of the failure instead: damage is necessarily followed by a pause, because the user has to notice the wrong display, whereas continuous typing has inter-key gaps far below the threshold. The threshold SHALL therefore sit above human typing cadence, so a typing burst forces no repaints.

The cost SHALL be understood as falling on every user, not only on those who hit the damage: each pause-then-type transition in ordinary use spends one full frame. That is imperceptible on a local terminal and is the accepted price of requiring no user knowledge; it is a perceptible hitch on a slow remote link. Raising the threshold trades heal latency for frequency.

The heal SHALL observe the input bus WITHOUT binding: it SHALL NOT inspect what was pressed and SHALL NOT suppress it, so it is not a keybinding and does not belong to the keymap engine. It SHALL still run for keys that a binding also consumes, which holds as long as the engine suppresses matched keys only from the focused editor and never halts the other global input listeners.

The elapsed interval SHALL be measured on a monotonic clock, not a wall clock, so a mid-session time step cannot suppress a heal or force a needless frame. The clock SHALL be injectable so the threshold behavior is testable without sleeping.

#### Scenario: Any key restores a damaged screen

- **GIVEN** the terminal surface was changed behind the renderer's back, leaving the display wrong
- **AND** input has been idle for at least the threshold
- **WHEN** the user presses any key
- **THEN** the next frame rewrites every cell and the display is correct again

#### Scenario: A paste restores a damaged screen

- **GIVEN** the terminal surface was changed behind the renderer's back, leaving the display wrong
- **AND** input has been idle for at least the threshold
- **WHEN** the user pastes text rather than typing
- **THEN** the next frame rewrites every cell, because a paste is an input event like any other

#### Scenario: Typing pays nothing

- **GIVEN** an open chat
- **WHEN** the user types several characters in succession, each within the threshold of the last
- **THEN** no forced repaint occurs for any of them

#### Scenario: A consumed key still heals

- **GIVEN** input has been idle for at least the threshold
- **WHEN** the user presses a key that a keymap binding also handles
- **THEN** the binding runs AND the forced repaint happens

#### Scenario: Idling costs nothing

- **GIVEN** an open chat with no input arriving
- **WHEN** the chat sits idle
- **THEN** no bytes are written, because the heal is driven by input rather than by a timer

### Requirement: Unhealed damage is a stated limitation

The recovery SHALL be documented as incomplete where it is, rather than presented as total. Damage that is never followed by an input event SHALL remain unrepaired, and this SHALL be recorded with its reason at the implementation site.

Specifically: while a turn streams, output repaints only the cells it changes, so after damage the streamed text appears against a stale or blank background until the user touches the keyboard. MOUSE input is not a heal trigger — a user who clicks before typing is not helped, which is the known gap most worth closing next (keyboard and paste input both are triggers). Closing either gap by polling was considered and rejected — a periodic repaint would defeat on-demand rendering, whose whole point is that an idle chat costs no frames — and the alternative, a terminal-side damage notification, does not exist.

#### Scenario: Damage during a stream is not self-healing

- **GIVEN** the terminal surface was changed behind the renderer's back while a turn is streaming
- **WHEN** streamed output continues to render and the user presses nothing
- **THEN** only the changed cells are written, leaving the rest of the surface wrong until an input event or the redraw key forces a repaint
