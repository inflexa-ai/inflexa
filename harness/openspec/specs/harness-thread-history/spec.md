# harness-thread-history Specification

## Purpose
Defines the harness `messages` table — the single source of truth for conversation turns — and the `appendTurn` / `loadRecent` API on top of it. Turns are persisted atomically with a monotonic per-thread `seq`, content is stored as AI SDK model-message envelopes (see the ai-sdk-message-storage spec), and `loadRecent` walks newest-first to a token budget snapping the window to valid turn boundaries (no orphan tool result). Stored AI SDK messages convert to `CortexMessage` parts for the wire.
## Requirements
### Requirement: A turn is appended atomically with monotonic sequence

`appendTurn(threadId, messages)` SHALL write all messages of a turn in one transaction, assigning each a `seq` that is monotonically increasing per thread. Each row SHALL store its model content as an AI SDK model-message envelope and a `tokens` count computed at write time.

#### Scenario: A turn round-trips

- **GIVEN** a turn of AI SDK model messages appended to a thread
- **WHEN** the thread is read back
- **THEN** the messages return oldest-first with strictly increasing `seq`

#### Scenario: Provider metadata survives persistence

- **GIVEN** a message containing provider metadata required for continuation is appended
- **WHEN** it is read back
- **THEN** the provider metadata is byte-identical where AI SDK represents it

### Requirement: loadRecent windows by token budget

`loadRecent(threadId, tokenBudget)` SHALL return the most recent messages whose cumulative `tokens` fit the budget, walking newest-first. It SHALL NOT window by message count. The token budget SHALL apply to conversation turns only: pinned briefing rows are returned in addition to the windowed turns and never count against or consume the budget.

#### Scenario: Only recent turns within budget are returned

- **GIVEN** a thread whose total tokens exceed the budget
- **WHEN** `loadRecent` is called
- **THEN** it returns only the most recent turns whose cumulative tokens fit the budget

#### Scenario: Briefing tokens do not shrink the turn window

- **GIVEN** two threads with identical turns, one with briefing rows and one without
- **WHEN** `loadRecent` is called with the same budget on both
- **THEN** both return the same turn window

### Requirement: loadRecent returns a valid AI SDK model-message sequence

The windowed-turn portion returned by `loadRecent` SHALL always begin on a genuine user-input turn and SHALL never split an AI SDK tool-call/tool-result continuation. A briefing row SHALL NOT count as a turn start even though its inner message has role `user`: turn-boundary detection SHALL consult the envelope kind, and window snapping SHALL never anchor the window on, evict part of, or split the briefing prefix. The turn is the atomic unit; a turn is never half-loaded. If the most recent complete turn alone exceeds the budget, it SHALL be returned in full. Messages SHALL be ordered by ascending numeric `seq` — the read MUST order on the `bigint` `seq` column, never on a textual projection of it (a lexicographic sort places `"10"` before `"2"`, reordering a thread past ten messages and splitting tool-call/tool-result pairs across an intervening turn).

#### Scenario: The window is snapped past an orphan tool result

- **GIVEN** a token cut that would start the window on a tool-result continuation
- **WHEN** `loadRecent` snaps the boundary
- **THEN** the returned window starts on a genuine user-input turn and contains no orphan tool result

#### Scenario: A briefing row is not a turn start

- **GIVEN** a thread whose rows are briefings followed by turns, with a token cut landing at the briefing/turn seam
- **WHEN** `loadRecent` snaps the boundary
- **THEN** the windowed portion starts on a genuine user-input turn — never on a briefing row — and the briefing prefix is returned intact ahead of it

#### Scenario: A thread past ten messages keeps numeric order

- **GIVEN** a thread with more than ten messages whose tool-call and tool-result straddle the `seq` 9→10 boundary
- **WHEN** `loadRecent` returns the window
- **THEN** the messages are in ascending numeric `seq` order and every tool-call is immediately followed by its matching tool-result, with no user message between them

#### Scenario: An oversized turn is returned whole

