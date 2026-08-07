## 1. The schema

- [x] 1.1 Edit the `cortex_report_versions` DDL in `src/state/init.ts`: drop the `version_number` column and the `idx_cortex_report_versions_thread_version` index. Add a named UNIQUE constraint on `thread_id`. Keep every DDL comment free of a semicolon, because the init splits the DDL on it.

## 2. The store

- [x] 2.1 Rework `record` in `src/state/report-versions.ts`: no ordinal in the insert, and no max-plus-one read. Map the violation of the named constraint to the typed refusal `thread_already_holds_version`. Delete `isOrdinalRace` and the retry.
- [x] 2.2 Remove `versionNumber` from `RecordedVersionRef`, `RecordedVersion`, `VersionRow`, and the column projection. The ref carries the version id alone.
- [x] 2.3 Rework the reads: `getThreadVersion(threadId)` replaces `getLatestVersion`, and `listVersions` dies. `getVersion(versionId)` stays as it is.
- [x] 2.4 Rework the store tests: the ordinal tests become the one-version tests. Cover the second-record refusal with one row left, the two-threads case, the thread read, and the absence for a thread with no version.
- [x] 2.5 Adjust the purge fixture in `src/state/purge-analysis.test.ts` to the new insert shape.

## 3. The gates

- [x] 3.1 Run `bun run format:file` on each changed source file.
- [x] 3.2 Run `tsc -p tsconfig.json`, and repair each finding.
- [x] 3.3 Run the lint on the changed files, and repair each finding.
- [x] 3.4 Run the tests of the changed areas only: `src/state/report-versions.test.ts` and `src/state/purge-analysis.test.ts`, against the dev Postgres. Do not run the full suite.

## 4. The record on #221

- [ ] 4.1 After the merge, post the comment on #221 that records the enforcement and the surface change. The posted policy comment says the machinery "stays in place and unused", and that sentence goes stale with this change.
