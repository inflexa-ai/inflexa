# input-staging Specification

## Purpose
Materialize an analysis's selected inputs into its workspace tree (`{workspaceRoot}/data/inputs/local/…`) as the `StagedInput[]` manifest the embedded harness consumes verbatim — hardlink-first placement, noise-dir-aware directory walks, deterministic file identity, staging-time mirroring so the tree always reflects the current inputs, and a read-only drift-signature enumeration sharing the same walk (for profile-drift checks). Lives in `src/modules/staging/`; the workspace-root rule is owned by `path-resolution`, and its harness-seam realization by `harness-runtime`.
## Requirements

### Requirement: Stage an analysis's inputs into the workspace tree


The system SHALL provide `stageInputs(analysisId, targetDir)` in
`src/modules/staging/staging.ts` returning `Result`-typed `StagedInput[]`, where
`targetDir` is the analysis workspace's `data/` root
(`{workspaceRoot}/data`, i.e. `<anchorPath>/.inflexa/analyses/<slug>/data` — resolved
via the same rule as every other workspace path; the deleted session-tree helpers
`sessionTreeRoot`/`sessionTreeDataDir` have no successor module, callers derive from
the workspace root). Each staged file SHALL be placed at
`{targetDir}/inputs/local/{key}` and described by a manifest entry
`{fileId, mountName: "local", key, fileName, hash, size, mtimeMs, relativePath}` whose
`relativePath` is `inputs/local/{key}` — field-for-field compatible with the harness
`StagedInput` contract, passed to the harness verbatim with no transform. Directory
inputs SHALL be walked into one entry per contained file, with `key` preserving the
input's relative structure. Anchored inputs use their anchor-relative path as the
key; anchorless inputs (absolute host paths) SHALL use `{fileId}/{basename}` instead
— the host filesystem layout must never leak into the sandbox tree or the manifest,
and keys MUST equal the staged file's path relative to `inputs/local` exactly.

`size` and `mtimeMs` SHALL be read from the same `stat` of the source file, so the manifest's drift
signature is consistent with the one `enumerateInputSignatures` produces for the same file.

#### Scenario: The manifest carries the drift signature

- **WHEN** `stageInputs` materializes an input file
- **THEN** its manifest element SHALL carry the source file's `size` in bytes and `mtimeMs` in epoch milliseconds

#### Scenario: Anchorless input keys carry no host path

- **WHEN** an input stored as an absolute path (no anchor) is staged
- **THEN** its key is `{fileId}/{basename}`, the file exists at `inputs/local/{key}`, and no host directory segment appears in the manifest

#### Scenario: Single-file input staged at the contract path

- **WHEN** `stageInputs` runs for an analysis with one resolvable single-file input
- **THEN** the file's bytes are readable at `{targetDir}/inputs/local/{key}`
- **AND** the returned manifest has one entry with `relativePath = "inputs/local/{key}"`, the file's content hash, and its size

#### Scenario: Directory input becomes per-file entries

- **WHEN** an input resolves to a directory containing nested files
- **THEN** every contained file is staged under `{targetDir}/inputs/local/` preserving its relative subpath
- **AND** the manifest contains one entry per file, none for directories

#### Scenario: Unresolvable inputs are skipped, staging continues

- **WHEN** one input's anchor cannot be resolved and another input is resolvable
- **THEN** the unresolvable input is omitted from the manifest
- **AND** the resolvable input is staged normally (partial staging over total failure)

#### Scenario: Staging I/O errors fail the whole operation

- **WHEN** copying or linking a resolvable input fails with a filesystem error
- **THEN** `stageInputs` returns the error variant rather than a partial manifest

### Requirement: Hardlink-first materialization


Staging SHALL attempt a hardlink first and fall back to a byte copy when linking fails
(e.g. cross-filesystem). With the workspace under the anchor, the hardlink path is the
common case — inputs usually share the anchor's filesystem. Staging SHALL NOT create
symlinks: the workspace tree is bind-mounted into sandbox containers, where host
symlinks dangle.

#### Scenario: Cross-filesystem fallback

- **WHEN** the input file lives on a different filesystem than the workspace tree
- **THEN** the file is staged as a full copy and the manifest entry is identical to the hardlink case

### Requirement: Symlinked files inside directory inputs are staged


When walking a directory input, entries that are symlinks SHALL be resolved via stat:
a symlink to a file is staged (as the target's content), and a symlink to a directory
is traversed. Symlinks whose target does not exist SHALL be skipped without failing
the walk.

#### Scenario: Symlink to a file within a directory input

- **WHEN** a directory input contains a symlink pointing at a regular file
- **THEN** the target's content is staged and appears in the manifest

#### Scenario: Dangling symlink is skipped

- **WHEN** a directory input contains a symlink whose target no longer exists
- **THEN** the walk completes without error and no manifest entry is produced for it

### Requirement: Noise directories are never staged


Directory-input walks SHALL skip directories whose name identifies tool or
source-control noise rather than data: the harness's ignored set (`node_modules`,
`__pycache__`, `.cache`, `.ruff_cache`, `.ipynb_checkpoints`, `.Rproj.user`) plus the
cli-specific `.git` and `.inflexa`. The `.inflexa` exclusion is load-bearing, not
hygiene: the workspace itself lives at `<anchor>/.inflexa/analyses/<slug>/`, so an
anchor-folder directory input would otherwise stage the analysis's own staged inputs
and run artifacts into itself, recursively. Skipping SHALL apply
to the whole subtree, including directories reached through symlinks.

