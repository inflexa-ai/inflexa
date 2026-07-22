# harness-thread-history Specification

## Purpose
Defines the harness `messages` table — the single source of truth for conversation turns — and the `appendTurn` / `loadRecent` / `retractLastTurn` API on top of it. Turns are persisted atomically with a monotonic per-thread `seq`, content is stored as AI SDK model-message envelopes (see the ai-sdk-message-storage spec), and `loadRecent` walks newest-first to a token budget snapping the window to valid turn boundaries (no orphan tool result). Stored AI SDK messages convert to `CortexMessage` parts for the wire.

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

`loadRecent(threadId, tokenBudget)` SHALL return the most recent messages whose cumulative `tokens` fit the budget, walking newest-first. It SHALL NOT window by message count.

#### Scenario: Only recent turns within budget are returned

- **GIVEN** a thread whose total tokens exceed the budget
- **WHEN** `loadRecent` is called
- **THEN** it returns only the most recent turns whose cumulative tokens fit the budget

### Requirement: loadRecent returns a valid AI SDK model-message sequence

The window returned by `loadRecent` SHALL always begin on a genuine user-input turn and SHALL never split an AI SDK tool-call/tool-result continuation. The turn is the atomic unit; a turn is never half-loaded. If the most recent complete turn alone exceeds the budget, it SHALL be returned in full. Messages SHALL be ordered by ascending numeric `seq` — the read MUST order on the `bigint` `seq` column, never on a textual projection of it (a lexicographic sort places `"10"` before `"2"`, reordering a thread past ten messages and splitting tool-call/tool-result pairs across an intervening turn).

#### Scenario: The window is snapped past an orphan tool result

- **GIVEN** a token cut that would start the window on a tool-result continuation
- **WHEN** `loadRecent` snaps the boundary
- **THEN** the returned window starts on a genuine user-input turn and contains no orphan tool result

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
- **THEN** it exposes only conversation-turn operations (`appendTurn`, `loadRecent`, `loadPage`, `retractLastTurn`), not a generic row insert or row delete

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

### Requirement: The tail turn can be retracted

`retractLastTurn(threadId)` SHALL remove the thread's most recent turn in a single transaction: every row from the last genuine-user-start `seq` onward. A thread whose rows contain no genuine-user-start SHALL NOT be touched: the operation deletes nothing and reports a distinct "no user turn" outcome — such rows cannot arise from `appendTurn`-written turns, and refusing beats silently emptying anomalous data. The operation SHALL be serialized against concurrent `appendTurn` calls by the same per-thread lock, so it removes a whole turn — never part of one an append is still writing. Its success value SHALL report the removed message count; retracting an empty thread SHALL be a normal "nothing to retract" outcome, not an error. The error channel SHALL carry database faults only. The store SHALL NOT support removing any turn other than the tail, nor removing individual messages.

#### Scenario: Retract restores the pre-append thread

- **GIVEN** a thread with persisted turns, then one further `appendTurn` of a single user message
- **WHEN** `retractLastTurn` is called
- **THEN** the appended rows are gone and `loadRecent` returns exactly what it returned before that append

#### Scenario: A multi-row tail turn is removed whole

- **GIVEN** a thread whose most recent turn spans multiple rows (user input, assistant steps, tool results)
- **WHEN** `retractLastTurn` is called
- **THEN** every row of that turn is removed and the prior turn becomes the tail

#### Scenario: Retracting an empty thread is a normal outcome

- **GIVEN** a thread with no rows
- **WHEN** `retractLastTurn` is called
- **THEN** it succeeds with the "nothing to retract" outcome and no `DbError` is produced

#### Scenario: A thread without a user-start row is refused

- **GIVEN** a thread whose rows contain no user-role message
- **WHEN** `retractLastTurn` is called
- **THEN** no rows are removed and the "no user turn" outcome is reported

#### Scenario: Retract never removes part of a concurrently appending turn

- **GIVEN** an `appendTurn` of a multi-message turn racing a `retractLastTurn` on the same thread
- **WHEN** both complete
- **THEN** the thread holds either the whole appended turn or none of it — never a partial turn

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
