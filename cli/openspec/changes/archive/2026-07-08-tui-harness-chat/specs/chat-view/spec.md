# chat-view — Delta

## MODIFIED Requirements

### Requirement: Conversation hot state lives in a dedicated store

The chat's hot state SHALL live in a module singleton at `src/tui/hooks/conversation.ts` (mirroring
`src/tui/hooks/status.ts`), not inline in `src/tui/app.tsx`. The store SHALL hold the `messages` list
(a `createStore`), the `streamText`/`streamPartId` streaming signals, and the `errorMsg` signal. It
SHALL expose: a `messageCount()` accessor, the harness emit adapter (the reducer that applies
turn events to the store — cloning/extracting at receipt, never retaining received objects),
`loadMessages` sourcing the transcript from the pg thread history (recognized tool-calls
reconstructed as card/tool parts), a `resetHotState()` that aborts any in-flight turn and clears
messages/stream/error, and the request lifecycle: `send(...)` owning the turn-scoped
`AbortController` and driving the shared harness turn engine, plus `abort()`. Streaming deltas
accumulate in the signals and flush into the stored part when the turn completes (the engine
returns), not on a bus status event. The coarse activity state SHALL remain in
`src/tui/hooks/status.ts` (`busy` for the duration of a turn), updated by the send lifecycle.

The store SHALL bound the number of mounted messages to a cap of **200** (the most-recent turns):
`loadMessages` SHALL populate the store from the newest window in oldest-first order, and live
appends SHALL drop the oldest past the cap. The cap protects layout cost, which scales with mounted
message count because `viewportCulling` clips painting but not layout. Messages older than the cap
are not reachable in-app; the full history remains in the thread store.

#### Scenario: Streaming deltas accumulate then flush on turn completion

- **WHEN** text deltas arrive during a turn and the turn then completes
- **THEN** `streamText` accumulates them live and the final text is flushed into the stored part as a fresh object when the turn ends, clearing the streaming signals

#### Scenario: Turn failure surfaces in the error banner

- **WHEN** the turn engine reports a failed turn (provider error, prepare failure)
- **THEN** `errorMsg` carries an actionable message and `chatStatus` is `error`

#### Scenario: Initial load is capped to the most-recent window

- **WHEN** `loadMessages` runs for a thread with more than 200 persisted messages
- **THEN** the store holds only the most-recent 200, in oldest→newest order

### Requirement: The Chat component renders the live conversation

A `Chat` Solid component SHALL exist at `src/tui/components/chat.tsx` and render the message
stream — the sticky scrollbox with the empty-state placeholder and one `MessageBlock` per message —
together with the error banner. The transcript state arrives through the conversation store (the
emit adapter writes it directly; no bus subscription is required for the harness path). The
component SHALL live in `tui/` (not `tui/layout/`) and SHALL NOT be placed in `src/modules/`.

#### Scenario: Live stream renders

- **WHEN** the assistant streams a response
- **THEN** `Chat` renders the accumulating text in the streaming `MessageBlock` and shows the stored text once the turn completes

#### Scenario: Error banner shows turn errors

- **WHEN** a turn fails
- **THEN** the error banner renders the message and `chatStatus` is `error`

### Requirement: app.tsx composes the chat rather than owning it

`src/tui/app.tsx` SHALL NOT declare the `messages` store, the streaming/error signals, the reducer,
or `loadMessages`. It SHALL render `<Chat />` in the chat column, source
`<Sidebar messageCount={…} />` from the conversation store, reduce `handleSubmit` to read/clear the
textarea (refusing while the harness boot is not `ready` or a turn is busy), handle `/quit`, and
delegate sending to `conversation.send`, pointing the abort keybinding at `conversation.abort`.

#### Scenario: Submitting delegates to the store

- **WHEN** the user submits a non-empty message with the runtime ready and no turn in flight
- **THEN** `app.tsx` clears the textarea and calls `conversation.send`, which owns the turn-scoped `AbortController` and drives the shared turn engine

#### Scenario: Abort keybinding cancels via the store

- **WHEN** the abort keybinding fires while a turn is busy
- **THEN** `conversation.abort()` aborts the in-flight turn
