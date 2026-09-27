# Tasks

Each path is relative to `harness/`.

## 1. The migrations

- [x] 1.1 Add the dependency `kysely`.
- [x] 1.2 Move the DDL of `src/state/init.ts` into `src/state/migrations/20260927120000_baseline.ts`, with the message backfill and the HNSW index behind a savepoint.
- [x] 1.3 Add `cortexMigrations` in `src/state/migrations/index.ts`.
- [x] 1.4 Make `initCortexState` run the Kysely migrator with the tables `cortex_migration` and `cortex_migration_lock` in the current schema, and a lock timeout of 5 s for each migration.
- [x] 1.5 Give the narrow type `BackfillClient` to `backfillAiSdkMessageEnvelopes`.
- [x] 1.6 Give the boot logger to `initCortexState` in `bootHarness`.

## 2. The tests

- [x] 2.1 Add `forgetMigrations` to `src/__tests__/setup/postgres.ts`.
- [x] 2.2 Make each test that simulates an older database call `forgetMigrations` before it runs the init again.
- [x] 2.3 In `src/state/thread-parent-columns.test.ts`, add a test for a start with no pending migration and an open reader, and a test for the lock timeout of a pending migration.
