## MODIFIED Requirements

### Requirement: The profile is readable only through inspect_data_profile

The conversation agent SHALL read the data profile through the in-process
`inspect_data_profile` tool, which reads the analysis's `data_profile_result` row. The
profile is not a workspace file, so the tool is the only path to it: no sandbox-side
profile file exists, so it neither hunts for one nor re-derives the facts from the
raw inputs.

The tool SHALL be bounded by construction: `scope: "overview"` (the default)
returns the dataset-level facts plus the profiled-file count, and `scope: "files"`
pages the per-file records (`page`, `pageSize`, default 20, max 100) and SHALL
always report the true `total` and `hasMore`, so an elided tail is a fact the
model can see and act on rather than a silent truncation.

Every lifecycle state SHALL be a data variant in the ok channel, never an error:
`ready`; `stale` (a profile is still returned, with a `staleReason` naming why it
may not describe the current inputs); `pending`; `failed`; and `absent` (never
profiled, or the analysis has no input files).

Every `staleReason` SHALL be a fact the ledger row states outright — an attempt is
running over a preserved prior result, or the most recent attempt failed over one.
`tryRerun` / `tryRetry` preserve `data_profile_result` precisely so a prior profile
stays servable, and reporting that is reporting the row.

A changed input set SHALL NOT be among the reasons. The tool reads one row and holds
no current input set, and re-profiling is invoked by the embedder that owns the input
mutation — so a row still reading `completed` is a row nothing has superseded. Deriving
a verdict here would re-decide, from strictly less information, a question already
answered by the party that watched the change happen.

The `failed` state SHALL NOT imply a verdict on the analysis's current input files.
It reports a past attempt, and the harness cannot determine on its own whether that
attempt covered the files the analysis holds now: the tool reads one ledger row, and
the current input set is the embedder's knowledge, not the harness's. Reporting a
failure without that qualification is what invites the wrong inference.

The variant SHALL therefore carry `failedAt` — the time the failure was recorded, or
null when the row records none — and its message SHALL state that the failure is a
record of an earlier attempt whose relationship to the current inputs this row cannot
establish. A timestamp is reported because it is a fact the row actually holds and an
agent can act on: an agent that knows when the input set last changed can compare the
two itself.

The tool SHALL NOT report a staleness verdict it cannot derive. In particular it SHALL
NOT expose a field whose value is constant on this path, because a field that cannot
discriminate carries no information while implying that it does — and the tool
description, being the whole of what an agent knows about the tool, SHALL NOT advertise
distinctions the implementation cannot produce.

Where a prior profile DID survive the failure, the row is served as `stale` rather than
`failed`. This requirement adds no second definition of staleness and no sixth lifecycle
state.

#### Scenario: A completed profile is served in full

- **WHEN** an agent calls `inspect_data_profile` on an analysis with a completed profile
- **THEN** it receives `state: "ready"` with the dataset-level classification and the profiled-file count

#### Scenario: A changed input set is not reported as stale

- **GIVEN** a `completed` row whose seeded input set names files the stored profile never covered
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "ready"` and no `staleReason`

#### Scenario: A re-profile in flight is reported as stale

- **GIVEN** a row whose status moved to `running` while an earlier result is still stored on it
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "stale"` carrying the previous profile AND a `staleReason` naming the re-profile in flight

#### Scenario: A failure is reported as a past attempt, not a verdict

- **GIVEN** a `failed` profile row with no earlier result
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "failed"` with `failedAt` naming when the failure was recorded
- **AND** the message states the failure is an earlier attempt whose relation to the current inputs this row cannot establish

#### Scenario: A row recording no failure time still answers

- **GIVEN** a `failed` profile row whose recorded completion time is absent
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `failedAt: null` rather than a fabricated or omitted value

#### Scenario: No underivable staleness verdict is exposed

- **WHEN** an agent calls `inspect_data_profile` on a `failed` row
- **THEN** the result SHALL NOT carry a field purporting to say whether the input set changed since the failure
- **AND** the tool description SHALL NOT advertise such a distinction

#### Scenario: A surviving prior profile is served as stale, not failed

- **GIVEN** a profile row whose latest attempt failed but which still carries an earlier result
- **WHEN** an agent calls `inspect_data_profile`
- **THEN** it receives `state: "stale"` with a `staleReason` naming the failed re-profile

#### Scenario: A paged file scope never truncates silently

- **GIVEN** a profile covering 50 files
- **WHEN** an agent calls `inspect_data_profile` with `scope: "files"` and the default page size
- **THEN** it receives 20 records with `total: 50` and `hasMore: true`
