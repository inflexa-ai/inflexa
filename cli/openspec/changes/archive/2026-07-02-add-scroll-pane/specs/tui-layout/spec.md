## MODIFIED Requirements

### Requirement: Direction-B chat shell composition

`app.tsx` SHALL compose the chat screen as: a persistent `StatusBar` across the full width at the top; below it a main row split into a chat column (the message stream, the error banner, the transient notice, and the `ChatBar`, stacked) and, beside it, an optional full-height `Sidebar`. The `Sidebar` SHALL span the full height of that row — alongside BOTH the stream and the input — so when it is shown the chat column (stream and input together) shrinks horizontally to make room (the opencode layout). When the sidebar is hidden the chat column spans the full width. The message stream SHALL render inside a `ScrollPane` (see the `scroll-pane` capability) with `stickyScroll`/`stickyStart="bottom"`; the chat SHALL declare no scroll bindings of its own. The existing overlay dialog host, keyboard gating, streaming-delta flush, and abort behavior SHALL be preserved; dialog-close focus restore follows the "Chat focus is always on a widget" requirement.

#### Scenario: Sidebar is full height and shrinks the chat column

- **WHEN** the sidebar is shown
- **THEN** it spans the full height beside both the stream and the input, and the chat column (stream + input) narrows to make room

#### Scenario: Hidden sidebar gives full width

- **WHEN** the sidebar is toggled off
- **THEN** the chat column spans the full width and only the status bar, stream, and input remain

#### Scenario: Stream scrolls via ScrollPane

- **WHEN** the chat column renders the message stream
- **THEN** the stream is a `ScrollPane` (sticky-bottom), and no scroll chord is declared in `app.tsx` or `chat.tsx`

## ADDED Requirements

### Requirement: Chat focus is always on a widget

The chat's INSERT/NORMAL modality SHALL be modeled purely by focus — there SHALL be no state in which no widget is focused. In INSERT mode the `ChatBar` textarea is focused; `esc` SHALL move focus to the stream's `ScrollPane` (NORMAL mode — the pane's scroll keys become live via its focus-target gating). In NORMAL mode, `i` and enter SHALL refocus the textarea (a chat-side layer gated by `target:` the scroll pane); `esc` while the pane is focused SHALL be a no-op (it MUST NOT blur into a nothing-focused state). The `ChatBar` footer's mode word continues to derive from the textarea's own focused/blurred events and needs no extra wiring.

Because focus is always on some widget, the dialog host's focus save/restore SHALL be uniform: capture the focused renderable when the first dialog opens, restore it (verifying it is still in the tree) when the last closes. The `fallbackFocus` prop and its null-restore branch SHALL NOT exist — there is no nothing-focused case to fall back from.

#### Scenario: Esc enters NORMAL by focusing the pane

- **WHEN** the textarea is focused and the user presses `esc`
- **THEN** the scroll pane receives focus, the ChatBar footer shows `NORMAL`, and vim scroll keys drive the stream

#### Scenario: i and enter return to INSERT

- **WHEN** the scroll pane is focused and the user presses `i` (or enter)
- **THEN** the textarea regains focus, the footer shows `INSERT`, and typed letters insert text again

#### Scenario: Esc in NORMAL is a no-op

- **WHEN** the scroll pane is focused and the user presses `esc`
- **THEN** focus stays on the pane; no widget is blurred into a nothing-focused state

#### Scenario: Dialog restore returns focus to the NORMAL-mode pane

- **WHEN** a dialog opens while the scroll pane is focused and is later closed
- **THEN** the dialog host restores focus to the scroll pane (no fallback branch involved), and scroll keys are live again

#### Scenario: No fallbackFocus machinery

- **WHEN** `dialog_host.tsx` is read
- **THEN** it exposes no `fallbackFocus` prop and contains no null-saved-focus fallback path
