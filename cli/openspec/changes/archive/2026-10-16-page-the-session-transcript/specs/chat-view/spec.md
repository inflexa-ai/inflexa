# Spec Delta

## MODIFIED Requirements

### Requirement: Conversation hot state lives in a dedicated store

The chat's hot state SHALL live in a module singleton at `src/tui/hooks/conversation.ts` (mirroring
`src/tui/hooks/status.ts`), not inline in `src/tui/app.tsx`. The store SHALL hold the `messages` list
(a `createStore`), the `streamText`/`streamPartId` streaming signals, and the `errorMsg` signal. It
SHALL expose: a `messageCount()` accessor, the frame reducer (the reducer that applies the frames of
the turn stream of the local server to the store), `loadMessages` sourcing the transcript from the
pg thread through the server (`GET {T}/messages`, the harness replay of the stored messages), a
`resetHotState()` that aborts any in-flight turn and clears messages/stream/error, and the request
lifecycle: `send(...)` owning the turn-scoped `AbortController` and driving one turn on the local
server, plus `abort()`, whose abort sends the abort of the turn to the server. Streaming deltas
accumulate in the signals and flush into the stored part when the turn ends (its stream ends and its
summary is read), not on a bus status event. The coarse activity state SHALL remain in
`src/tui/hooks/status.ts` (`busy` for the duration of a turn), updated by the send lifecycle.

The store SHALL bound the number of mounted messages to a cap of **200** (the most-recent turns):
`loadMessages` SHALL populate the store from the newest window in oldest-first order, and live
appends SHALL drop the oldest past the cap. The cap protects layout cost, which scales with mounted
message count because `viewportCulling` clips painting but not layout. Messages older than the cap
are not reachable in-app; the full history remains in the thread store.

The server gives the transcript in pages of whole turns, newest first. Thus `loadMessages` MUST read
pages at the maximum limit of the server, newest first. It MUST stop when it holds 200 messages, or
when the server gives no older page. A page read that gives an error MUST end the load with the
handling of that error for the first transcript read.

#### Scenario: Streaming deltas accumulate then flush on turn completion

- **WHEN** text deltas arrive during a turn and the turn then completes
- **THEN** `streamText` accumulates them live and the final text is flushed into the stored part as a fresh object when the turn ends, clearing the streaming signals

#### Scenario: Turn failure surfaces in the error banner

- **WHEN** the server reports a failed turn (a provider error), or refuses the turn before it opens (a prepare failure)
- **THEN** `errorMsg` carries an actionable message and `chatStatus` is `error`

#### Scenario: Sidebar reads the message count from the store

- **WHEN** the conversation gains or loses messages
- **THEN** `messageCount()` reflects the new length and the `Sidebar` repaints from it

#### Scenario: Initial load is capped to the most-recent window

- **WHEN** `loadMessages` runs for a thread with more than 200 persisted messages
- **THEN** the store holds only the most-recent 200, in oldest→newest order

#### Scenario: The load reads older pages until the window is full

- **GIVEN** a thread whose newest page holds fewer than 200 messages, and an older page
- **WHEN** `loadMessages` runs
- **THEN** it reads the older page with the cursor of the newest page
- **AND** the store holds the most-recent 200 messages of the two pages, in oldest→newest order

#### Scenario: A thread that fits in one page costs one read

- **GIVEN** a thread whose newest page has no older page
- **WHEN** `loadMessages` runs
- **THEN** it sends one transcript read, and the store holds each message of that page
