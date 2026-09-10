## MODIFIED Requirements

### Requirement: Capability seams isolate core from managed realizations

Core SHALL declare its external capabilities as injected seams and ship trivial
local realizations, so it runs with filesystem/no-op defaults and no
hosted-service dependency. The four external seams SHALL be `RunAuthorizer`
(the sole constructor of a `RunSession`; OSS `createLocalRunAuthorizer`),
`ResolveBilling` (attribution headers at the wire call; OSS noop returns `{}`),
`ArtifactRegistry` (post-step recording; OSS `createNoopArtifactRegistry` —
registers nothing externally and reports zero failures, because the local
`cortex_artifacts` ledger is written by the harness itself around the seam and
an embedder without an external provenance system has nothing to register),
and `RunCharge` (run-level billing bracket; OSS `createNoopRunCharge`). The
shared `RunLauncher` seam (single realization `createDbosRunLauncher`) SHALL be
the only way tools start durable runs. Core SHALL NOT branch on which realization
is bound.

#### Scenario: An embedder swaps a seam without touching core

- **GIVEN** an embedder that wires a cloud `ArtifactRegistry` at the composition root
- **WHEN** a workflow records artifacts through the seam
- **THEN** core calls the same interface and never inspects which realization is bound

#### Scenario: Tools reach the durability engine only through RunLauncher

- **GIVEN** the `execute_analysis` tool
- **WHEN** it starts a durable run
- **THEN** it calls `RunLauncher.launch` and never imports the DBOS engine directly

#### Scenario: The OSS ArtifactRegistry realization never fails a registration

- **GIVEN** a runtime assembled with `createNoopArtifactRegistry`
- **WHEN** a step registers its artifacts through the seam
- **THEN** `register` returns `{ registered: [], failed: [], failedCount: 0 }` and `sync` resolves without effect, so the post-step fail-fast gate never trips on the local default
