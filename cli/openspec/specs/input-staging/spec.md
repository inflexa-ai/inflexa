# input-staging Specification

## Purpose
Materialize an analysis's selected inputs into its workspace tree (`{workspaceRoot}/data/inputs/local/…`) and give the `StagedInput[]` manifest, which the caller sums for the embedded harness — hardlink-first placement, noise-dir-aware directory walks, deterministic file identity, staging-time mirroring so the tree always reflects the current inputs, and a read-only path enumeration sharing the same walk (it tells the profile ladder whether the analysis has inputs on disk). Lives in `src/modules/staging/`; the workspace-root rule is owned by `path-resolution`, and its harness-seam realization by `harness-runtime`.

## Requirements

### Requirement: Stage an analysis's inputs into the workspace tree

The system SHALL provide `stageInputs(analysisId, targetDir)` in
`src/modules/staging/staging.ts` returning a `Result`-typed outcome `{ staged: StagedInput[]; warnings: string[] }`, where
`targetDir` is the analysis workspace's `data/` root
(`{workspaceRoot}/data`, i.e. `<anchorPath>/.inflexa/analyses/<slug>/data` — resolved
via the same rule as every other workspace path; the deleted session-tree helpers
`sessionTreeRoot`/`sessionTreeDataDir` have no successor module, callers derive from
the workspace root). Each staged file SHALL be placed at
`{targetDir}/inputs/local/{key}` and described by a manifest entry
`{fileId, mountName: "local", key, fileName, size, mtimeMs, relativePath}` whose
`relativePath` is `inputs/local/{key}` — field-for-field compatible with the harness
`StagedInput` contract. The entry carries no content hash: staging reads no file content.
The caller sums the manifest into the harness `StagedInputSummary` (the count, the total
bytes, and `computeInputSignature`) for the trigger. Directory
inputs SHALL be walked into one entry per contained file, with `key` preserving the
input's relative structure. Anchored inputs use their anchor-relative path as the
key; anchorless inputs (absolute host paths) SHALL use `{fileId}/{basename}` instead
— the host filesystem layout must never leak into the sandbox tree or the manifest,
and keys MUST equal the staged file's path relative to `inputs/local` exactly.

`size` and `mtimeMs` SHALL be read from the same `stat` of the source file. They serve two
readers: the profile snapshot's recorded `inputSignature`, an audit record of what a profile
covered, and `isInputSetMaterialized`, which compares them against the staged copy to decide
whether the tree is current. They are no longer a drift comparand — a re-profile is invoked on
the input-mutation edge rather than derived from comparing them.

Every disk operation of the module — the walks, the `stat` calls, the link or copy, the reconcile
of the staged tree, and the reads of the enumeration and the already-materialized
predicate — SHALL run off the event loop (`node:fs/promises`), because the local server stages for a
request and an input tree on a hung mount must stop only that request. A walk or a `stat` pass SHALL
keep a fixed count of operations in flight, and staging SHALL place a fixed count of files at
one time, so a large tree neither runs one file at a time nor fills the thread pool of the server.
Files that stage to the same destination SHALL stage one after
the other in walk order, never at the same time: a concurrent placement can lose its `link` and copy
onto a hardlink of the same source, which truncates the user's file.

#### Scenario: The manifest carries the size and mtime

- **WHEN** `stageInputs` materializes an input file
- **THEN** its manifest element SHALL carry the source file's `size` in bytes and `mtimeMs` in epoch milliseconds
- **AND** both SHALL come from the same `stat` call, taken before placement

#### Scenario: Anchorless input keys carry no host path

- **WHEN** an anchorless input at an absolute host path is staged
- **THEN** its `key` SHALL be `{fileId}/{basename}` and SHALL contain no directory component of the host path

#### Scenario: Single-file input staged at the contract path

- **WHEN** `stageInputs` runs for an analysis with one resolvable single-file input
- **THEN** the file's bytes are readable at `{targetDir}/inputs/local/{key}`
- **AND** the returned manifest has one entry with `relativePath = "inputs/local/{key}"` and the file's size

#### Scenario: Directory input becomes per-file entries

- **WHEN** an input resolves to a directory containing nested files
- **THEN** every contained file is staged under `{targetDir}/inputs/local/` preserving its relative subpath
- **AND** the manifest contains one entry per file, none for directories

#### Scenario: Unresolvable inputs are skipped, staging continues

