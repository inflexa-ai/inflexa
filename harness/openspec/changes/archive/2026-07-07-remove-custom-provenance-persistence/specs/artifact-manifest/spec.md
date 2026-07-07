# artifact-manifest — delta

## MODIFIED Requirements

### Requirement: Integrity stages fail-fast; enrichment stages degrade

`reconcileAndRegisterStepArtifacts` SHALL reconcile, then register, then
`ArtifactRegistry.sync` the step's artifacts, and SHALL treat the whole sequence
as fail-fast: a non-zero `externalFailed` SHALL throw with the
per-file failure detail, and the sandbox-step body SHALL tear down the sandbox,
mark the step failed, and re-raise so the parent's fail-fast cascade fires. The
OSS `createNoopArtifactRegistry` returns `externalFailed: 0` and never trips
this. The enrichment stages — file-metadata generation, step-summary generation,
and vector indexing — SHALL run under `safeRun`/`safeRunValue` so any single
failure degrades without failing the step.

#### Scenario: Registry rejection fails the step

- **WHEN** `reconcileAndRegisterStepArtifacts` gets `externalFailed > 0` from registration
- **THEN** it throws with the per-file detail and the step is marked failed

#### Scenario: A degraded enrichment stage does not fail the step

- **WHEN** vector indexing throws while indexing a step's outputs
- **THEN** the failure is logged and swallowed and the step still completes

### Requirement: Optional external sync tracking

`cortex_artifacts` SHALL track external sync state via `artifact_id` (set after
external registration by `updateArtifactId`) and `file_id` (set when an adapter
reports an external file identity, applied in batch by `updateFileIds`). A
registry realization with no external system (the OSS noop) MAY leave both null
because the bytes already live in the local session tree.
`queryUnsyncedStepArtifacts(pool, resourceId, runId, stepId)` SHALL return
step-output rows where `artifact_id IS NOT NULL AND file_id IS NULL`, ordered by
`created_at`.

#### Scenario: Query step artifacts awaiting byte sync

- **WHEN** `queryUnsyncedStepArtifacts(pool, resourceId, runId, stepId)` is called
- **THEN** it returns rows with `artifact_id IS NOT NULL AND file_id IS NULL AND role = 'step_output'`, ordered by `created_at`

#### Scenario: External sync lifecycle

- **WHEN** an artifact is first upserted
- **THEN** `artifact_id` and `file_id` are both NULL
- **WHEN** external registration succeeds
- **THEN** `artifact_id` is set via `updateArtifactId`
- **WHEN** an adapter reports an external file identity
- **THEN** `file_id` is set via `updateFileIds`
