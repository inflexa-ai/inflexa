## REMOVED Requirements

### Requirement: runEphemeral is a turn-scoped workflow

**Reason**: Ephemeral execution is promoted to a first-class, fire-and-forget adhoc run that recovers like any durable run. The turn-scoped model — inline await, cancel on disconnect, and the boot-time cancellation of `ephemeral:`-prefixed workflows — is retired along with the `run_ephemeral` tool and `RunLauncher.launchAndAwait`.

**Migration**: Callers use `run_adhoc`, which launches via `RunLauncher.launch` and is inspected later via `inspect_run` (see the `adhoc-run` capability). The `ephemeral:` workflow-id prefix and its pre-recovery sweep are deleted; adhoc workflows are reclaimed by the normal executor-identity recovery path.

## ADDED Requirements

### Requirement: runAdhoc is a fire-and-forget durable run

`runAdhoc` SHALL run as a real DBOS workflow started by the `run_adhoc` tool through `RunLauncher.launch` with `workflowId = runId`. It SHALL NOT be turn-scoped: the tool SHALL NOT await it inline, and a chat disconnect SHALL NOT cancel it. `runAdhoc` SHALL be recoverable like any durable run — a process that relaunches under the same `executorID` reclaims a pending `runAdhoc` workflow through the standard recovery path, with no special workflow-id prefix and no pre-recovery sweep.

#### Scenario: An adhoc run survives chat disconnect

- **GIVEN** a `run_adhoc` call that has returned `{ runId }`
- **WHEN** the chat turn ends or the client disconnects
- **THEN** the `runAdhoc` workflow keeps executing and its progress remains visible through the run/step ledger rows

#### Scenario: A recovered process reclaims a pending adhoc run

- **GIVEN** a `PENDING` `runAdhoc` workflow left by a crashed process under `executorID = "core-worker-0"`
- **WHEN** a new process launches under the same `executorID`
- **THEN** DBOS reclaims and resumes it through the standard recovery path — it is neither swept nor cancelled

## MODIFIED Requirements

### Requirement: Capability seams isolate core from managed realizations

Core SHALL declare its external capabilities as injected seams and ship trivial
local realizations, so it runs with filesystem/no-op defaults and no
hosted-service dependency. The five external seams SHALL be `RunAuthorizer`
(the sole constructor of a `RunSession`; OSS `createLocalRunAuthorizer`),
`ResolveBilling` (attribution headers at the wire call; OSS noop returns `{}`),
`ArtifactRegistry` (post-step recording; OSS `createNoopArtifactRegistry` —
registers nothing externally and reports zero failures, because the local
`cortex_artifacts` ledger is written by the harness itself around the seam and
an embedder without an external provenance system has nothing to register),
`RunCharge` (run-level billing bracket; OSS `createNoopRunCharge`), and
`PreviewPublisher` (report preview URLs; OSS `UnavailablePreviewPublisher`). The
shared `RunLauncher` seam (single realization `createDbosRunLauncher`) SHALL be
the only way tools start durable runs. Core SHALL NOT branch on which realization
is bound.

#### Scenario: An embedder swaps a seam without touching core

- **GIVEN** an embedder that wires a cloud `ArtifactRegistry` at the composition root
- **WHEN** a workflow records artifacts through the seam
- **THEN** core calls the same interface and never inspects which realization is bound

#### Scenario: Tools reach the durability engine only through RunLauncher

- **GIVEN** the `execute_plan` and `run_adhoc` tools
- **WHEN** they start a durable run
- **THEN** they call `RunLauncher.launch` and never import the DBOS engine directly

#### Scenario: The OSS ArtifactRegistry realization never fails a registration

- **GIVEN** a runtime assembled with `createNoopArtifactRegistry`
- **WHEN** a step registers its artifacts through the seam
- **THEN** `register` returns `{ registered: [], failed: [], failedCount: 0 }` and `sync` resolves without effect, so the post-step fail-fast gate never trips on the local default