- **WHEN** one input's anchor cannot be resolved, nothing was staged for it, and another input is resolvable
- **THEN** the unresolvable input is omitted from the manifest, and the outcome names it in `warnings`
- **AND** the resolvable input is staged normally (partial staging over total failure)

#### Scenario: Inputs that share a destination stage in order

- **GIVEN** a directory input and a file input inside it, which stage to the same destination
- **WHEN** `stageInputs` runs, on a fresh tree or over a staged one
- **THEN** the manifest has one entry for that destination
- **AND** the source file is unchanged

#### Scenario: A write error fails the whole operation

- **WHEN** a write to the staged tree fails (the folder, the removal of a stale file, the copy of a readable source, or the time stamp)
- **THEN** `stageInputs` returns the error variant rather than a partial manifest

### Requirement: A source that cannot be read is skipped, not fatal

A file or a directory of a source that staging cannot read (`EACCES`, `EIO`, and others) SHALL be
skipped, and the outcome SHALL name it in `warnings`. The shared walk SHALL decide it (a failed `readdir`,
`stat`, or `access` for read), thus staging, the enumeration, and the already-materialized predicate leave
out the same files, and `enumerateInputPaths` counts them in `unreadable`. It SHALL NOT fail the pass. A path that vanished
during the walk (`ENOENT`) SHALL be skipped with no warning. A skipped path SHALL keep the copy that an
earlier pass staged for it, and the manifest SHALL describe that copy. Staging SHALL read the source
before it removes a stale destination, thus a source that cannot be read never loses its staged copy.

#### Scenario: An unreadable directory is skipped

- **WHEN** a directory input holds a readable file and a directory that cannot be read
- **THEN** the readable file is staged, and `warnings` names the directory

#### Scenario: An unreadable file is skipped

- **WHEN** an input file cannot be read and was never staged
- **THEN** the pass completes over the other inputs, and `warnings` names the file
- **AND** the enumeration leaves the file out, and the predicate reports the rest of the set already-materialized

### Requirement: A source that is not reachable keeps its staged files

An input row that the user removed SHALL lose its staged files at the next pass. A source that is
missing while its row remains is one of two cases, decided for the whole input:

- The source is not reachable now when the anchor root of the input cannot be located, when its `stat`
  fails with `ESTALE` or `EIO`, when the root of a directory input is missing or empty, or when the parent
  folder of a file input is missing or empty. An unmounted volume, and an autofs or NFS mount point that
  stays as an empty folder, look like this. Such a source SHALL keep its staged files. The walk SHALL carry
  them into the manifest and into the enumeration, from the staged copy, and the outcome SHALL name the
  source in `warnings`.
- The source was deleted when a file input is missing from a parent folder that holds other entries, or
  when a member is missing from a directory input whose root holds entries. Its staged files SHALL go at
  the next pass, as for a removed input row, and the outcome SHALL name nothing.

A user who deletes the last file of a folder keeps its staged copy until the folder goes: the rule errs
toward keeping data. Thus an unmounted volume does not clear the profile (see the data-profile-launch
spec), and a deleted source does not stay forever. `enumerateInputPaths` reports the count of
unreachable inputs in `unreachable`.

#### Scenario: An unmounted source keeps its staged files

- **GIVEN** an input that a pass staged
- **WHEN** its source is not reachable and `stageInputs` runs again
- **THEN** its staged file stays, the manifest describes it, and `warnings` names the source

#### Scenario: A source deleted from a present folder loses its files

- **GIVEN** an input that a pass staged
- **WHEN** its source is deleted, its folder stays with other entries, and `stageInputs` runs again
- **THEN** its staged file is deleted, `unreachable` is 0, and `warnings` is empty

#### Scenario: A directory input whose root is empty keeps its files

- **GIVEN** a directory input that a pass staged
- **WHEN** its root stays as an empty folder and `stageInputs` runs again
- **THEN** its staged files stay, and `warnings` names the root

#### Scenario: A member deleted from a directory input loses its file

- **GIVEN** a directory input that a pass staged
- **WHEN** one member is deleted, the root holds other entries, and `stageInputs` runs again
- **THEN** the staged file of that member is deleted, and `warnings` is empty

#### Scenario: A file input whose parent folder is empty keeps its file

- **GIVEN** a file input that a pass staged
- **WHEN** it is deleted and its parent folder is left empty, and `stageInputs` runs again
- **THEN** its staged file stays, and `warnings` names it

#### Scenario: A source whose anchor root is missing keeps its files

- **GIVEN** an input under a second anchor that a pass staged
- **WHEN** the anchor root is gone and `stageInputs` runs again
- **THEN** its staged file stays, and `warnings` names the input

