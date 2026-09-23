## MODIFIED Requirements

### Requirement: Registration through the ArtifactRegistry seam

`registerStepArtifacts(db, registry, input, session)` SHALL: (1) build the
`cortex_artifacts` rows from the reconciled manifest — `role = 'step_output'`,
`path` prefixed `runs/{runId}/{stepId}/`, `file_type` from the entry's inferred
type — and upsert them; (2) call the injected `ArtifactRegistry.register(input,
session)`; (3) write each returned external id back via `updateArtifactId` for
paths the local upsert owns. If `register` gives `ok`, `registerStepArtifacts` MUST return
`{ localCount, externalRegistered, externalFailed, failureDetails }` as an `ok` value. When the artifacts array is
empty it SHALL return all-zero counts immediately and SHALL NOT call the registry.

`ArtifactRegistry.register` MUST be a gate, as the host-hooks capability describes. It MUST return
`ResultAsync<ExternalRegistrationResult, GateFailure>`, and it MUST give a failure as an `err`, never as a throw. A
partial outcome MUST be an `ok` value, not an `err`. If `register` gives an `err`, `registerStepArtifacts` MUST write
no external id, and it MUST return that refusal as an `err` of the variant `refused`. The upserted rows stay in the
ledger with `artifact_id = NULL`. The step then records the failure with the reason of the host.

If a write of the local ledger fails, `registerStepArtifacts` MUST stop at that write. It MUST return the `DbError` as
an `err` of the variant `ledger_failed`, and it MUST NOT throw. The step then fails the same as for a refusal that does
not suspend.

The registry's outcome is partial by contract — it commits per leaf and per
activity, with no batch-wide rollback — so `registered` and `failed` arriving
together describes a normal registration. `failed`, surfaced as
`failureDetails`, and `failedCount`, surfaced as `externalFailed`, SHALL both
describe only the **terminal** rejections: a rejected artifact whose bytes exist
nowhere but the step tree, and any rejection cascaded from one — a row the
registry rejected as a consequence of a genuine failure. A rejection of a file
that no activity in the payload references SHALL NOT appear in either, because
it registers nothing and so puts no bytes at risk. The two move together so that
the fail-fast message lists exactly the paths that cost the step something: a
`failed` array padded with harmless rejections would name them, during an
incident, in the same breath and the same format as the real ones.

A rejection the registry excludes SHALL still be reported, in `notCounted`, and
`registerStepArtifacts` SHALL log a warn record naming each such path and the
registry's reason for it. Excluding a rejection decides only that it is not
worth failing a step over; it is never licence to drop it silently, because that
record is the only place a reader can check the verdict against what the
external system actually said. The log SHALL be emitted by
`registerStepArtifacts` rather than left to the registry: the seam is
implementable by an embedder, and a rejection does not get to go unrecorded
because one implementation chose not to log it.

#### Scenario: Successful registration

- **WHEN** `registerStepArtifacts` is called with 3 reconciled artifacts
- **THEN** 3 rows are upserted into `cortex_artifacts`, the registry's `register` is called, returned external ids are stored via `updateArtifactId`, and the result is `{ localCount: 3, externalRegistered: 3, externalFailed: 0, failureDetails: [] }`

#### Scenario: External registration partially fails

- **WHEN** the registry returns some of the step's outputs in `failed`
- **THEN** accepted artifacts get their `artifact_id` stored, rejected ones retain `artifact_id = NULL`, and `externalFailed` reflects the count of terminal rejections

#### Scenario: A rejection that nothing references is surfaced, not counted

- **WHEN** the registry accepts every row except a file that no activity in the payload references
- **THEN** `notCounted` carries that path with the registry's reason, a warn record names the path and that reason, and both `externalFailed` and `failureDetails` are empty

#### Scenario: Empty artifact list short-circuits

- **WHEN** `registerStepArtifacts` is called with an empty artifacts array
- **THEN** it returns `{ localCount: 0, externalRegistered: 0, externalFailed: 0, failureDetails: [] }` and the registry is NOT called

#### Scenario: A register err fails the registration

- **GIVEN** a registry whose `register` gives `errAsync({ reason: "r", suspend: false })`
- **WHEN** the harness calls `registerStepArtifacts` with 3 reconciled artifacts
- **THEN** `cortex_artifacts` holds 3 rows with `artifact_id = NULL`
- **AND** `registerStepArtifacts` returns an `err` of the variant `refused` that carries the reason `r`, and it does not throw

#### Scenario: A failed ledger write fails the registration

- **GIVEN** a ledger connection whose write fails
- **WHEN** the harness calls `registerStepArtifacts` with 3 reconciled artifacts
- **THEN** `registerStepArtifacts` returns an `err` of the variant `ledger_failed` that carries the `DbError` of the upsert, and it does not throw

## ADDED Requirements

### Requirement: The artifact ledger helpers give a Result

`src/state/artifacts.ts` MUST export these helpers. Each helper takes a `Querier` first and returns
`ResultAsync<…, DbError>`:

- `upsertArtifact(pool, entry)` and `upsertArtifacts(pool, entries)`: the upserts of the artifact upsert semantics requirement.
- `queryInputArtifacts(pool, analysisId, paths)`: the `input` rows at the paths.
- `queryUnsyncedStepArtifacts(pool, resourceId, runId, stepId)`: the rows of the optional external sync tracking requirement.
- `queryStepArtifactPaths(pool, resourceId, runId, stepId, limit)`: the step outputs of a step, most consequential first.
- `queryAnalysisArtifacts(pool, analysisId)`: each artifact of an analysis, ordered by path.
- `countArtifactsForRun(pool, analysisId, runId)`: the count of the step outputs of a run.
- `updateArtifactId(pool, resourceId, path, artifactId, fileType?)` and `updateFileIds(pool, pairs)`: the sync writes.

A driver failure MUST be an `err`, never a throw. Absence rides the `ok` channel as `[]` or `0`. A workflow body or a
step body changes an `err` into a throw with `unwrapOrThrow`. Each other caller keeps the Result.

#### Scenario: A driver failure is an err

- **GIVEN** a `Querier` whose query rejects
- **WHEN** the harness calls `upsertArtifacts`
- **THEN** it gives an `err` with the `op` `artifacts.upsertArtifacts`, and it does not throw

#### Scenario: No matching row is an empty ok

- **WHEN** the harness calls `queryInputArtifacts` with paths that no `input` row holds
- **THEN** it gives `ok([])`
