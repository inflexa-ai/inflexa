## REMOVED Requirements

### Requirement: The headless parity and force checks judge drift on content signatures

**Reason**: The comparison was an inference — a `(fileId, size, mtimeMs)` difference read as
"the data changed" — standing in for a fact this process already holds. `git checkout`,
`cp -r`, `rsync` without `-a`, unzip, and cloud sync all move size and mtime without changing
a byte, and each false positive cost a sandbox spin-up plus an agent run that re-rolled the
kind names, axis labels, and summary a user was already working from.

**Migration**: replaced by the requirement below. `reprofileForInputChange` is driven by the
in-process `prov.input_added` / `prov.input_removed` edge; `ensureProfileAtParity` materializes
and reports `already_profiled` without comparing anything. `enumerateInputSignatures` becomes
`enumerateInputPaths` (see the input-staging spec), so no drift signature is gathered at all.

## ADDED Requirements

### Requirement: The headless checks re-profile on a recorded input mutation, not on a comparison

A re-profile SHALL be driven by an input mutation this process performed and recorded, never by
comparing a freshly enumerated input set against the one a completed row covered.

`reprofileForInputChange` SHALL be the entry point the in-process `prov.input_added` /
`prov.input_removed` edge drives. It SHALL (re-)trigger a `completed` row, and SHALL retry a `failed`
row rather than skipping it, because the set that failed is demonstrably not the set on disk now.

`ensureProfileAtParity` SHALL be the entry point a chat open, an analysis swap, and a settling profile
run drive. Against a `completed` row it SHALL bring the workspace tree up to date — consulting the
already-materialized predicate and staging when the tree is behind — and SHALL yield `already_profiled`
without dispatching a workflow. It SHALL NOT compare input sets, and SHALL NOT re-profile on any
difference it might have observed.

Both SHALL share the rest of the ladder: the orphaned-`running` reconcile, the emptied-set clear (an
emptied input set is an input mutation too), and the live-run defer, which suppresses materialization
because staging reconcile-deletes a tree that run's sandbox is reading.

The comparison is removed rather than narrowed because it was an inference standing in for a fact. A
`(fileId, size, mtimeMs)` difference is produced by `git checkout`, `cp -r`, `rsync` without `-a`,
unzip, and cloud sync without a byte changing, and each false positive costs a sandbox spin-up plus an
agent run whose output re-rolls the kind names, axis labels, and summary a user is already working from.

`forceReprofile` SHALL continue past a live-run check to always materialize, seed, and trigger. It is
also the only repair for an in-place edit of an already-attached file, which changes no path and so
raises no input event.

#### Scenario: A chat open does not re-profile a completed row

- **GIVEN** a `completed` profile row and an input set that no longer matches what it covered
- **WHEN** `ensureProfileAtParity` runs
- **THEN** it SHALL yield `already_profiled` and dispatch no workflow

#### Scenario: A chat open still brings the tree up to date

- **GIVEN** a `completed` profile row whose staged tree is behind the current input set
- **WHEN** `ensureProfileAtParity` runs
- **THEN** it SHALL stage the current input set
- **AND** SHALL still yield `already_profiled` without dispatching a workflow

#### Scenario: An input mutation re-profiles

- **WHEN** `reprofileForInputChange` runs against a `completed` row
- **THEN** it SHALL materialize, seed, and trigger, yielding `triggered`

#### Scenario: An input mutation retries a failed row

- **GIVEN** a `failed` row whose input set is already materialized
- **WHEN** `reprofileForInputChange` runs
- **THEN** it SHALL claim the `failed → running` transition and run, rather than yielding `skipped_failed`

#### Scenario: An emptied input set clears on either drive

- **GIVEN** an analysis whose inputs have all been removed
- **WHEN** either entry point runs against a settled profile row
- **THEN** the profile SHALL be cleared and the outcome SHALL be `cleared`

#### Scenario: A live run defers both drives

- **GIVEN** a `running` profile row
- **WHEN** either entry point runs
- **THEN** it SHALL yield `already_running` and SHALL NOT stage
