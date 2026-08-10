## 1. The table and the purge

- [x] 1.1 Add `cortex_report_versions` to the DDL in `src/state/init.ts`. The columns:
  - `version_id` as the primary key
  - `analysis_id`, with a cascade foreign key to `cortex_analysis_state`
  - `thread_id`, `parent_thread_id`, and `parent_seq` BIGINT
  - `version_number` INTEGER
  - `parent_version_id`, a self reference with `ON DELETE SET NULL`
  - `document` JSONB, `snapshot` JSONB, and `created_at` TIMESTAMPTZ with a NOW default

  Add a unique index on `(thread_id, version_number)`, and an index on `analysis_id`. No semicolon can appear in any comment of the DDL text.
- [x] 1.2 Add the delete of `cortex_report_versions` to `ANALYSIS_KEYED_DELETES` in `src/state/purge-analysis.ts`.
- [x] 1.3 Extend the tests of the purge: an analysis with recorded versions purges to zero rows, and the report-version scenario of the spec passes.

## 2. The store module

- [x] 2.1 Make the store in `src/state/report-versions.ts`: an injected `Pool`, the `tryQuery`, `tryMutation`, and `DbError` helpers of `lib/db-result.ts`, and the value types. Make a zod schema for the stored snapshot shape, tied to the `ReportSnapshot` type at compile time, thus the two cannot drift.
- [x] 2.2 Make the record operation. The steps:
  - parse the document with `ReportDocumentSchema` before the insert
  - refuse a malformed document as typed data, with no row
  - compute the ordinal inside the insert, from the maximum of the thread
  - on a unique-index refusal, try the insert again one time, and give the typed database error when the second insert also loses
  - refuse a parent version from a different analysis, and let the foreign key refuse an unknown parent id
  - store the snapshot and the anchor as given, and never mint
- [x] 2.3 Make the reads: one version by its id, the latest of a thread, and the list of a thread in ordinal order. Parse the stored document and the snapshot on read. Give a typed parse error for a bad row. Give a normal absence for an unknown id.
- [x] 2.4 Write the tests of the store against the test database. The cases:
  - the triple round-trips
  - the ordinals count up inside one thread, and independently across two threads
  - a pre-inserted conflicting ordinal drives the retry
  - the parent link nulls when the parent row goes
  - a thread delete leaves the versions
  - a malformed document refuses with no row
  - the stored snapshot ignores later ledger writes
  - a corrupted row reads as a typed error
  - a parent from a different analysis refuses with no row
  - the latest read of an empty thread gives an absence, and the list gives an empty list

## 3. The gates

- [x] 3.1 Run `bun run format:file` on each changed source file.
- [x] 3.2 Run `tsc -p tsconfig.json`, and repair each finding.
- [x] 3.3 Run the lint on the changed files, and repair each finding.
- [x] 3.4 Run the tests of the changed areas only: the store tests and the purge tests. These tests use the Postgres testcontainer. Do not run the full suite.