- **GIVEN** a single turn whose tokens exceed the entire budget
- **WHEN** `loadRecent` is called
- **THEN** that turn is returned in full rather than truncated

### Requirement: loadRecent emits a thread-overflow metric

Every `loadRecent` call SHALL emit an OTel metric recording the thread's total token count, whether eviction occurred, and how many turns were evicted.

#### Scenario: Eviction is recorded

- **GIVEN** a thread whose total tokens exceed the budget
- **WHEN** `loadRecent` runs
- **THEN** the emitted metric reports `eviction: true` with a non-zero evicted-turn count

### Requirement: Thread history is conversation-scoped

The `messages` table and `ThreadHistory` SHALL serve conversation threads only. Workflow and sandbox agent loops SHALL NOT write to it; their message durability is the DBOS step cache and is not migrated by the AI SDK thread-history backfill.

#### Scenario: The interface offers no generic message insert

- **GIVEN** the `ThreadHistory` interface
- **WHEN** a caller inspects it
- **THEN** it exposes only conversation-scoped operations (`appendTurn`, `loadRecent`, `loadPage`, the idempotent briefing append), not a generic row insert

### Requirement: A paginated message read backs the messages endpoint

`ThreadHistory` SHALL provide a thread-scoped, paginated read (`loadPage(threadId, page, perPage)`) of the `messages` table for serving the thread messages endpoint, returning a page of AI SDK model-message envelopes (oldest-first) together with `total`, `page`, `perPage`, and `hasMore`. Pagination SHALL be by whole turns — `page`, `perPage`, and `total` count turns, not rows — so a multi-row turn always reloads intact. This read SHALL be distinct from `loadRecent` (which windows by token budget for the LLM) — it serves UI display, not the agent loop, and SHALL NOT apply token-budget eviction.

#### Scenario: A page of messages is returned with totals

- **GIVEN** a thread with more messages than one page holds
- **WHEN** the paginated read is called with a page and perPage
- **THEN** it returns that page oldest-first plus `total` and `hasMore`

#### Scenario: The display read is not token-windowed

- **GIVEN** a thread whose total tokens exceed the loop budget
- **WHEN** the paginated read is called
- **THEN** it returns messages by page boundaries, not by token budget, and evicts nothing

### Requirement: Stored AI SDK messages convert to CortexMessage

A converter SHALL map stored AI SDK model-message envelopes to `CortexMessage` parts for the wire. Text content SHALL become text parts and tool calls SHALL become tool-call parts. Provider metadata or reasoning blocks the UI does not render SHALL be omitted from the display value without mutating the stored row.

#### Scenario: A tool-using turn converts to CortexMessage

- **GIVEN** a stored assistant AI SDK message containing text and a tool call
- **WHEN** the converter runs
- **THEN** it yields a `CortexMessage` with a text part and a tool-call part

#### Scenario: Provider metadata is dropped from display without mutating storage

- **GIVEN** a stored message containing provider metadata not rendered by the UI
- **WHEN** the converter runs
- **THEN** the metadata is omitted from the `CortexMessage` and the stored row is unchanged

### Requirement: Standing briefings persist at thread start and are pinned above the window

`ThreadHistory` SHALL provide an idempotent briefing append that writes a thread's standing briefings in one transaction with `seq` values preceding every turn; if the thread already has briefing rows, the append SHALL be a no-op (first writer wins under concurrent first turns). `loadRecent` SHALL always return the thread's briefing rows first, in ascending `seq`, exempt from the token budget, followed by the windowed turns.

#### Scenario: Briefings survive window eviction

- **GIVEN** a thread whose turn tokens exceed the budget many times over
- **WHEN** `loadRecent` is called
- **THEN** every briefing row is returned ahead of the windowed turns, and only turns are evicted

#### Scenario: Concurrent first turns append one briefing set

- **GIVEN** two requests racing to prepare a new thread's first turn
- **WHEN** both attempt the briefing append
- **THEN** exactly one set of briefing rows exists, in the first writer's order
