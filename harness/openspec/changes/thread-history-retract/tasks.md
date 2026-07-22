## 1. Store implementation

- [x] 1.1 Add `RetractOutcome` (`{ kind: "retracted"; messages: number } | { kind: "empty-thread" } | { kind: "no-user-turn" }`) and `retractLastTurn(threadId)` to the `ThreadHistory` interface in `src/memory/thread-history.ts`, with doc comments stating the tail-only contract, the single-writer-per-thread assumption, and why mid-history deletion is excluded (loadRecent window-head stability)
- [x] 1.2 Implement `retractLastTurn` in `createThreadHistory`: `withTransaction` + the same `pg_advisory_xact_lock(hashtext(threadId))` as `appendTurn`, delete `seq >=` the last user-role row's seq, refuse with `no-user-turn` (nothing deleted) when no user-role row exists, map the deleted row count to the outcome
- [x] 1.3 Confirm the new method and outcome type are reachable on the surface the CLI consumes (barrel or deep subpath import of `ThreadHistory`), and run `bun run format:file src/memory/thread-history.ts`

## 2. Tests (`src/memory/thread-history.test.ts`, schema-scoped Postgres testcontainer)

- [x] 2.1 Retract-after-append round-trip: append turns, `appendTurn([userMessage])`, `retractLastTurn` → `loadRecent` returns exactly its pre-append output; outcome reports `{ kind: "retracted", messages: 1 }`
- [x] 2.2 Multi-row tail turn (user + assistant + tool rows) is removed whole and the prior turn becomes the tail (`loadPage` shows it)
- [x] 2.3 Empty thread → `{ kind: "empty-thread" }`, no `DbError`
- [x] 2.4 Degenerate thread with no user-role rows → refused: nothing deleted, `no-user-turn` outcome
- [x] 2.5 Concurrency: race `appendTurn` (multi-message turn) against `retractLastTurn` on one thread; assert the thread ends with either the whole appended turn or none of it — never a partial turn

## 3. Package verification

- [x] 3.1 `tsc -p tsconfig.json` and full `bun test` pass
- [x] 3.2 Verify at the package boundary via the harness verify flow (build dist, link into the scratch consumer, exercise `retractLastTurn` against real Postgres) so the companion CLI change can consume via `bun run harness:local`
