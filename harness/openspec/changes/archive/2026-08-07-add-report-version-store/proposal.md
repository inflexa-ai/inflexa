## Why

A report version is a checkpoint, but no store records one. The producers exist: `finishDraft` gives the valid document, `mintReportSnapshot` gives the pinned set, and the report thread carries the parent anchor. This change is the store between them, and it is the step that #308 tracks.

## What Changes

- Add the `cortex_report_versions` table to the state DDL: the document and the snapshot as JSONB, beside the analysis id, the thread id, the parent anchor, and a parent version link.
- Add the version store module: record a version, read one version, read the latest version of a thread, and list the versions of a thread.
- A version is immutable and append-only. A new version gets a stable id and a per-thread ordinal, and it can name its parent version.
- A version outlives its thread. The anchor fields are denormalized onto the row, and a purge of the analysis removes the versions.
- Add the version deletes to `purgeAnalysis`, in the analysis-keyed delete list.
- A stored version resolves against its own stored snapshot. The store gives the snapshot back as a value that the existing validation accepts.

## Capabilities

### New Capabilities

- `report-versions`: the version record, its identity, its immutability, its lifecycle, and the store operations.

### Modified Capabilities

- `analysis-purge`: the persisted footprint of an analysis gains the report versions, and the purge removes them.

## Impact

- New code under `harness/src/state/` for the store, and new DDL in `harness/src/state/init.ts`.
- One list entry in `harness/src/state/purge-analysis.ts`, and the tests of the purge cover the new table.
- The work is additive and dormant. No caller reaches the store, and `src/index.ts` exports none of it. The old report path and the `previews/` tree stay untouched.
- No new dependency.