#### Scenario: A removed input row takes its files

- **WHEN** the user removes an input and `stageInputs` runs again
- **THEN** the staged files of that input are deleted, and `warnings` is empty

### Requirement: An unchanged destination is kept

Staging SHALL keep a destination that is already a hardlink of the source (the same `dev` and `ino`),
or a copy — a regular file on a different volume than the source, or with one link — with the same size
and modification time as the source. A destination that is a hardlink of a different file SHALL be linked
again, whatever its size and modification time. The copy fallback SHALL write with `COPYFILE_EXCL`. When
two inputs stage to one destination from different files (by `dev` and `ino`), staging SHALL log the clash. It SHALL NOT remove and link
such a destination again. Thus a pass over an unchanged set writes nothing to the staged tree. Each
other destination SHALL be removed before the link, because `copyFile` onto a hardlink of the source
itself truncates the source.

#### Scenario: Two files with one destination, size, and mtime

- **WHEN** two inputs from different files with the same size and mtime stage to one destination
- **THEN** the destination holds the bytes of the last, as a hardlink of it

#### Scenario: A pass over an unchanged set does not remove a file

- **GIVEN** a staged input set
- **WHEN** the staged folder refuses each removal and `stageInputs` runs again
- **THEN** the pass completes with the same manifest

### Requirement: The progress of a pass is readable

While `stageInputs` runs, `stagingProgress(analysisId)` SHALL give the count of destinations that the
pass placed and the total. After the pass it SHALL give `null`. `GET {A}/data-profile` reports it (see the
local-server spec).

#### Scenario: The progress is gone after the pass

- **WHEN** `stageInputs` completes
- **THEN** `stagingProgress` gives `null` for the analysis

### Requirement: A probe tells when staging will copy

The module SHALL provide `probeHardlinks(sources, targetDir)`. For each volume of the sources, it SHALL
make one real hardlink of the real path of one file of the sources into the nearest existing directory of `targetDir`,
and then remove the link. A comparison of `st_dev` alone is not sufficient, because exFAT refuses a
hardlink on the same device. When a link fails, it SHALL give a warning that names the sources that
staging will copy, and that tells the user to put the analysis folder on the same volume as the data.
Otherwise it SHALL give `null`.

#### Scenario: A source that refuses a hardlink gives the warning

- **WHEN** a source refuses a hardlink into the analysis folder
- **THEN** `probeHardlinks` gives the warning, and the probe leaves no file

#### Scenario: A source on the volume of the analysis folder gives no warning

- **WHEN** each source can hardlink into the analysis folder
- **THEN** `probeHardlinks` gives `null`

### Requirement: Hardlink-first materialization

Staging SHALL attempt a hardlink first and fall back to a byte copy when linking fails
(e.g. cross-filesystem). With the workspace under the anchor, the hardlink path is the
common case — inputs usually share the anchor's filesystem. Staging SHALL NOT create
symlinks: the workspace tree is bind-mounted into sandbox containers, where host
symlinks dangle. Staging SHALL link the real path of the source, because `link(2)` on
Linux does not follow a symlink, and a hardlink of a symlink is a symlink.

#### Scenario: Cross-filesystem fallback

- **WHEN** the input file lives on a different filesystem than the workspace tree
- **THEN** the file is staged as a full copy and the manifest entry is identical to the hardlink case

#### Scenario: A symlinked input file stages as its real file

- **WHEN** an input file is a symlink to a regular file
- **THEN** the staged path is a hardlink of the real file, not a symlink

### Requirement: Symlinked files inside directory inputs are staged

