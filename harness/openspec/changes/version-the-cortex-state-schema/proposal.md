## Why

The harness runs all of its schema DDL at each start. The DDL holds more than 60 `ALTER TABLE` statements. An `ALTER TABLE` takes an ACCESS EXCLUSIVE lock, also when it changes nothing, and it waits for each open transaction that read the table. While it waits, each later query on that table waits behind it. On 2026-09-27, a read-only session stayed idle in a transaction on the production database for 11 minutes. For that time, a new Cortex replica could not start, and each query of the live replica on `cortex_analysis_threads` had to wait behind the queued `ALTER TABLE`.

## What Changes

- The schema of the Cortex state tables becomes a list of versioned migrations in `src/state/migrations/`. The Kysely migrator (`kysely/migration`) applies them.
- The first migration, `20260927120000_baseline`, holds the current DDL. Each statement stays idempotent. Thus the baseline also applies to a database that the DDL at each start made.
- The migrator records each applied migration in `cortex_migration`, and it uses `cortex_migration_lock`. It keeps the two tables in the current schema. A run with no pending migration runs no DDL.
- Each migration sets `lock_timeout` to 5 s. A migration that meets a long transaction fails, and the host runs it again.
- `initCortexState` runs the migrator. `bootHarness` still calls it. Thus the CLI and the tests get the migrations with no other change. A host can also run `initCortexState` before it starts its process, for example in a Kubernetes init container.
- `backfillAiSdkMessageEnvelopes` takes a narrow client type. Thus the baseline can run it in the transaction of the migration.
- The harness does not use the advisory lock `cortex_state_init`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-storage-backend`: versioned migrations replace the idempotent DDL at each start.
- `run-state-persistence`: the init applies the pending migrations and does nothing more to the run state.

## Impact

- `src/state/init.ts`, `src/state/migrations/`, `src/memory/message-backfill.ts`, and `src/runtime/boot.ts`.
- `package.json`: the new dependency `kysely`.
- The first start after the upgrade applies the baseline one time, in one transaction.
