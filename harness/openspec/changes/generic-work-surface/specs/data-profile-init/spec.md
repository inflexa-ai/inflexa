## MODIFIED Requirements

### Requirement: Profile outputs are registered, indexed, and snapshotted

On success the body SHALL register each staged file as a `role: "input"` artifact at
`data/{relativePath}`, index the profile into the analysis vector store, and store a
result snapshot in the `data_profile_status` ledger via `completeDataProfile`. The
profiler's scratch scripts SHALL be confined to `runs/data-profile/profile`.

The body MUST revoke the run authorization on each terminal path: success, no-op,
failure, and a cancel. A pause is not a terminal path (see "The profile pauses in place").
On a cancel, the body revokes and then passes the cancel through (see "A host stops the profile").
`RunAuthorizer.revoke` is a notice (see the `host-hooks`
capability). If `revoke` gives an `err`, the body MUST log the reason at the error
level. The terminal outcome of the profile MUST NOT change.

Indexing SHALL be tiered three ways. The body SHALL index one entry per group under
`type: "input-group"`, one entry per dimension under `type: "input-dimension"`, and one
entry per **annotated member** under the existing `type: "input"` — a member the agent
wrote an individual annotation for is searchable by it; members without annotations are
reachable through their group and the filesystem. The body SHALL NOT index every member:
thousands of near-duplicate entries composed from the same group text add recall noise,
not recall.

Index entry text SHALL be composed deterministically from the group's submitted meaning
and description, the dimension's observations, and the member's annotation. No index entry
requires a model call. The index SHALL remain a pure projection, rebuildable from the tree
and the persisted profile — so indexing SHALL REPLACE rather than merge: the entries the
profile's own tiers hold are cleared before the rebuild, because an upsert keyed by entry
id leaves a renamed group, a dropped dimension, and a de-annotated member searchable
forever. The clearing SHALL be scoped to the tiers a profile writes; step outputs,
summaries, and syntheses SHALL be untouched.

Embedding and upsert SHALL be batched. The embedding and vector-store interfaces accept
arrays, and issuing one request per entry makes indexing cost scale as a network round
trip per entry.

#### Scenario: Three tiers are written

- **WHEN** the body indexes a resolved profile with groups, dimensions, and member annotations
- **THEN** it SHALL write group entries, dimension entries, and one entry per annotated member
- **AND** SHALL NOT write entries for unannotated members

#### Scenario: A renamed group leaves no stale entry

- **GIVEN** an indexed profile
- **WHEN** the analysis is re-profiled and a group's name changes
- **THEN** the index SHALL hold the new group's entry and not the old one
- **AND** the step-output, summary, and synthesis entries SHALL remain

#### Scenario: Existing input searches keep working

- **WHEN** a consumer searches the vector store filtered to `type: "input"`
- **THEN** it SHALL match the annotated members of a profile written under this requirement

#### Scenario: Indexing does not scale as a round trip per entry

- **WHEN** the body indexes the profile
- **THEN** it SHALL issue batched embedding requests rather than one request per entry

#### Scenario: Authorization revoked on failure

- **WHEN** the body throws after the run is authorized
- **THEN** it marks the profile failed and revokes the run authorization

#### Scenario: A revoke failure does not change a completed profile

- **GIVEN** a `RunAuthorizer` whose `revoke` gives an `err`
- **WHEN** the body completes a profile
- **THEN** the profile row stays `completed`, and the body emits `Profile complete` and no `failed` activity
- **AND** the body logs the reason of the `err` at the error level

## ADDED Requirements

### Requirement: A host stops the profile

The harness MUST export `stopDataProfile(deps, analysisId, workflowId)` and `DATA_PROFILE_STOPPED`, the error text `"Data profiling was stopped"`. The stop MUST end the profile workflow when it runs and when it waits in a pause. It MUST cancel the workflow, delete the rows of its pauses, and fail the profile row with the error `DATA_PROFILE_STOPPED`. The write MUST change only a `running` row. The stop MUST send the settled notice only when the write changed the row.

#### Scenario: A stop ends a paused profile

- **GIVEN** a profile whose spawn waits in `paused`
- **WHEN** a host stops the profile
- **THEN** the status of the profile workflow is `CANCELLED`
- **AND** the profile row is `failed` with the error `DATA_PROFILE_STOPPED`
- **AND** no row of a pause of the profile is left, and the active work of the analysis is empty
- **AND** the body revokes the run authorization with the reason `data-profile-stopped`

#### Scenario: A profile that settled first keeps its status

- **GIVEN** a profile row that is `completed`
- **WHEN** `stopDataProfile` runs for its workflow
- **THEN** the profile row stays `completed`, and no settled notice goes out

### Requirement: The body passes the cancel of a stop through

The body MUST pass the cancel of its workflow through its failure path, and it MUST NOT write the profile row for the cancel. The revoke of the run authorization and the teardown of the sandbox MUST stay in the body, which runs them on its way out, because only the body holds the run session. A retry of the profile can start from the `failed` row.

#### Scenario: A stopped profile can start again

- **GIVEN** a profile that a host stopped
- **WHEN** the embedder retries the profile
- **THEN** the retry claims the `failed` row, and a new profile workflow starts
