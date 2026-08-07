## Context

The store shipped with a per-thread ordinal: `version_number` with a unique index on `(thread_id, version_number)` (`src/state/init.ts:154`, `163-164`), a max-plus-one insert, and a one-retry race path (`src/state/report-versions.ts:246-248`). The policy on #221 makes that generality dead: every row holds the ordinal 1. The caller requirement in the spec binds the session loop, but prose binds only a reader who reads it. The store must refuse what the vision forbids.

Nothing published carries the table, and no production code calls the store. Thus the surface and the schema can change in place.

## Goals / Non-Goals

**Goals:**

- One version for each thread, enforced by the database.
- A typed refusal for a second record on one thread.
- The removal of the ordinal machinery: the column, the index, the computation, the retry, and the `versionNumber` fields.
- A read surface that matches the shape: one version by its id, and the one version of a thread.

**Non-Goals:**

- A change to the immutability rule, the document validation, the parent link, or the purge behavior.
- A migration path. Nothing shipped, thus an in-place DDL edit is correct.
- The caller of the store (#225 and #310 bind later).

## Decisions

### D1. The constraint is the enforcement, and the record maps its violation.

The table gets a named UNIQUE constraint on `thread_id`. The record reads nothing before the insert. The store already lets a constraint answer for the parent link, because an early read buys a round trip and a race window (`src/memory/thread-store.ts:334-341` states the pattern). `tryMutation` classifies the violation with the constraint name, and the record maps that name to the typed refusal `thread_already_holds_version`. Every other constraint violation stays a plain `DbError`.

### D2. The DDL changes in place, and a stale development database drops the table one time.

The init DDL is `CREATE TABLE IF NOT EXISTS`, thus it does not alter an existing table. A development database made before this change holds the old shape, and the new insert omits `version_number`, which the old column refuses as NOT NULL. The remedy is one manual drop of `cortex_report_versions`. This is permitted exactly because nothing shipped, and it is the reason the removal happens now.

### D3. The read surface names the shape.

`getVersion(versionId)` stays. `getThreadVersion(threadId)` replaces `getLatestVersion`, because "latest" implies a set. `listVersions` dies, because a list that always holds zero or one element teaches a false shape. The reuse link is untouched: `parentVersionId` crosses sessions, and its same-analysis rule stays.

### D4. `RecordedVersionRef` carries the id alone.

The ref carried the id and the ordinal. The ordinal dies, thus the ref is `{ versionId }`. The corrupt-row read rule, the absence-is-normal rule, and the immutable-row rule all stay as they are.

## Risks / Trade-offs

- [A stale development database refuses every insert] → D2 names the one-time drop. The error surfaces as a plain `DbError`, and the remedy is in the proposal and the pull request text.
- [The #318 lineage work binds to the old read surface] → #318 has not started, and the lineage derives from a version by its id. A later comment on #221 records the surface change.
- [A future ask for many versions in one thread] → the policy on #221 rules it out. If the vision ever turns, the change is a new spec change, made with the context in front of it.

## Migration Plan

The work merges alone, and the store stays dormant. A revert is one commit.

## Open Questions

- None.
