# Tasks

## 1. Contract

- [x] 1.1 Add `author?: string` and `createdAt?: string` to `CortexMessage` in `src/contracts/message.ts`. Write a doc comment on each: the author is the identity that sent a user message, absent on an assistant message and on a live message with no row behind it. The creation time is the ISO 8601 form of the start time of the append transaction, and absent on a live message. Make sure that `tsc -p tsconfig.json` passes.

## 2. Storage

- [x] 2.1 In `src/state/init.ts`, add `author TEXT` to the `messages` `CREATE TABLE` text with a column comment (nullable, no default, no backfill, written on the genuine user-start row only). Add `ALTER TABLE messages ADD COLUMN IF NOT EXISTS author TEXT` to the additive block, beside the `turn_duration_ms` migration. Keep the DDL text free of a semicolon in a comment.
- [x] 2.2 Add `src/state/author-column.test.ts` in the shape of `reported-usage-column.test.ts`. Make sure that a fresh schema has a nullable `text` column with no default. Make sure that `initCortexState` adds the column to a database that lacks it, and that each existing row reads back author-free.

## 3. Thread history

- [x] 3.1 In `src/memory/thread-history.ts`, add `author?: string` to `ConversationTurn` with a doc comment (D2). In `appendTurn`, pass the author through `stripNulCharacters`. Write it on the row at index zero when `isGenuineUserStart(message)` holds for that row, and `NULL` elsewhere. Add the column to the `INSERT` and to the `ON CONFLICT` update.
- [x] 3.2 Add `createdAt?: Date` and `author?: string` to `StoredMessage` with doc comments (D3). In `readTurns`, select `created_at` and `author`. Set `createdAt` on each row. Set `author` by conditional spread, thus an absent author has no key.
- [x] 3.3 In `src/memory/thread-history.test.ts`, add one test for each spec scenario of the append requirement. Also make sure that `loadAll` gives a `Date` on each row, and that each row of one append shares one time. Make sure that `loadRecent` returns the appended model messages unchanged after an authored append.

## 4. Replay

- [x] 4.1 In `src/memory/conversation-display-replay.ts`, read the row that carries the display envelope. Set `createdAt` (`toISOString()`) on each message of the append when the row holds a time. Set `author` on each message of the append whose role is `user`. Use a conditional spread for each of the two values (D4).
- [x] 4.2 In `src/memory/conversation-display-replay.unit.test.ts`, add the tests. A turn with an author replays the author and the time on the user message. The assistant message of that turn carries the time and no author key. A turn without an author replays no author key. A row without a time replays no `createdAt` key. The stored display envelope holds neither value.

## 5. Verify

- [x] 5.1 Run `bun run format:file` on each changed file under `src/`. Run `tsc -p tsconfig.json`.
- [x] 5.2 Run `bun run test:full src/memory src/state src/app` and make sure that each test passes. Then run the full suite one time with `bun run test:full`.
- [x] 5.3 Run `cd harness && bun run build`, then `cd cli && bun run typecheck`. The `cli/node_modules/@inflexa-ai/harness` link to the working copy is already in place, and git ignores the path. Make sure that the `cli` compiles without a `cli` change.
