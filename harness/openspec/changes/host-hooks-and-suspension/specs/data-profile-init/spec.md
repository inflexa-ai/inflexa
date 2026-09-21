## ADDED Requirements

### Requirement: The profile trigger authorizes the run through a gate

`triggerDataProfile` and `runDataProfile` MUST authorize the profile run through
`RunAuthorizer.authorize` before they start the workflow. `authorize` is a gate
(see the `host-hooks` capability). It gives a refusal as an `err` value, and it
never throws. If `authorize` gives an `err`, the trigger MUST NOT start the
workflow. The trigger MUST set the claimed profile row to `failed`, with the reason
of the host as the failure reason. Thus the row does not stay `running`.

If the `err` has `suspend: true`, the trigger MUST also mark the analysis as
suspended through the one function of the `workflow-suspension` capability. No
workflow exists yet, thus the trigger has no workflow to cancel.

#### Scenario: A refused authorization starts no profile workflow

- **GIVEN** a `RunAuthorizer` whose `authorize` gives an `err` with `suspend: false`
- **WHEN** `triggerDataProfile` claims the profile row
- **THEN** no data-profile workflow starts, and the profile row reaches `failed` with the reason of the host
- **AND** the analysis status does not change

#### Scenario: A refused authorization with a suspension marks the analysis

- **GIVEN** a `RunAuthorizer` whose `authorize` gives an `err` with `suspend: true`
- **WHEN** `triggerDataProfile` claims the profile row
- **THEN** no data-profile workflow starts, and the profile row reaches `failed` with the reason of the host
- **AND** the trigger marks the analysis as suspended

### Requirement: A suspension cancels the profile workflow and marks the analysis

A suspension of the data-profile body MUST obey the rules for a durable owner in
the `workflow-suspension` capability. The workflow is a durable owner, because its
result goes to stored state, the profile ledger. The `workflow-suspension`
capability also gives the causes of a suspension and the reason that the harness
carries. The body MUST NOT read the reason.

When the body suspends, it MUST do these steps:

- Set the profile row to `failed`, with the reason of the host as the failure reason. The profile ledger has no suspended state, and the retry path can take a `failed` row again.
- Revoke the run authorization.
- Mark the analysis as suspended through the one function of the `workflow-suspension` capability.
- Emit the terminal `failed` activity with the same reason.

The body MUST then end the workflow in the DBOS state `CANCELLED`, not `ERROR`. A
failure that does not suspend takes the failure path of the profile. On that path,
the body does not mark the analysis.

#### Scenario: A suspend error from the profiler model suspends the profile

- **GIVEN** a model request of the profiler agent that fails with a provider error of kind `suspend` and the reason `"budget_exceeded"`
- **WHEN** the body gets the error
- **THEN** the profile row reaches `failed` with the reason `"budget_exceeded"`, and the body emits the terminal `failed` activity with that reason
- **AND** the body revokes the run authorization and marks the analysis as suspended
- **AND** the workflow ends in the DBOS state `CANCELLED`

#### Scenario: A refused spawn with a suspension suspends the profile

- **GIVEN** a `resolveSandboxLabels` hook that gives an `err` with `suspend: true`
- **WHEN** the body spawns the profiler sandbox
- **THEN** no sandbox starts, and the body suspends the profile with the reason of the host

#### Scenario: A failure without a suspension does not mark the analysis

- **GIVEN** a `resolveSandboxLabels` hook that gives an `err` with `suspend: false`
- **WHEN** the body spawns the profiler sandbox
- **THEN** no sandbox starts, and the profile row reaches `failed` with the reason of the host
- **AND** the body does not mark the analysis as suspended, and the workflow does not end in `CANCELLED`

## MODIFIED Requirements

### Requirement: Profile outputs are registered, indexed, and snapshotted

On success the body SHALL register each staged file as a `role: "input"` artifact at
`data/{relativePath}`, index the profile into the analysis vector store, and store a
result snapshot in the `data_profile_status` ledger via `completeDataProfile`. The
profiler's scratch scripts SHALL be confined to `runs/data-profile/profile`.

The body MUST revoke the run authorization on each terminal path: success, no-op,
failure, and suspension. `RunAuthorizer.revoke` is a notice (see the `host-hooks`
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
