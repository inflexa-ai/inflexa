# Carry the author and the creation time on a chat message

## Why

A host cannot show who sent a chat message, or when. `CortexMessage` (`src/contracts/message.ts`) holds `id`, `role`, `parts`, `interrupted`, `usage`, and `durationMs`. The `messages` table already stamps `created_at` on each row, but `readTurns` does not select the column, and `StoredMessage` does not carry the time. No column holds the author, and `appendTurn` writes none. The issue is inflexa-ai/inflexa#565, and it blocks inflexa-ai/lumen#169.

## What Changes

- `ConversationTurn` gets an optional `author`. `appendTurn` writes it on the first row of the append when that row is a genuine user start, in the same transaction as the messages. No other row carries an author. The write strips NUL from the author, the same as it does from the envelope.
- The `messages` table gets a nullable `author TEXT` column, with no default and no backfill. A row written before the column existed reads back with no author.
- `readTurns` selects `created_at` and `author`. `StoredMessage` carries `createdAt` on each row that the read returns, and `author` on the row that holds one.
- `CortexMessage` gets an optional `author` and an optional `createdAt` (an ISO 8601 string). The transcript replay folds the creation time of the row that opens an append onto each message of that append. It folds the author of that row onto the user message of that append.
- An assistant message carries no author. The role names the sender. The host that consumes the contract shows an author on a user message only, and a date-time on each message.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-thread-history`: the append stores the author of the turn, and the transcript read carries the author and the creation time on the wire.

## Impact

Harness source:

- `src/contracts/message.ts`: the two optional fields on `CortexMessage`.
- `src/state/init.ts`: the column in the `CREATE TABLE` text and the additive `ALTER TABLE` migration.
- `src/memory/thread-history.ts`: the `author` member of `ConversationTurn`, the write in `appendTurn`, the `createdAt` and `author` members of `StoredMessage`, and the read in `readTurns`.
- `src/memory/conversation-display-replay.ts`: the fold of the two values onto the replayed messages.

Consumers. Each new field is optional, and the change removes nothing. A host typed for the previous contract ignores the fields. The `cli/` caller of `appendTurn` (`cli/src/modules/harness/turn.ts`) compiles without a change, because `author` is optional. The CLI does not pass an author in this change.

Release. The harness release is a `workflow_dispatch` of `Release: harness` after the merge. The user starts it. The change does not bump `package.json`.

Out of scope:

- The author of an assistant message. The host shows none, and the harness has no per-turn model name at the store boundary.
- An author in the CLI append path.
- A backfill of the author for a row that predates the column.
