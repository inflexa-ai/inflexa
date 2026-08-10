## Why

The policy on #221 locks one version for each report session, and the spec binds the caller. But the store still carries the multi-version machinery: the per-thread ordinal, the max-plus-one computation, and the race retry. A future contributor can reach for that capability without the vision. Nothing published carries the table, thus the removal is safe now, and it gets more expensive with each consumer.

## What Changes

- Drop the `version_number` column and the `(thread_id, version_number)` unique index from the DDL, in place and with no migration.
- Add a named UNIQUE constraint on `thread_id`. The old index was the only uniqueness of the table, and the constraint is its replacement and the enforcement.
- The record writes no ordinal. A second record for the same thread violates the constraint, and the store maps that to the typed refusal `thread_already_holds_version`. The max-plus-one computation and the ordinal race retry die.
- `versionNumber` leaves the record and read shapes. **BREAKING** for the store surface: `listVersions` dies, and `getThreadVersion(threadId)` replaces `getLatestVersion`. No production code calls any of them.
- The store tests and the purge fixture adjust to the new shape.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `report-versions`: the ordinal requirement is removed, an enforced one-version-per-thread requirement replaces it, the reads requirement loses the list, and the caller requirement loses its "the store does not enforce this rule" sentence.

## Impact

- `harness/src/state/init.ts` (the DDL), `harness/src/state/report-versions.ts` and its test, and `harness/src/state/purge-analysis.test.ts`.
- The store stays dormant: no caller exists, and `src/index.ts` exports none of it.
- A development database made before this change holds the old table shape, and the init DDL does not alter an existing table. Drop `cortex_report_versions` there one time.
