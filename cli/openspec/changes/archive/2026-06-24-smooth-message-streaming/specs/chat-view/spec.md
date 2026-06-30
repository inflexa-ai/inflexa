## MODIFIED Requirements

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
