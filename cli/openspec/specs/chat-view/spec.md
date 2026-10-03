# chat-view Specification

## Purpose
The TUI conversation view: the hot-state store (`src/tui/hooks/conversation.ts`) holding the transcript, streaming signals, and turn lifecycle over the shared harness turn engine, and the `Chat` component rendering it. The transcript's source of truth is the pg conversation thread (see `tui-harness-chat`).

## Requirements

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

### Requirement: Provider auth failures surface the re-authentication remedy

When a failed turn's cause chain carries a harness `ProviderError` with `type: "auth"` (at any depth — the AI SDK wraps it), the local server SHALL give the turn a failure message that names the resolved connection provider and its remedy, and the error banner SHALL render that message: in `cliproxy` mode, a restart of the local server or the forced re-login command; in `direct` mode, the `INFLEXA_MODEL_API_KEY` variable and a restart of the server, since a re-login cannot fix the user's own key. The message SHALL name the provider unconditionally — the resolved connection always carries a slug (`direct` requires one, `cliproxy` defaults to `anthropic`), so there is no slug-less rendering. When the slug is one no login flow owns, the message SHALL omit only the forced re-login command. Any non-auth failure SHALL fall back to the generic cause rendering. Detection SHALL be structural (the server walks the cause chain for the `type` discriminant), never by matching provider message text.

#### Scenario: An auth turn failure names the provider and the remedy

- **GIVEN** a cliproxy connection recorded with provider `anthropic`
- **WHEN** a turn fails and its cause chain carries `{ type: "auth", retryable: false }`
- **THEN** `errorMsg` names the provider login as expired and gives the server restart / forced re-login remedies, and `chatStatus` is `error`

#### Scenario: A direct connection's auth failure names the key, not a re-login

- **GIVEN** a `direct` connection
- **WHEN** a turn fails with a `type: "auth"` cause
- **THEN** the banner names `INFLEXA_MODEL_API_KEY` and no re-login command

#### Scenario: An unrecognized provider slug drops only the re-login hint

- **WHEN** a turn fails with a `type: "auth"` cause and the recorded slug maps to no login flow
- **THEN** the banner still names that provider as expired, without a forced re-login command

### Requirement: Chat follows in-place session swaps reactively

The `Chat` component SHALL load and reset its state by reacting to `workspace.sessionId` (a reactive `createStore` field) via a `createEffect` keyed on that id: on first run it loads the session's messages, and on a later change it aborts any in-flight request, resets the hot state, and loads the new session — replacing the imperative `onOpenSession` reset callback, which SHALL be removed from `WorkspaceInit` and `createWorkspace` in `src/tui/contexts/workspace.ts`. The `openSession` capability on the `Workspace` store SHALL remain the sole writer of the chat scope.

#### Scenario: Swap reloads without restart

- **WHEN** `workspace.openSession` swaps to a different session
- **THEN** `Chat` reloads that session's messages in the same process and prior streaming/error state is cleared

#### Scenario: In-flight request aborted on swap

- **WHEN** a swap occurs while a response is streaming
- **THEN** the in-flight turn is aborted before the new session loads

#### Scenario: No imperative reset seam remains

- **WHEN** the workspace scope is swapped
- **THEN** the reset is driven by `Chat`'s reactive effect and `WorkspaceInit` no longer carries an `onOpenSession` callback

### Requirement: app.tsx composes the chat rather than owning it

`src/tui/app.tsx` SHALL NOT declare the `messages` store, the streaming/error signals, the reducer,
or `loadMessages`. It SHALL render `<Chat />` in the chat column, source
`<Sidebar messageCount={…} />` from the conversation store, reduce `handleSubmit` to read/clear the
textarea (refusing while the boot store is not `ready` or a turn is busy), handle `/quit`, and
delegate sending to `conversation.send`, pointing the abort keybinding at `conversation.abort`.

#### Scenario: Submitting delegates to the store

- **WHEN** the user submits a non-empty message with the runtime ready and no turn in flight
- **THEN** `app.tsx` clears the textarea and calls `conversation.send`, which owns the turn-scoped `AbortController` and starts the turn on the local server

#### Scenario: Abort keybinding cancels via the store

- **WHEN** the abort keybinding fires while a turn is busy
- **THEN** `conversation.abort()` aborts the in-flight turn, and the abort reaches the server

### Requirement: Display-card parts map live and on reload

The conversation store MUST keep each harness part as the harness gives it, in the live path and in the reload path. In the live path, the local server translates each event of the top-level agent with `toChatFrame` of the harness, and the store applies each frame with `applyChatFrame` of the harness. In the reload path, the server replays the stored messages with `storedMessagesToChat`, and `loadMessages` mounts them with no change.

