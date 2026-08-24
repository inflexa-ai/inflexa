## MODIFIED Requirements

### Requirement: Registration through the ArtifactRegistry seam

`registerStepArtifacts(db, registry, input, session)` SHALL: (1) build the
`cortex_artifacts` rows from the reconciled manifest — `role = 'step_output'`,
`path` prefixed `runs/{runId}/{stepId}/`, `file_type` from the entry's inferred
type — and upsert them; (2) call the injected `ArtifactRegistry.register(input,
session)`; (3) write each returned external id back via `updateArtifactId` for
paths the local upsert owns. It SHALL return `{ localCount, externalRegistered,
externalFailed, failureDetails }`. When the artifacts array is empty it SHALL
return all-zero counts immediately and SHALL NOT call the registry.

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

### Requirement: Integrity stages fail-fast; enrichment stages degrade

`reconcileAndRegisterStepArtifacts` SHALL reconcile, then register, and the
sandbox-step body SHALL then `ArtifactRegistry.sync` the step's artifacts. The
sequence is fail-fast: a non-zero `externalFailed` SHALL throw with the per-file
failure detail, and the sandbox-step body SHALL tear down the sandbox, mark the
step failed, and re-raise so the parent's fail-fast cascade fires.

Byte sync SHALL be attempted whatever registration returned, including when
registration threw. Sync is defined over the rows registration accepted
(`artifact_id IS NOT NULL AND file_id IS NULL`), so attempting it after a throw
uploads exactly those rows and reaches nothing that was rejected — whereas
skipping it leaves every accepted artifact registered and never uploaded,
orphaned by the very throw raised to prevent orphaning. A registration error
SHALL remain the surfaced cause: a sync failure that follows one SHALL be logged
with its own detail and SHALL NOT replace the registration error the step fails
on. The OSS `createNoopArtifactRegistry` returns `externalFailed: 0` and never
trips this.

The enrichment stages — file-metadata generation, step-summary generation, and
vector indexing — SHALL run under `safeRun`/`safeRunValue` so any single failure
degrades without failing the step.

Within the vector-index stage, degradation SHALL be per-item: each surviving
file description and the step summary SHALL be embedded and upserted under its
own failure boundary, so one rejected input costs only its own index entry and
every remaining item is still attempted. Index setup (ensuring the search index
exists and constructing the store) SHALL remain all-or-nothing — a setup failure
degrades the whole stage. Each per-item failure SHALL be logged with the item's
id and input text length, and when at least one item fails the stage SHALL log a
summary carrying the counts of items indexed and items failed — a partial index
returns fewer search hits rather than an error, so the logged counts are the
only signal that degradation occurred.

#### Scenario: An output rejection fails the step

- **WHEN** `reconcileAndRegisterStepArtifacts` gets `externalFailed > 0` from registration
- **THEN** it throws with the per-file detail and the step is marked failed

#### Scenario: A rejection that orphans nothing does not fail the step

- **GIVEN** a step whose outputs all registered and whose only rejection is a file no activity references
- **WHEN** `reconcileAndRegisterStepArtifacts` runs
- **THEN** `externalFailed` is `0`, the rejection is logged with its path and reason, and the step completes with its artifacts synced

#### Scenario: Registered bytes sync even when registration throws

- **GIVEN** registration that accepted most of the step's artifacts and threw on a rejected output
- **WHEN** the sandbox-step body handles the throw
- **THEN** `ArtifactRegistry.sync` is still attempted, the accepted rows are uploaded, and the step fails with the registration error as its cause

#### Scenario: A degraded enrichment stage does not fail the step

- **WHEN** vector indexing throws while indexing a step's outputs
- **THEN** the failure is logged and swallowed and the step still completes

#### Scenario: One rejected input costs only its own entry

- **WHEN** embedding one file description fails while the step has other file descriptions and a summary
- **THEN** every other file description and the summary are still embedded and upserted, and the step completes

#### Scenario: Partial indexing is observable in the logs

- **WHEN** at least one item fails to index while others succeed
- **THEN** each failed item is logged with its id and text length, and a summary log reports the indexed and failed counts

#### Scenario: Index setup failure degrades the whole stage

- **WHEN** ensuring the search index exists fails before any item is indexed
- **THEN** the stage logs the failure and indexes nothing, and the step still completes
