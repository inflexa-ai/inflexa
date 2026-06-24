# chat-view Specification

## Purpose
TBD - created by archiving change extract-chat-component. Update Purpose after archive.
## Requirements
### Requirement: Conversation hot state lives in a dedicated store

The chat's hot state SHALL live in a module singleton at `src/tui/hooks/conversation.ts` (mirroring `src/tui/hooks/status.ts`), not inline in `src/tui/app.tsx`. The store SHALL hold the `messages` list (a `createStore`), the `streamText` and `streamPartId` streaming signals, and the `errorMsg` signal. It SHALL expose: a `messageCount()` accessor, an `applyBusEvent(event, sessionId)` reducer that filters by the given session id and applies the streaming/message mutations, `loadMessages(sessionId)`, a `resetHotState()` that aborts any in-flight request and clears messages/stream/error, and a request lifecycle (`send(...)` owning the `AbortController` and the `chat()` call, plus `abort()`). The coarse activity state SHALL remain in `src/tui/hooks/status.ts`; the reducer SHALL keep updating it via `setChatStatus`.

The store SHALL bound the number of mounted messages to a cap of **200** (the most-recent turns): `loadMessages` SHALL populate the store from the capped recent-messages query (newest 200, oldest-first), and the `message.created` reducer SHALL drop the oldest message after appending whenever the store would exceed the cap. The cap protects layout cost, which scales with mounted message count because `viewportCulling` clips painting but not layout. Messages older than the cap are not reachable in-app; the full history remains on disk.

#### Scenario: Streaming deltas accumulate then flush on completion

- **WHEN** `part.delta` events arrive for the active session followed by `session.status` idle
- **THEN** `streamText`/`streamPartId` accumulate the deltas and, on idle, the final text is flushed into the matching part in the `messages` store and the streaming signals are cleared

#### Scenario: Events for other sessions are ignored

- **WHEN** `applyBusEvent` receives an event whose session id is not the active one
- **THEN** the store is not mutated

#### Scenario: Sidebar reads the message count from the store

- **WHEN** the conversation gains or loses messages
- **THEN** `messageCount()` reflects the new length and the `Sidebar` repaints from it

#### Scenario: Initial load is capped to the most-recent window

- **WHEN** `loadMessages` runs for a session with more than 200 persisted messages
- **THEN** the store holds only the most-recent 200, in oldest→newest order

#### Scenario: Live inserts re-enforce the cap

- **WHEN** a `message.created` event for the active session would push the store past 200 messages
- **THEN** the oldest message is dropped so the store length stays at 200

### Requirement: The Chat component renders the live conversation

A `Chat` Solid component SHALL exist at `src/tui/components/chat.tsx` and render the message stream — the sticky scrollbox with the empty-state placeholder and one `MessageBlock` per message — together with the error banner. It SHALL subscribe to the bus in `onMount` and unsubscribe in `onCleanup`, dispatching each event to `applyBusEvent` filtered by the current `workspace.sessionId`. The component SHALL live in `tui/` (not `tui/layout/`, which holds the app-shell frame) and SHALL NOT be placed in `src/modules/` (a view imports `tui/theme.ts` and opentui, which modules may not).

#### Scenario: Live stream renders

- **WHEN** the assistant streams a response
- **THEN** `Chat` renders the accumulating text in the streaming `MessageBlock` and shows the stored text once the part completes

#### Scenario: Bus subscription is cleaned up

- **WHEN** the `Chat` component unmounts
- **THEN** its bus handler is removed (no leaked subscription)

#### Scenario: Error banner shows session errors

- **WHEN** a `session.error` event arrives for the active session
- **THEN** the error banner renders the message and `chatStatus` becomes `error`

### Requirement: Chat follows in-place session swaps reactively

The `Chat` component SHALL load and reset its state by reacting to `workspace.sessionId` (a reactive `createStore` field) via a `createEffect` keyed on that id: on first run it loads the session's messages, and on a later change it aborts any in-flight request, resets the hot state, and loads the new session — replacing the imperative `onOpenSession` reset callback, which SHALL be removed from `WorkspaceInit` and `createWorkspace` in `src/tui/contexts/workspace.ts`. The `openSession` capability on the `Workspace` store SHALL remain the sole writer of the chat scope.

#### Scenario: Swap reloads without restart

- **WHEN** `workspace.openSession` swaps to a different session
- **THEN** `Chat` reloads that session's messages in the same process and prior streaming/error state is cleared

#### Scenario: In-flight request aborted on swap

- **WHEN** a swap occurs while a response is streaming
- **THEN** the in-flight `chat()` request is aborted before the new session loads

#### Scenario: No imperative reset seam remains

- **WHEN** the workspace scope is swapped
- **THEN** the reset is driven by `Chat`'s reactive effect and `WorkspaceInit` no longer carries an `onOpenSession` callback

### Requirement: app.tsx composes the chat rather than owning it

After this change `src/tui/app.tsx` SHALL NOT declare the `messages` store, the streaming/error signals, the bus reducer, the bus subscription, or `loadMessages`. It SHALL render `<Chat />` in the chat column, source `<Sidebar messageCount={…} />` from the conversation store, reduce `handleSubmit` to read/clear the textarea, handle `/quit`, and delegate sending to `conversation.send`, and point the abort keybinding at `conversation.abort`.

#### Scenario: Submitting delegates to the store

- **WHEN** the user submits a non-empty message
- **THEN** `app.tsx` clears the textarea and calls `conversation.send`, which owns the `AbortController` and invokes the `chat()` engine

#### Scenario: Abort keybinding cancels via the store

- **WHEN** the abort keybinding fires while busy
- **THEN** `conversation.abort()` cancels the in-flight request