The live path MUST check each data part at receipt with `checkChatPart` of the harness. It MUST drop a part that the check refuses, and log the type of the part and the error. Each frame that the store keeps is a fresh object that the client parsed from the stream, thus the store keeps no object that the agent loop can change.

The message renderer MUST read each card through its harness part type. `readPlanCard`, `readPresentation`, and `readFileReference` map a part to its view, thus a reloaded transcript renders the same cards as the live turn. A text-shaped presentation (`markdown`, `code`, `table`) MUST render as an inline presentation. An `echart` or `svg` presentation and a file reference MUST render as an openable card that holds only the semantic references. An unknown `data-*` part MUST keep the one-line tagged mention.

#### Scenario: Live and reloaded turns render alike

- **GIVEN** a turn where the agent emitted a markdown presentation and a file-reference gallery
- **WHEN** the user closes the session and the thread reloads from pg
- **THEN** the reloaded transcript shows the same inline markdown block and the same openable gallery card as the live turn

#### Scenario: Unknown parts still surface

- **WHEN** the harness emits a `data-*` part that the CLI has no renderer for
- **THEN** the transcript shows the one-line tagged mention of the part, and it does not drop the part

#### Scenario: A part that its schema refuses is dropped

- **WHEN** the harness emits a known `data-*` part that its schema refuses
- **THEN** the transcript does not show the part, and the log holds a warning with the type of the part

### Requirement: A harness synthetic message renders as an event, not as a user turn

The transcript SHALL recognise a harness synthetic message and render it as an event entry —
visually distinct from both the user's own messages and the assistant's replies — rather than as a
turn by either party.

Recognition SHALL use the harness's exported predicate over the stored message, never a heuristic
over its text. A synthetic message carries the `user` role for the wire format, so a mapper that
reads only the role would attribute a system-authored run outcome to the user, which is a lie
about who said it and would also mislead the reader about what they can retract.

An event entry SHALL NOT carry the user or assistant turn markers, SHALL NOT be counted as a turn
in the transcript's turn-scoped affordances, and SHALL NOT be offered as retractable or editable
content.

#### Scenario: A run outcome does not appear to be the user speaking

- **WHEN** the transcript loads a thread containing a synthetic run-outcome message
- **THEN** it renders as an event entry with neither the user nor the assistant marker

#### Scenario: Recognition is structural

- **WHEN** a synthetic message's text resembles ordinary user prose
- **THEN** it is still recognised as synthetic, because recognition reads the harness marker rather than the content

#### Scenario: Event entries are not retractable turns

- **WHEN** the user reaches for the retract affordance after a synthetic entry
- **THEN** the affordance targets the user's own most recent message, and the synthetic entry is not presented as editable

#### Scenario: A genuine user message is unaffected

- **WHEN** the transcript loads an ordinary user message
- **THEN** it renders with the user marker exactly as before

### Requirement: The compaction part maps live and on reload

The conversation store MUST keep the harness `data-compaction` part as the harness gives it, in the live path and in the reload path.

Live, `applyChatFrame` of the harness appends the first emission of an id to the assistant message of the turn. A later emission with the same id MUST replace the status and the figures of that part in place. It MUST NOT append a second part.

After a reload, the harness gives each stored marker as a `system` message with one `data-compaction` part at its final status. The store MUST mount that message with no change, and it renders as an event entry. The event entry is not a turn, and it is not retractable.

The message renderer MUST read the fields of the harness part directly. A part with a status that the harness schema does not know never reaches the store: the live path drops it at receipt, and the replay reads only parts that the harness checked when it stored them.

#### Scenario: Live emissions update one part

- **GIVEN** a turn whose root loop compacts
- **WHEN** the harness emits the part with `running`, and then with `done` under the same id
- **THEN** the assistant message of the turn holds one compaction part, with the status `done` and the figures of the second emission

#### Scenario: A reload gives the divider as an event entry

- **GIVEN** a stored turn whose compaction ended with a summary marker
- **WHEN** the thread reloads from pg
- **THEN** the transcript holds a `system` message with one compaction part at the status `done`, between the two assistant messages of the turn

#### Scenario: A malformed status is a terminal failure

- **WHEN** the harness emits a `data-compaction` part whose status the harness schema does not know
- **THEN** the live path drops the part at receipt, and no compaction line waits for a terminal status

#### Scenario: The part is not a tagged mention

- **WHEN** the harness emits a `data-compaction` part, live or in a reloaded thread
- **THEN** the transcript shows no tagged mention of the part
