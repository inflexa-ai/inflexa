## ADDED Requirements

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
