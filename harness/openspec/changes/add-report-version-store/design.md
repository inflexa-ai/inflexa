## Context

The producers and the anchor exist on `main`. `finishDraft` (`src/report-model/draft-finish.ts`) gives a valid `ReportDocument`. `mintReportSnapshot` (`src/report-model/mint-snapshot.ts`) gives the pinned artifact set of one analysis. The report thread carries `thread_type`, `parent_thread_id`, and `parent_seq` (`src/state/init.ts`, `src/memory/thread-store.ts`). Nothing records the triple.

Two house contracts bind a new store. `purgeAnalysis` is the one place that knows the Postgres footprint of an analysis, and a new analysis-keyed table joins its delete list. The DDL string of `init.ts` is additive, and no semicolon can appear anywhere in it, comments included.

## Goals / Non-Goals

**Goals:**

- One table that records a version: the document, the snapshot, and the anchor.
- A store module with four operations: record, read one, read the latest of a thread, and list a thread.
- Immutability, a stable id, a per-thread ordinal, and a parent version link.
- The lifecycle: a version outlives its thread, and it dies with its analysis.
- The purge coverage, with the tests against a real database.

**Non-Goals:**

- The renderer (#307). The two changes stay disjoint on disk and in the code.
- The spawn of a report session (#309), and the agent (#225).
- The lineage bundle (#318). That work computes a new thing from what this store records.
- A write into the workspace tree. The store is rows only, and the `previews/` tree of the old path stays untouched.
- The value tier of resolution, and any file read.

## Decisions

### D1. A version is three JSONB values on one row, and not a file.

The document and the snapshot are small: the snapshot pins identity only, and a document is a block tree. `cortex_plans` and the dossier of a target assessment set the precedent for a structured, harness-made JSONB payload. A file under `reports/` would sit outside the purge, because the purge never touches disk. The JSONB key-reorder concern binds only the verbatim prompt bytes of `messages`, and a version parses on read.

### D2. A version outlives its thread.

A thread is a scaffold, and a version is a deliverable. A delete of a report thread must not destroy a shipped report. Thus the table carries no cascade from `cortex_analysis_threads`, and the anchor (`thread_id`, `parent_thread_id`, `parent_seq`) is denormalized onto the row. The row dies in `purgeAnalysis`, through the analysis-keyed delete list, with the foreign key to `cortex_analysis_state` as the backstop.

### D3. The snapshot is per version.

A new version must show the later state of the analysis, and an old version must never drift. Thus each recorded version carries the snapshot that its authoring session held, and the store never re-mints. The caller mints at the start of a version, and the record operation stores the value as given.

### D4. The key is a stable id plus a per-thread ordinal.

The id (`version_id`) is the stable reference for code. The ordinal (`version_number`, unique for each thread, first value 1) is how a person names a version. The ordinal computes inside the insert from the current maximum of the thread, and a unique index on `(thread_id, version_number)` makes a race lose cleanly.

The parent link (`parent_version_id`) records reuse. The parent must belong to the same analysis, and the record refuses one outside it, because the lineage bundle of #318 joins through this link. The foreign key refuses an unknown parent id. When a cascade or an out-of-band delete removes the parent row, the link nulls — the same rule as `cortex_plans`.

### D5. The store returns the snapshot as the validation accepts it.

`validateReferenceStructure` and `finishDraft` take a `ReportSnapshot` value. A JSONB read gives a plain object, and `snapshotEntry` guards the lookup with `Object.hasOwn`, thus a prototype-shaped path stays an ordinary key. The store parses the stored document and snapshot with the existing schemas on read. A row that fails the parse reads as a typed error, and it does not crash.

### D6. The record operation validates before the insert.

The record takes the document, the snapshot, and the anchor. The anchor stores as given, and the caller owns its truth. It parses the document against `ReportDocumentSchema` before the insert, thus a malformed value never lands. It does not run the reference validation again, because the finish gate already ran it, and the store must not import the gate. A refused record returns typed data on the error channel of the store.

### D7. The purge deletes versions in the analysis-keyed list.

The delete is `DELETE FROM cortex_report_versions WHERE analysis_id = $1`, and it joins `ANALYSIS_KEYED_DELETES`. The order inside the list does not matter for this table, because the key is the analysis id and no other delete references it. The explicit statement stays ahead of the cascade, per the house rule that the completeness of a purge never rests on a constraint.

## Risks / Trade-offs

- [A large report grows the row] → the snapshot grows with the artifact count, and the document with the block count. Both stay far under the JSONB comfort zone. Measure only if a real analysis shows a cost.
- [The ordinal races when two records land at one moment] → the unique index refuses the loser. The store retries the insert one time with a fresh ordinal.
- [A stored document predates a later contract change] → the read parses with the current schema and reports a typed parse error. A migration story belongs to the change that alters the contract.
- [Two subsystems could write the table] → only the store module touches it, and the module lives beside the other state modules with an injected `Pool`.

## Migration Plan

The work is additive and dormant. The DDL is `CREATE TABLE IF NOT EXISTS` under the existing advisory lock. No caller reaches the store, and `src/index.ts` exports none of it. A revert is one commit.

## Open Questions

- None. The exact column names and the retry shape of the ordinal are implementation details for the tasks phase.
