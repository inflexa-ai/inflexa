## MODIFIED Requirements

### Requirement: Deleting an analysis retires its workspace

Deleting the analysis row SHALL NOT be the whole of deleting an analysis. The slug keys the workspace directory and `uniqueSlugForAnchor` hands a freed slug to the next analysis of the same name under the same anchor, so a tree left at `.inflexa/analyses/<slug>/` would be inherited by that successor — its `runs/`, `previews/`, `reports/`, and signed provenance exports appearing under an analysis that never produced them. The system SHALL therefore move the tree out of `analyses/` as part of the deletion, and SHALL reclaim the analysis's Postgres footprint in the same operation.

The system SHALL provide `disposeWorkspace(analysis, mode)` in `src/modules/analysis/output.ts` returning `Result<WorkspaceDisposal, WorkspaceError>`, where `mode` is `"archive"` or `"delete"`, and `WorkspaceDisposal` is `{ kind: "archived"; path }`, `{ kind: "deleted"; path }`, or `{ kind: "absent" }`. `"archive"` SHALL move the tree to `archivedOutputSubdir(slug)` (`.inflexa/analyses_archived/<slug>`), suffixing `-2`, `-3`, … when that destination is taken, so archiving a reused slug never clobbers an earlier archive. `"delete"` SHALL remove the tree. A tree that does not exist — never created, already removed, or living inside an anchor folder that can no longer be located — SHALL be `absent`, not an error.

The delete flow SHALL ask the user which mode to use, defaulting to keeping the files, and SHALL run its stages in this order: export provenance (archive mode only), dispose the workspace, purge Postgres, delete the SQLite row. Deleting the row SHALL be last, because that row carries the only copy of the analysis id the system holds and the purge needs it: a row deleted first strands the entire Postgres footprint beyond the reach of any retry, and does so while reporting success. Disposal SHALL precede the purge because the filesystem operation is the one that realistically fails, and attempting it first means such a failure leaves every store untouched. A failed disposal SHALL abort the deletion and say so. Deletion SHALL be gated on the same workspace-quiescence predicate as rename.

The delete flow SHALL purge on BOTH disposal modes. The mode governs the workspace tree alone — every mode already deletes the SQLite row and the signed provenance chain it carries — and keeping the files is the default, so purging only on permanent deletion would leave the ordinary path orphaning its Postgres state exactly as before.

A failed purge SHALL abort the deletion with the SQLite row intact, SHALL report that nothing was lost, and SHALL name where an already-archived workspace now sits. That report is the last moment the archive path is known: the disposal has already run, so a retry finds no tree at the live location and truthfully reports the analysis had no files on disk, leaving a user who missed this message no way to learn the artifacts were moved or where to. The alternative — deleting the row anyway — would convert a retryable failure into a permanent orphan that no later operation could find. Because the purge is idempotent and a disposal of an already-moved tree reports `absent`, re-running the deletion after such a failure SHALL be a supported recovery.

The delete flow SHALL refuse when the harness runtime is not booted, and SHALL say why. Without a runtime there is no pool, so no purge is possible, and proceeding would silently recreate the orphaned footprint this ordering exists to prevent.

#### Scenario: Archiving keeps the artifacts and frees the slug

- **GIVEN** an analysis with slug `trial` whose workspace contains `runs/run-1/result.csv`
- **WHEN** it is deleted with the files kept
- **THEN** `.inflexa/analyses/trial/` no longer exists
- **AND** `.inflexa/analyses_archived/trial/runs/run-1/result.csv` does

#### Scenario: A recreated analysis of the same name gets a clean tree

- **GIVEN** analysis "Trial" was deleted (files kept or deleted) in a folder
- **WHEN** a new analysis "Trial" is created in that folder
- **THEN** its slug is `trial`, it resolves to the same workspace root, and that root contains none of the previous analysis's artifacts

#### Scenario: Archiving the same slug twice does not clobber

- **GIVEN** `.inflexa/analyses_archived/trial/` already exists
- **WHEN** another analysis with slug `trial` is deleted with the files kept
- **THEN** its tree is archived at `.inflexa/analyses_archived/trial-2/` and the first archive is untouched

#### Scenario: Permanent deletion removes the tree

- **WHEN** an analysis is deleted with the files deleted
- **THEN** neither `.inflexa/analyses/<slug>/` nor an archive of it exists

#### Scenario: A failed disposal aborts the deletion

- **WHEN** the workspace tree cannot be moved or removed
- **THEN** the analysis row is NOT deleted, no purge is attempted, and the user is told nothing was lost

#### Scenario: A never-created workspace deletes cleanly

- **WHEN** an analysis that was never opened is deleted
- **THEN** the disposal reports `absent` and the row is deleted

#### Scenario: Both disposal modes reclaim Postgres

- **GIVEN** an analysis with conversations and a completed run
- **WHEN** it is deleted, with the files kept or deleted
- **THEN** `purgeAnalysis` is invoked for its id in either case, before the SQLite row is removed

#### Scenario: A failed purge leaves the analysis deletable again

- **GIVEN** a deletion whose purge fails after the workspace was archived
- **WHEN** the failure is reported
- **THEN** the SQLite row is still present, the user is told nothing was lost and where the archived files now sit, and repeating the deletion succeeds — the disposal reporting `absent` and the purge running again

#### Scenario: A failed purge after a permanent deletion names no path

- **GIVEN** a deletion whose purge fails after the workspace was deleted rather than archived
- **WHEN** the failure is reported
- **THEN** the user is told nothing was lost and no kept-files location is named, because nothing was kept

#### Scenario: Deletion refuses without a booted runtime

- **WHEN** the delete command runs while the harness runtime is not booted
- **THEN** the deletion does not proceed, nothing is disposed or deleted, and the user is told the harness must be running

## ADDED Requirements

### Requirement: A kept workspace carries its signed provenance

The delete flow SHALL flush pending provenance and export the analysis's signed provenance document into its workspace BEFORE disposing that workspace, whenever the user chose to keep the files. The flush is required because the export serializes the persisted provenance column rather than the recorder's in-memory state, and deleting an analysis directly after working in it is precisely when the most recent appends have not yet been written — without it the archive would preserve a document missing the session's tail.

The export SHALL run before the disposal, never after: it writes into the analysis's live output directory, and after a disposal that directory no longer exists, so exporting afterwards would recreate `.inflexa/analyses/<slug>/` holding a single file — resurrecting the directory the disposal exists to clear.

A failed flush or export SHALL NOT abort the deletion. The user asked for the analysis to be deleted, and the export is what the system does for them on the way out, not a condition of honouring that request. The failure SHALL still be reported, so the user knows what the archive does and does not contain.

#### Scenario: The archived workspace contains the provenance

- **GIVEN** an analysis with recorded provenance
- **WHEN** it is deleted with the files kept
- **THEN** its archived tree contains the exported provenance document and its signature sidecar

#### Scenario: The export captures work done since the last flush

- **GIVEN** provenance appended during this session and not yet flushed
- **WHEN** the analysis is deleted with the files kept
- **THEN** the exported document includes those appends

#### Scenario: A failed export still deletes

- **GIVEN** provenance that cannot be built, signed, or written
- **WHEN** the analysis is deleted with the files kept
- **THEN** the deletion proceeds to completion and the export failure is reported to the user

#### Scenario: Permanent deletion exports nothing

- **WHEN** an analysis is deleted with the files deleted
- **THEN** no provenance export is attempted, because the tree that would hold it is being removed
