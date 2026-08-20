## 1. Schema

- [x] 1.1 `src/state/init.ts`: `user_id` on `cortex_asks` (nullable, as `grant_key` is) and on `cortex_ask_grants`, with the primary key `(analysis_id, user_id, grant_key)`
- [x] 1.2 `src/state/init.ts`: a guarded migration that adds `user_id` with an empty default, drops the default, and replaces the primary key

## 2. The seam and its queries

- [x] 2.1 `src/tools/approval/gateway.ts`: a required `userId` on `AskContext`, threaded into the row and into the grant lookup
- [x] 2.2 `src/tools/approval/queries.ts`: `userId` on `AskRow`, written by both inserts
- [x] 2.3 `src/tools/approval/queries.ts`: `selectGrant(querier, analysisId, userId, grantKey)`
- [x] 2.4 `src/tools/approval/queries.ts`: the answer transaction returns `user_id` and keys the grant insert on it
- [x] 2.5 `src/tools/approval/queries.ts`: `userId` on `PendingAsk`, selected by `selectPending`

## 3. The bind site in this repository

- [x] 3.1 `cli/src/tui/hooks/conversation.ts`: the CLI passes its one local identity

## 4. Tests

- [x] 4.1 A grant of one user does not short-circuit the ask of a different user
- [x] 4.2 A grant of the same user short-circuits the ask, and the ledger records it `resolved`
- [x] 4.3 An `always` answer writes the grant with the user of the ask row
- [x] 4.4 `pending()` reports the user of each unresolved ask
- [x] 4.5 `src/state/purge-analysis.test.ts`: the seeded grant row carries a user

## 5. Verify

- [x] 5.1 `bun run format:file` on each changed file in `src/`
- [x] 5.2 `tsc -p tsconfig.json` clean in the harness
- [x] 5.3 `bun run lint` clean
- [x] 5.4 `bun test` green

The CLI typecheck needs a build of the working-copy harness, and the `cli` job of
the pull request links one. Thus that job covers task 3.1.
