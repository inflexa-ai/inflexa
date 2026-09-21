# Design — carry the author and the creation time

## Context

See proposal.md for the motivation. These facts shape the approach:

- `messages.created_at` is `TIMESTAMPTZ NOT NULL DEFAULT NOW()`. The column is in the `CREATE TABLE` text of `src/state/init.ts` from the first commit of this repository (`a323d8a4`) onward, and no `ALTER TABLE` adds it. Thus each row holds a time, and the read selects the column with no guard.
- `NOW()` is the transaction start time. `appendTurn` writes each row of a turn in one transaction. Thus each row of one append holds the same `created_at`.
- The display projection rides the first row of an append, with no condition on the role of that row. The replay (`src/memory/conversation-display-replay.ts`) walks the rows, and the row that holds the envelope produces each `CortexMessage` of that append. The rollup and the duration fold onto the assistant reply of the append from the row that ended the turn.
- The envelope write strips NUL from each string (`serializeEnvelope`, `src/memory/thread-history.ts`). A `json` column tolerates an escaped NUL, but a `text` parameter with a 0x00 byte fails the statement, and the transaction rolls back.
- `cli/src/modules/harness/turn.test.ts` builds a `StoredMessage` literal without a time, and the `cli` typecheck covers the test files against the linked working-copy harness.
- The wire contracts write a time as an ISO 8601 string: `renderedAt` (`src/contracts/chat-parts.ts`) and `profiledAt` (`src/contracts/data-profile.ts`).
- `Identity.user` (`src/auth/types.ts`) is a string. The harness reads it, and a host such as the managed chat route holds it at the append site.
- inflexa-ai/lumen#169 shows an author on a user message only, and a date-time on each message.
- A turn boundary is a genuine user start: a `user` row that is not a synthetic message. `isGenuineUserStart` and `GENUINE_USER_START_SQL` share the predicate.

## Goals / Non-Goals

**Goals:**

- A host reads the author and the creation time from the read that it already does. No second query.
- An absent value never reads as a real one. The author is nullable with no default, and the replay sets no field for an absent value.
- The author is stored in one place. It rides the message row, thus a retract removes it with the row.

**Non-Goals:**

- An author on an assistant message (D1).
- A change to the display envelope. The author and the time are facts about the row, not about what the turn showed (D4).
- A change to `loadRecent`. The model read does not carry the two values, because the provider does not see them.
- The CLI append path, and the harness release.

## Decisions

### D1 — An assistant message carries no author

The issue names two options: the model name, or nothing. The host that consumes the contract shows no author on an assistant message. The harness also has no stable model name at the store boundary: the agent config holds a model id as a construction-time value, and one turn can reach a different model. Thus an assistant message carries no author. The `role` field already names the sender.

### D2 — The author rides the first row of the append, when that row is a genuine user start

`ConversationTurn` gets `author?: string`. `appendTurn` writes it on the first row of the append (`i === 0`) when `isGenuineUserStart(message)` holds for that row, and `NULL` on each other row. The write passes the author through `stripNulCharacters` first, thus a NUL in the value cannot fail the append.

The first row is the row that carries the display envelope. Thus the write and the replay use one row under one rule. An author is never stored on a row that the replay does not inspect.

Alternatives:

- Each row of the turn. An assistant row and a tool row are not the words of the person. A reader that folds by role would then have to decide which rows to trust.
- Each genuine user-start row, at any index. A conversation turn holds one such row, at index zero. Thus the two rules agree on each append that exists today. But this rule lets a future append store an author on a row that the replay never reads.
- The first row with no condition. `conversationRecordTurn` writes a synthetic record as its first row, and a host can spread an author onto it. The record is not the message of a person, thus the condition drops the author there.

### D3 — Two types for one time

`StoredMessage.createdAt` is an optional `Date`. The read sets it on each row, because the column is `NOT NULL` and the driver hands a `TIMESTAMPTZ` back as a `Date`. The member is optional because a `StoredMessage` literal exists outside the read: the fakes of the `cli` tests, and the unit tests of the replay. A required member would break the `cli` typecheck against the linked harness, with no `cli` change in this issue.

The cost of the optional member: `readTurns` sets it on each row, thus each consumer handles an absence that the read never produces. The replay carries one branch for that absence. The cost is accepted, because the alternative is a `cli` change outside the issue.

`CortexMessage.createdAt` is an optional ISO 8601 string. The contract is JSON on the wire, and a `Date` does not survive that crossing typed. The field is optional because a live surface builds a `CortexMessage` with no row behind it. The replay makes the crossing with `toISOString()` in one place, and it sets the field only when the row holds a time.

`CortexMessage.author` is an optional string, and `StoredMessage.author` is an optional string. The replay and the read use a conditional spread, thus an absent value has no key, the same as `usage` and `durationMs`.

### D4 — The fold reads the row that opens the append

The row that holds the display envelope produces each `CortexMessage` of its append. The replay sets `createdAt` from that row on each of those messages, because each row of the append shares the transaction time (see Context). It sets `author` from that row on each message of the append whose role is `user`.

Alternatives:

- Store the two values in the display envelope. Then one fact has two durable copies, and the two can disagree. The rollup obeys the same rule and stays out of the envelope.
- Fold the time per row, from the model row that ended the turn. The rows share one time, thus the extra rule buys nothing.

### D5 — The column is additive

`author TEXT`, nullable, no default. The `CREATE TABLE` text carries the column for a fresh database, and the additive block carries `ALTER TABLE messages ADD COLUMN IF NOT EXISTS author TEXT` for an older one. No backfill: the value was never recorded, thus absent is the honest value. A DDL test pins the column shape and the additive migration, the same as `src/state/reported-usage-column.test.ts`.

### D6 — A NUL in the author is removed, not rejected

The write passes the author through `stripNulCharacters`, the same as the envelope write does for each string. The alternative is a refusal: a new error variant on `appendTurn` for a NUL in the author. A refusal adds an error path that no caller handles today, and it fails the whole turn over one byte in a label. An identity from a host carries no NUL, thus the removal changes no real value. A removal makes two distinct strings equal only when the two differ by a NUL alone. No identity of a host has that shape.

## Risks / Trade-offs

- [The time is the append time, not the send time] → `NOW()` gives the start time of the append transaction, which opens after the turn ran. A user message thus carries the time at which the turn was stored, and a long turn shifts it by the length of the turn. The value is what the store knows. A host that needs the send time supplies it at the append site in a later change.
- [Two appends can share a time, or a clock step can order them backward] → The store gives no order between the times of two appends. The spec says so. `seq` orders the rows. No test asserts an order between appends.
- [The unarchived change `persist-versioned-conversation-display` also carries a delta on `harness-thread-history`] → This change adds two requirements and modifies none. Thus the archive of either change does not overwrite the text of the other.
- [A host passes an author on a record append] → The genuine user-start condition drops it, and no row of the record carries an author. The behavior is stated in the spec, thus a host does not depend on it.
- [A database whose `messages` table predates `created_at`] → No such database is known. The column is in the first DDL of this repository, and the issue reports it on the managed database. An `ADD COLUMN ... NOT NULL DEFAULT NOW()` would stamp each old row with the migration time, which is a false value. Thus the change adds no migration for the column, and a read on such a database fails loudly with an undefined column.