When walking a directory input, entries that are symlinks SHALL be resolved via stat:
a symlink to a file is staged (as the target's content), and a symlink to a directory
is traversed. Symlinks whose target does not exist SHALL be skipped without failing
the walk. A directory SHALL give its files under one path only for each `(dev, ino)`:
the path that comes first in a depth-first walk of the `readdir` order, whatever order
the reads complete in. Thus a symlink that points back up the tree ends the descent, and
two aliases of one directory give the same paths and file ids on each run. An entry that
`readdir` does not report as a file (a symlink, a directory, or `DT_UNKNOWN` on some NFS
and FUSE mounts) SHALL be resolved with `stat`.

#### Scenario: Symlink to a file within a directory input

- **WHEN** a directory input contains a symlink pointing at a regular file
- **THEN** the target's content is staged and appears in the manifest

#### Scenario: Dangling symlink is skipped

- **WHEN** a directory input contains a symlink whose target no longer exists
- **THEN** the walk completes without error and no manifest entry is produced for it

#### Scenario: A directory loop ends the walk

- **WHEN** a directory input contains a symlink to one of its ancestors
- **THEN** the walk completes, and each file appears one time

### Requirement: Noise directories are never staged

Directory-input walks SHALL skip directories whose name identifies tool or
source-control noise rather than data: the harness's ignored set (`node_modules`,
`__pycache__`, `.cache`, `.ruff_cache`, `.ipynb_checkpoints`, `.Rproj.user`) plus the
cli-specific `.git` and `.inflexa`, and the scratch trees of the workflow engines and the
archive droppings (`work`, `.nextflow`, `.snakemake`, `__MACOSX`). Staging SHALL
also leave out each file whose `relativePath` the harness quarantines (`quarantineReason`):
AppleDouble `._*` files, partial downloads, editor temps, files under `__MACOSX` or
`.Trash-*`, and others. It SHALL apply the rule to the same path that
`computeInputSignature` reads, thus the count of the manifest equals the count of the
signature. Staging, the enumeration, and the already-materialized predicate SHALL apply
the same filter through the walk that they share. The `.inflexa` exclusion is load-bearing, not
hygiene: the workspace itself lives at `<anchor>/.inflexa/analyses/<slug>/`, so an
anchor-folder directory input would otherwise stage the analysis's own staged inputs
and run artifacts into itself, recursively. Skipping SHALL apply
to the whole subtree, including directories reached through symlinks.

#### Scenario: Quarantined names and engine trees are not staged

- **WHEN** a directory input holds `counts.csv`, `._counts.csv`, `reads.bam.part`, and the folders `work/`, `.snakemake/`, `.nextflow/`, and `__MACOSX/`
- **THEN** only `counts.csv` is staged, the enumeration gives the same set, and the predicate reports already-materialized

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
enumeration it complements: stat and readdir only, never a content read and never a tree write. A
source that the walk cannot read is not in the expected set.

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
- **THEN** it SHALL report already-materialized, without reading file content

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

### Requirement: Identity-only input path enumeration

The system SHALL provide `enumerateInputPaths(analysisId, dataDir)` in `src/modules/staging/` returning a
`Result`-typed `{ paths, warnings, unreachable }`, where `paths` is the set of **analysis-relative paths**
that `stageInputs` would produce for the analysis's current inputs, using the same identity derivation
and the same walk rules (noise-directory and quarantine skips, symlink handling, the staged files of an
unreachable source carried from `dataDir`, same-destination collision resolved last-write-wins) —
while writing nothing to the workspace tree, reading no file content, and not requiring the workspace
tree to exist. A `null` `dataDir` carries no staged file.

Its cost SHALL be bounded by directory enumeration plus one `stat` per file (never by input content
size). The identity walk SHALL be single-sourced with staging's walk: the two MUST NOT be able to drift
on which files an input yields.

It SHALL carry no `size` or `mtimeMs`. Those existed to make an in-place content edit observable at stat
cost, for a drift comparison that no longer runs: a re-profile is invoked on the input-mutation edge, so
per-file drift signatures would be gathered on every chat open for no reader. The question this
enumeration answers is whether the analysis has inputs on disk right now — which is what the profile
ladder branches on, and what the emptied-set clear depends on.

A file that vanished between the walk and its `stat` SHALL be omitted rather than raising, because the
database and the filesystem routinely disagree and a gone file is honestly reported as absent.

#### Scenario: Enumeration matches staging's path set

- **WHEN** `enumerateInputPaths` and `stageInputs` run against the same inputs
- **THEN** the enumerated set SHALL equal the staged manifest's `relativePath` set exactly

#### Scenario: Enumeration performs no writes

- **WHEN** `enumerateInputPaths` runs for an analysis whose workspace tree does not exist
- **THEN** it returns the path set and creates no directory or file

#### Scenario: Enumeration reads no content

- **WHEN** `enumerateInputPaths` runs over a large input file
- **THEN** the file's content SHALL NOT be read

#### Scenario: Unresolvable inputs are treated consistently

- **WHEN** one input's anchor cannot be resolved
- **THEN** the enumeration gives its staged files, or none when nothing was staged for it, exactly as staging's walk would

#### Scenario: A vanished source is not a failure

- **WHEN** an input's row survives but its file was deleted from a present folder
- **THEN** the enumeration leaves the file out, counts nothing in `unreachable`, and stays in the ok channel
