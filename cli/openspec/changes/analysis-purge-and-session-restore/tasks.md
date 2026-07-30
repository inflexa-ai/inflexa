## 1. Thread verbs

- [x] 1.1 Rename `SessionSeams.deleteThread` to `archiveThread`, point the real seam at `createThreadStore(pool).archiveThread`, and update the doc comment to describe an archive rather than a soft delete.
- [x] 1.2 Update `deleteSessionFlow`/`confirmSessionDelete` prose that explains the tombstone, dropping the note that the archive-vs-purge split is separate future work.
- [x] 1.3 Rename the seam in `commands.test.ts` and `session_remove_dialog.render.test.tsx`, and add `deletedAt: null` to every `Thread` fixture so they compile against the new shape.

## 2. Restore session

- [x] 2.1 Add `listArchivedThreads` and `unarchiveThread` to `SessionSeams`, realized over `listThreads({analysisId, includeArchived: true})` filtered to rows with a non-null `deletedAt`, and `createThreadStore(pool).unarchiveThread`.
- [x] 2.2 Add a `session.restore` palette command ("Restore session", category Session, enabled on an open analysis + ready runtime) that picks from the archived listing and unarchives the choice, notifying the outcome.
- [x] 2.3 Show an empty state when nothing is archived, matching how the other pickers phrase theirs.
- [x] 2.4 Tests: restores the chosen conversation, lists only archived rows, empty state when none, and refuses without a ready runtime.

## 3. Provenance export ordering

- [x] 3.1 In `exportProvenanceToFile`, build the sidecar before writing anything and write neither on a signing failure.
- [x] 3.2 Test that a signing failure leaves no provenance file on disk.

## 4. The delete ladder

- [x] 4.1 Refuse `analysis.delete` when the harness runtime is not booted, with a notice naming the reason.
- [x] 4.2 On the archive branch only, flush provenance and export it before `disposeWorkspace`; report a failure but do not abort.
- [x] 4.3 Add the purge stage between the disposal and the SQLite row delete, calling `purgeAnalysis` over the booted pool and a `WorkflowPurger` built from it.
- [x] 4.4 Abort on purge failure with the row intact and a notice saying nothing was lost.
- [x] 4.5 Rewrite `DeleteAnalysisFilesDialog`'s option descriptions so neither overstates what it keeps: the mode governs the workspace tree, and the conversation and run history go either way.
- [x] 4.6 Tests: purge runs on both modes, purge precedes the row delete, a purge failure keeps the row, the export runs before disposal on archive and not at all on delete, and a missing runtime refuses.

## 5. Verification

- [x] 5.1 `bun run typecheck` clean.
- [ ] 5.2 `bun run test` green (`--isolate`; never plain `bun test`).
- [x] 5.3 `bun run lint` clean on every changed file.
- [x] 5.4 `bun run format:file` on every changed file under `src/`.
