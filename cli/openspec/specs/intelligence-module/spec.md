# intelligence-module Specification

## Purpose
The legacy proxy-chat slice at `src/modules/intelligence/`: the SQLite-backed model-streaming `chat()` engine (no remaining TUI caller — the TUI chat drives the harness conversation agent, see `tui-harness-chat`), the `inflexa sessions` command, and the proxy helpers the harness boot consumes (`readApiKey`/`resolveModelId`/`pickDefaultModel`). Pending retirement/relocation by the dev-umbrella demotion change.
## Requirements
### Requirement: AI interaction is owned by the intelligence module

The headless AI-interaction slice SHALL live at `src/modules/intelligence/`. It SHALL provide the model-streaming chat engine as `chat(opts: ChatOptions): Promise<Result<void, DbError>>` from `src/modules/intelligence/chat.ts`, and the `inflexa sessions` list command as `listSessions()` from `src/modules/intelligence/sessions.ts`. No `src/modules/session/` directory SHALL remain after the change. The move SHALL preserve behavior: `chat()` persists the user turn, streams the assistant response from the proxy, emits bus events, and persists the final text exactly as before; `listSessions()` prints saved sessions exactly as before.

#### Scenario: Chat engine resolves at the intelligence path

- **WHEN** a caller imports `chat` from `src/modules/intelligence/chat.ts`
- **THEN** the import resolves and `chat()` is callable
- **AND** no module exists at `src/modules/session/`

#### Scenario: Sessions command resolves at the intelligence path

- **WHEN** the `sessions` CLI command action runs
- **THEN** it loads `listSessions` from `src/modules/intelligence/sessions.ts` and lists saved sessions unchanged

#### Scenario: Behavior is preserved by the move

- **WHEN** a user sends a chat message after the rename
- **THEN** the user turn and streamed assistant turn are persisted and rendered exactly as before the move

### Requirement: The intelligence module is headless

The `src/modules/intelligence/` module SHALL contain no `.tsx` files and SHALL NOT import from `src/tui/` — presentation depends on the module, never the reverse. It MAY import shared infrastructure (`src/lib/`, `src/db/`, `src/types/`) and other modules acyclically (e.g. `src/modules/proxy/`). The session/message/part queries and mutations SHALL remain in `src/db/`, and the persisted shapes (`Session`, `Message`, `Part`) and the `BusEvent` contract SHALL remain in `src/types/` — none of these move into the module.

#### Scenario: No presentation import from the module

- **WHEN** the files under `src/modules/intelligence/` are inspected
- **THEN** none import from `src/tui/` and none is a `.tsx` file

#### Scenario: Shared layers are untouched

- **WHEN** the change is applied
- **THEN** `src/db/primary_query.ts`, `src/db/primary_mutation.ts`, `src/types/session.ts`, and `src/types/events.ts` are unchanged in location and content

### Requirement: Presentation and CLI import the engine from intelligence

The TUI SHALL NOT import the proxy chat engine: `src/tui/` contains no import of `chat` from
`src/modules/intelligence/chat.ts` (the TUI conversation drives the shared harness turn engine
instead — see `tui-harness-chat`). The engine and its SQLite persistence remain in place as a legacy
surface (its boot-consumed helpers `readApiKey`/`resolveModelId` keep their current importers), and
`src/cli/index.ts` SHALL keep lazy-importing `listSessions` from
`src/modules/intelligence/sessions.ts`. The engine's retirement/relocation is the follow-up
demotion change, not this one.

#### Scenario: The TUI does not reach the proxy engine

- **WHEN** `src/tui/` is searched for imports of the intelligence chat engine
- **THEN** no file imports `chat` from `modules/intelligence/chat.ts`

#### Scenario: Sessions command unchanged

- **WHEN** the `sessions` CLI command action runs
- **THEN** it loads `listSessions` from `src/modules/intelligence/sessions.ts` and lists saved sessions unchanged

### Requirement: Assistant part is broadcast before streaming

The chat engine SHALL emit a `part.updated` bus event for the empty assistant part immediately after creating the assistant turn and **before** the streaming loop begins — symmetric with the existing user-part broadcast. This places the streaming part into the conversation store so the view can bind the accumulating `streamText` to a rendered part and show tokens incrementally as they arrive, rather than only after the turn completes. The final `part.updated` emitted after streaming (carrying the full text) SHALL remain unchanged.

#### Scenario: Empty assistant part is broadcast up front

- **WHEN** the engine creates the assistant message and its empty part
- **THEN** it emits `message.created` for the assistant message **and** a `part.updated` for the empty assistant part before reading the first stream delta

#### Scenario: Live tokens render during the turn

- **WHEN** `part.delta` events arrive after the assistant part has been broadcast
- **THEN** the view renders the accumulating text in the streaming message block while the turn is still in progress

#### Scenario: Final text still persisted and broadcast

- **WHEN** the stream completes (or is aborted)
- **THEN** the engine persists the accumulated text and emits the final `part.updated` followed by `session.status` idle, exactly as before

