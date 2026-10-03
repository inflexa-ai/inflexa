## Why

Deleting an analysis reclaims its SQLite row and its workspace folder, and leaves everything the analysis put in Postgres standing forever. Measured on a developer machine, one such deleted analysis still holds a conversation, a run with its sandbox transcripts, an artifact ledger, a live pgvector table, and 3.4 MB of durability-engine rows — in a database where the product no longer believes it exists. The id that could name it died with the SQLite row, so nothing can ever find it again.

The harness now ships the capability that closes this (`purgeAnalysis`), along with the thread-lifecycle verbs that give a removed conversation an honest name. This change is the consumer: it is what makes those capabilities reachable by a user, and until it lands the harness work reclaims nothing.

## What Changes

- The delete flow purges the analysis's Postgres footprint, on **both** file-disposal branches. The "keep the files" question has always governed the filesystem alone — both branches already delete the SQLite row, signed provenance chain included — and archiving is the default, so purging only on permanent deletion would leave the common path orphaning exactly as it does today.
- Before disposal, on the keep-the-files branch, provenance is flushed and exported into the workspace tree so the signed document survives inside the folder the user chose to keep. A failed export does not abort the deletion: the export is a courtesy the app performs while it still can, not a precondition for honouring the user's request.
- The delete flow refuses when the harness runtime is not booted. Without a pool there is no way to purge, and proceeding would silently recreate the orphan this change exists to eliminate.
- **BREAKING (internal seam)** the session-remove flow calls `archiveThread` instead of the removed `deleteThread`. Behaviour is unchanged — it was always a soft archive — so no user-visible copy changes.
- A new palette command restores an archived conversation, reached through a listing widened with `includeArchived`. Without it the archive is a one-way door: `unarchiveThread` exists but no surface can name a thread for it.
- The file-disposal dialog's copy stops promising more than it delivers. It currently offers to preserve "provenance" on a branch that deletes the signed chain from SQLite, and says nothing about the conversation and run history that a purge now removes either way.
- `exportProvenanceToFile` signs before it writes, rather than writing the document and then signing. Today a signing failure leaves an unsigned `provenance.json` on disk beneath a notice claiming provenance is never exported unsigned; the delete flow would make that path routine.

## Capabilities

### New Capabilities

None — every behaviour lands in an existing capability.

### Modified Capabilities

- `analysis-service`: the delete requirement gains the Postgres purge, its ordering constraint, the provenance export, and the booted-runtime precondition.
- `command-palette`: the session-remove command is specified for the first time and bound to `archiveThread`; a restore command is added beside it; the palette's provenance export is required to sign before it writes. (`prov-signing` is deliberately not touched — it is scoped to the keypair and the sign/verify primitives in `signing.ts`, not to the order in which a caller writes their outputs.)

## Impact

- `cli/src/tui/commands.tsx` — `SessionSeams.deleteThread` → `archiveThread`, the `analysis.delete` action and `deleteAnalysisWith` ladder, `DeleteAnalysisFilesDialog` copy, `exportProvenanceToFile`, and a new `session.restore` command.
- `cli/src/tui/commands.test.ts`, `cli/src/tui/session_remove_dialog.render.test.tsx` — seam renames, `Thread` fixtures gain `deletedAt`, coverage for the new ladder and command.
- `cli/package.json` — the `@inflexa-ai/harness` pin moves to the release carrying `purgeAnalysis` and the thread verbs. The code does not compile against the current pin, so this change cannot merge before that version is published.
- No SQLite migration: nothing about the local schema changes.
