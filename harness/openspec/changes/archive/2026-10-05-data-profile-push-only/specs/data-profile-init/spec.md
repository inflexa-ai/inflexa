## MODIFIED Requirements

### Requirement: The profile is readable only through inspect_data_profile

There SHALL be no data-profile file anywhere in the workspace — the profiler's scratch
tree is deleted on completion, so the `cortex_analysis_state` row is the profile's sole
durable home. The harness SHALL therefore expose an `inspect_data_profile` tool that
reads that row, wired to the conversation agent and to **every** sandbox agent as
always-on substrate (see the harness-sandbox-agents spec), and its description SHALL tell
the agent that no profile file exists.

The tool SHALL be bounded by construction: `scope: "overview"` (the default) returns the
dataset-level facts and the partition accounting, `scope: "groups"` returns the groups
with their slots and the dimensions with their observations, and `scope: "files"` pages
the individually annotated member records (`page`, `pageSize`, default 20, max 100),
always reporting the true `total` and `hasMore`.

The tool SHALL distinguish the number of members annotated individually from the number
of files in the dataset, and SHALL report both, directing the agent to `scope: "groups"`
for structure and to the workspace listing tools for paths.

For a legacy snapshot the `groups` scope SHALL serve the stored `kinds` and `axes`,
labelled as authored under the previous model, rather than reporting the scope
unavailable — the structure exists and an agent SHALL NOT be told the dataset has none.

Every lifecycle state SHALL remain a data variant in the ok channel — `ready`, `stale`,
`pending`, `failed`, `absent` — with the failed-state semantics unchanged: a failure is a
past attempt, `failedAt` carries the recorded time or null, no underivable staleness
verdict is exposed, and a surviving prior profile is served as `stale` rather than
`failed`.

Every `staleReason` SHALL be a fact the ledger row states outright — an attempt is in
flight over a preserved prior result, or the most recent attempt failed over one.
`tryRerun` / `tryRetry` preserve `data_profile_result` precisely so a prior profile
stays servable, and reporting that is reporting the row.

A changed input set SHALL NOT be among the reasons. The tool reads one row and holds
no current input set, and re-profiling is invoked by the embedder that owns the input
mutation (see the data-profile-rerun spec) — so a row still reading `completed` is a row
nothing has superseded. Deriving a verdict here would re-decide, from strictly less
information, a question already answered by the party that watched the change happen.

#### Scenario: The groups scope returns the resolved structure

- **GIVEN** a completed profile over a tree resolved into groups with dimensions
- **WHEN** an agent calls `inspect_data_profile` with `scope: "groups"`
- **THEN** it receives the groups with derived counts, display patterns, and slots, and the dimensions with their observations

#### Scenario: A legacy snapshot's structure is served, labelled

- **GIVEN** a snapshot written under the previous model
- **WHEN** an agent calls `inspect_data_profile` with `scope: "groups"`
- **THEN** it receives the stored kinds and axes, labelled as authored under the previous model

#### Scenario: The overview carries the accounting

- **WHEN** an agent calls `inspect_data_profile` on a completed profile
- **THEN** the overview SHALL report the kept, unclassified, and quarantined counts alongside the classification

#### Scenario: An annotated-member count does not masquerade as the dataset size

- **GIVEN** a profile annotating 8 members out of thousands of files
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** the result SHALL report both figures distinctly

#### Scenario: A changed input set is not reported as stale

- **GIVEN** a `completed` row whose seeded input set names files the stored profile never covered
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "ready"` and no `staleReason`

#### Scenario: A re-profile in flight is reported as stale

- **GIVEN** a row whose status moved to `running` while an earlier result is still stored on it
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "stale"` carrying the previous profile AND a `staleReason` naming the re-profile in flight

#### Scenario: A surviving prior profile is served as stale, not failed

- **GIVEN** a profile row whose latest attempt failed but which still carries an earlier result
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "stale"` with a `staleReason` naming the failed re-profile