#### Scenario: Project root selected as a directory input

- **WHEN** a directory input contains `node_modules/`, `.git/`, and a data file
- **THEN** only the data file is staged and the noise directories appear neither in the manifest nor on disk

#### Scenario: The anchor folder as an input never stages the workspace

- **GIVEN** an analysis whose input is its own anchor folder, after a completed run (the workspace holds `data/` and `runs/`)
- **WHEN** `stageInputs` runs again
- **THEN** nothing under `.inflexa/` is staged — the workspace does not ingest itself

### Requirement: The staged tree mirrors the current inputs


`stageInputs` SHALL reconcile the `inputs/local` tree against the manifest it just
produced: staged files no current input produced SHALL be deleted, and directories
emptied by those deletions SHALL be pruned. Reconciliation happens at staging time —
not at input-removal time — because the expected manifest only exists here, removal
of the database row leaves nothing to key file cleanup on, and removal-time deletion
could race a run holding the tree in a read-only mount.

#### Scenario: Removed input's files disappear on the next staging

- **WHEN** an input is removed from the analysis and `stageInputs` runs again
- **THEN** that input's staged files are deleted, its emptied directories pruned, and the remaining inputs' files untouched

#### Scenario: Newly ignored subtrees are cleaned up

- **WHEN** the staged tree contains files under a directory name the walk now ignores
- **THEN** the next staging deletes them even though the staging walk itself skips that name

### Requirement: Deterministic file identity


`fileId` SHALL be derived deterministically from the input's identity (anchor id plus
input path, plus the relative subpath for files inside directory inputs), so re-staging
the same input yields the same `fileId` across runs. The derivation for directory
members (subpath included) SHALL be documented where it diverges from single-file
derivation.

#### Scenario: Re-staging yields stable identities

- **WHEN** the same analysis is staged twice with unchanged inputs
- **THEN** every file receives the same `fileId` in both manifests

### Requirement: Identity-only input enumeration


The system SHALL provide `enumerateInputSignatures(analysisId)` in `src/modules/staging/` returning the
`Result`-typed set of **drift signatures** — `(fileId, size, mtimeMs)` — that `stageInputs` would
produce for the analysis's current inputs, using the same identity derivation and the same walk rules
(noise-directory skips, symlink handling, unresolvable inputs skipped, same-destination collision
resolved last-write-wins) — while writing nothing to the workspace tree, hashing no file content, and not
requiring the workspace tree to exist.

Its cost SHALL be bounded by directory enumeration plus one `stat` per file (never by input content
size), so parity drift checks can run on every chat open and every input mutation. The identity walk
SHALL be single-sourced with staging's walk: the two MUST NOT be able to drift on which files an input
yields.

The signature exists because `fileId` is derived from the input's anchor and path: two enumerations of
the same paths holding different bytes have identical `fileId` sets. Adding `size` and `mtimeMs` makes
an in-place content edit observable at stat cost. It SHALL NOT include a content hash — reading every
input in full on every chat open is the cost this enumeration exists to avoid. An edit that preserves
both byte length and mtime is consequently not detected; this is a bounded, accepted limitation.

#### Scenario: Enumeration matches staging's identity set

- **WHEN** `enumerateInputSignatures` and `stageInputs` run against the same inputs
- **THEN** every enumerated signature's `fileId` component equals exactly one staged manifest entry's `fileId`, and the two sets have the same size

#### Scenario: Enumeration performs no writes

- **WHEN** `enumerateInputSignatures` runs for an analysis whose workspace tree does not exist
- **THEN** it returns the signature set and creates no directory or file

#### Scenario: Enumeration hashes nothing

- **WHEN** `enumerateInputSignatures` runs over a large input file
- **THEN** the file's content SHALL NOT be read

#### Scenario: Unresolvable inputs are skipped consistently

- **WHEN** one input's anchor cannot be resolved
- **THEN** the enumeration omits it, exactly as staging's walk would

#### Scenario: An in-place edit changes the signature

- **WHEN** an input file's bytes are rewritten at the same path, changing its size or mtime
- **THEN** its enumerated signature SHALL differ from the one enumerated before the edit
- **AND** its `fileId` SHALL be unchanged

### Requirement: Materialization is independent of the data-profile lifecycle

