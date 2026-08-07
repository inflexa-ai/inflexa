## 1. The anchor read

- [ ] 1.1 Add `latestSeq(threadId)` to `src/memory/thread-history.ts`. It gives the latest `messages.seq` of the thread, or an absence for a thread with no messages. It takes no lock.
- [ ] 1.2 Write the tests of the read: a thread with turns gives the latest seq, and a thread with no messages gives the absence.

## 2. The spawn operation

- [ ] 2.1 Make `src/app/spawn-report-session.ts` with the refusal type. The reason set is closed: `parent_not_found`, `parent_not_a_conversation`, and `empty_parent_transcript`. Each variant carries the identifiers, in the pattern of `ThreadInputError`.
- [ ] 2.2 Make the spawn: read the parent with `getThread`, read the anchor with `latestSeq`, count the report children with `listThreads`, compose the title, mint the id, and call `createThread`. The store refusals pass through unchanged.
- [ ] 2.3 Make the children listing `listReportSessions(analysisId)` as a thin wrapper over `listThreads` narrowed to the type `report`.
- [ ] 2.4 Write the tests of the spawn. Cover the child shape, the anchor value, and the anchor stability after a later append. Cover each refusal, with no row written, and the report-parent refusal among them. Cover the title of the first report, the title of the second report, and the null-title fallback. Cover the listing that gives only the report sessions, and the listing of the children under one parent.

## 3. The gates

- [ ] 3.1 Run `bun run format:file` on each changed source file.
- [ ] 3.2 Run `tsc -p tsconfig.json`, and repair each finding.
- [ ] 3.3 Run the lint on the changed files, and repair each finding.
- [ ] 3.4 Run the tests of the changed areas only: the new test files, plus `src/memory/thread-history.test.ts` and `src/memory/thread-store.test.ts`. Do not run the full suite.
