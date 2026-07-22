## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Thread history is conversation-scoped

The `messages` table and `ThreadHistory` SHALL serve conversation threads only. Workflow and sandbox agent loops SHALL NOT write to it; their message durability is the DBOS step cache and is not migrated by the AI SDK thread-history backfill.

#### Scenario: The interface offers no generic message insert

- **GIVEN** the `ThreadHistory` interface
- **WHEN** a caller inspects it
- **THEN** it exposes only conversation-turn operations (`appendTurn`, `loadRecent`, `loadPage`, `retractLastTurn`), not a generic row insert or row delete