Staging SHALL be a service the caller invokes to make an analysis's current input set exist on disk,
and SHALL carry no dependency on — and impose no precondition from — the data-profile ledger. A
caller SHALL be able to materialize an input set whose analysis has never been profiled, whose profile
is `pending`, or whose profile is `failed`, with identical results.

This is a contract on the *boundary*, not a behavior change inside `stageInputs`: the function already
takes only an analysis id and a target directory and reads no profile state. The requirement exists so
that no caller may reintroduce a profile-state gate above it, which is precisely how registered inputs
came to be silently withheld from the workspace tree.

#### Scenario: A never-profiled analysis materializes

- **WHEN** `stageInputs` runs for an analysis with resolvable inputs and no data-profile row
- **THEN** the files are staged and the manifest is returned, with no ledger read

#### Scenario: A failed profile does not prevent materialization

- **GIVEN** an analysis whose data-profile row is `failed`
- **WHEN** `stageInputs` runs for it
- **THEN** the files are staged and the manifest is returned, identically to the never-profiled case

### Requirement: The staged tree records what was materialized

A staged file SHALL carry the same size and modification time as the source it was staged from, so
that the staged tree is a faithful record of the input set it materialized and no separate record of
that set is kept.

Hardlink placement satisfies this by construction, because the staged path and the source share an
inode. The copy fallback SHALL therefore stamp the source's modification time onto the destination
after copying, since a copy otherwise carries its own creation time. That stamp SHALL be applied only
on the copy path: applying it to a hardlinked staged file would rewrite the shared inode and so mutate
the user's own source file, which the read-only enumeration would then report as drift forever.

#### Scenario: A hardlinked staged file matches its source

- **WHEN** an input is staged by hardlink
- **THEN** the staged path reports the same size and modification time as the source

#### Scenario: A copied staged file matches its source

- **WHEN** an input is staged through the cross-filesystem copy fallback
- **THEN** the staged path reports the same size and modification time as the source

#### Scenario: Staging never mutates the source file's timestamps

- **WHEN** an input is staged by hardlink
- **THEN** the source file's modification time SHALL be unchanged by staging
- **AND** a subsequent read-only enumeration SHALL report no drift

### Requirement: An already-materialized predicate keeps repeat checks cheap

The module SHALL expose a predicate answering whether an analysis's current input set is already
materialized in a target tree. It SHALL be derived from the staged tree itself — comparing each
expected staged path's size and modification time against the source, and detecting files under the
staged root that the current input set does not produce. It SHALL cost no more than the read-only
enumeration it complements: stat and readdir only, never content hashing and never a tree write.

The predicate SHALL be conservative in one direction only. A missing file, a size or modification-time
mismatch, an unreadable path, or an unexpected extra file SHALL all read as not-materialized, so the
worst outcome is a redundant staging pass. It SHALL NOT be possible for the predicate to report
already-materialized for a set that is not fully present and current.

Under hardlink placement the staged path and the source are one inode, so an edit written **in place**
(truncate-and-write, preserving the inode) mutates both at once and the predicate correctly reports
already-materialized — the staged tree does hold the new bytes, and there is nothing to restage. An edit
that **replaces** the path (write-to-temp then rename, which is what editors and most tools do) produces
a new inode and reads as not-materialized. This asymmetry is a property of hardlinking, not a defect, and
it SHALL be pinned by tests in both directions so it is never mistaken for one.

The predicate introduces no shared mutable state, so cross-process exclusion for one analysis remains
the per-analysis instance lock's responsibility, unchanged.

#### Scenario: An unchanged input set reports as already materialized

- **GIVEN** `stageInputs` has materialized an input set
- **WHEN** the predicate is asked about the same analysis and target tree
- **THEN** it SHALL report already-materialized, without hashing file content

#### Scenario: A replaced input file reports as not materialized

- **GIVEN** `stageInputs` has materialized an input set
- **WHEN** an input file is replaced at the same path by a write-then-rename, producing a new inode
- **THEN** the predicate SHALL report not-materialized

#### Scenario: A truncate-in-place edit is already materialized under hardlinking

- **GIVEN** `stageInputs` has materialized an input set by hardlink
- **WHEN** an input file's bytes are rewritten in place, preserving its inode
- **THEN** the predicate SHALL report already-materialized, because the staged path is that same inode and already holds the new bytes

#### Scenario: A newly registered input reports as not materialized

- **GIVEN** a materialized input set
- **WHEN** a further input is registered for the analysis
- **THEN** the predicate SHALL report not-materialized

#### Scenario: A removed input leaves the tree not materialized

- **GIVEN** a materialized input set
- **WHEN** an input is removed from the analysis while its staged file remains on disk
- **THEN** the predicate SHALL report not-materialized, so the mirror pass runs and deletes it

#### Scenario: A deleted staged file reports as not materialized

- **GIVEN** a materialized input set
- **WHEN** a staged file is deleted from the tree by hand
- **THEN** the predicate SHALL report not-materialized, and a subsequent staging pass SHALL restore it
