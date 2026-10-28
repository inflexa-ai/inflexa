## MODIFIED Requirements

### Requirement: Capability seams isolate core from managed realizations

Core SHALL declare its external capabilities as injected seams and ship trivial
local realizations, so it runs with filesystem/no-op defaults and no
hosted-service dependency. The external seams MUST be these:

- `RunAuthorizer`: the only constructor of a `RunSession`. `authorize` and `renew` are gates. `revoke`,
  `revokeByMandateId`, and `suspend` are notices. The OSS realization is `createLocalRunAuthorizer`.
- `ArtifactRegistry`: the post-step record of the artifacts of a step. `register` is a gate, and `sync` is a notice.
  The OSS realization `createNoopArtifactRegistry` registers nothing outside the harness, and it reports zero
  failures. The harness itself writes the local `cortex_artifacts` ledger around the seam. An embedder without an
  external provenance system has nothing to register.
- `RunCharge`: the run-level billing bracket. `open` is a gate, and `close` is a notice. The OSS realization is
  `createNoopRunCharge`.
- `UsageRecorder`: it gets one usage record for each completed LLM call. `record` is a notice. The OSS realization is
  `createNoopUsageRecorder`.

The embedder can also give two optional hooks to the components that use their values:

- `resolveRequestHeaders` is a gate on each model provider. The provider adds the headers that the hook gives to each
  model request, and it does not read them (see the host-hooks spec).
- `resolveSandboxLabels` is a gate on the configuration of the sandbox client. The client calls it at each spawn, on
  the Docker backend and on the K8s backend (see the sandbox-labels spec).

Each hook MUST be a gate or a notice, and its type MUST show its kind (see the host-hooks spec). If an optional hook is
absent, the provider adds no headers, and the sandbox has no host labels. The harness has no `ResolveBilling` seam, and
it exports no `createNoopBillingResolver`. The shared `RunLauncher` seam (single realization `createDbosRunLauncher`)
SHALL be the only way tools start durable runs. Core SHALL NOT branch on which realization is bound.

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
- **THEN** `register` gives `ok({ registered: [], failed: [], failedCount: 0 })`, and `sync` gives `ok` with no effect
- **AND** the local default never fails a step

#### Scenario: A runtime without the optional hooks adds no host values

- **GIVEN** a runtime whose providers have no `resolveRequestHeaders` and whose sandbox client has no `resolveSandboxLabels`
- **WHEN** a step sends a model request and spawns a sandbox
- **THEN** the model request carries no host headers, and the sandbox carries only the harness labels

#### Scenario: The harness exports no billing resolver

- **WHEN** an embedder imports the public exports of `@inflexa-ai/harness`
- **THEN** the exports hold no `ResolveBilling` and no `createNoopBillingResolver`
