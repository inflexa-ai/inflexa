# chat-view Specification

## Purpose
The TUI conversation view: the hot-state store (`src/tui/hooks/conversation.ts`) holding the transcript, streaming signals, and turn lifecycle over the shared harness turn engine, and the `Chat` component rendering it. The transcript's source of truth is the pg conversation thread (see `tui-harness-chat`).
## Requirements
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

When a failed turn's cause chain carries a harness `ProviderError` with `type: "auth"` (at any depth — the AI SDK wraps it), the error banner SHALL render a dedicated message naming the resolved connection provider and its remedy: in `cliproxy` mode, restarting the chat (the launch gate re-authenticates) or the forced re-login command; in `direct` mode, the `INFLEXA_MODEL_API_KEY` variable, since a re-login cannot fix the user's own key. The banner SHALL name the provider unconditionally — the resolved connection always carries a slug (`direct` requires one, `cliproxy` defaults to `anthropic`), so there is no slug-less rendering. When the slug is one no login flow owns, the banner SHALL omit only the forced re-login command. Any non-auth failure SHALL fall back to the generic cause rendering. Detection SHALL be structural (walking the cause chain for the `type` discriminant), never by matching provider message text.

#### Scenario: An auth turn failure names the provider and the remedy

- **GIVEN** a cliproxy connection recorded with provider `anthropic`
- **WHEN** a turn fails and its cause chain carries `{ type: "auth", retryable: false }`
- **THEN** `errorMsg` names the provider login as expired and gives the restart / forced re-login remedies, and `chatStatus` is `error`

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
textarea (refusing while the harness boot is not `ready` or a turn is busy), handle `/quit`, and
delegate sending to `conversation.send`, pointing the abort keybinding at `conversation.abort`.

#### Scenario: Submitting delegates to the store

- **WHEN** the user submits a non-empty message with the runtime ready and no turn in flight
- **THEN** `app.tsx` clears the textarea and calls `conversation.send`, which owns the turn-scoped `AbortController` and drives the shared turn engine

#### Scenario: Abort keybinding cancels via the store

- **WHEN** the abort keybinding fires while a turn is busy
- **THEN** `conversation.abort()` aborts the in-flight turn

### Requirement: Display-card parts map live and on reload

The conversation store SHALL map `data-presentation`, `data-file-reference`,
and `data-report-preview` / `data-report-preview-failed` events to first-class
parts in both paths — the live emit reducer (`applyEmitEvent`) and the thread
reconstruction path (`cortexToUiMessage`) — through shared readers, so a
reloaded transcript renders the same cards as the live turn (the harness
card-builders guarantee byte-identical card data across both paths).
Text-shaped presentations (`markdown`, `code`, `table`) map to an inline
presentation part; pixel-shaped content (`echart`, `svg` presentations, file
references, report previews) maps to openable card parts carrying only the
semantic reference fields, extracted at receipt (copy-on-receive — no retained
harness objects). Unknown `data-*` parts SHALL keep the existing one-line
tagged-mention fallback.

#### Scenario: Live and reloaded turns render alike

- **GIVEN** a turn where the agent emitted a markdown presentation and a file-reference gallery
- **WHEN** the session is closed and the thread reloads from pg
- **THEN** the reconstructed transcript shows the same inline markdown block and the same openable gallery card as the live turn did

#### Scenario: A failed report preview is visible

- **WHEN** the harness emits `data-report-preview-failed`
- **THEN** the transcript shows a degraded preview card naming the reason, not a `[part:…]` tag

#### Scenario: Unknown parts still surface

- **WHEN** the harness emits a `data-*` part the CLI has no renderer for
- **THEN** the transcript shows the one-line tagged mention (observed, not swallowed)

