## MODIFIED Requirements

### Requirement: SandboxClient exposes seven backend-selected operations

The harness MUST expose a `SandboxClient` interface with exactly seven
operations: `createSandbox(session, spec, identity) → ResultAsync<SandboxRef, SandboxError>`, `submitExec(ref, body)
→ void`, `awaitExec(ref, execId, emit, deadline) → ExecResult`,
`isAlive(ref) → boolean`, `teardown(ref) → void`, `teardownById(sandboxId) →
void`, and `listManagedSandboxes() → ManagedSandbox[]`. `awaitExec` takes the
whole `ref` — not merely the `callbackSecret` it verifies with — because a quiet
topic makes it pull the result from the sandbox directly. A `createSandboxClient()`
factory SHALL select the Docker (dev) or K8s (prod) implementation based on the
`SANDBOX_BACKEND` value. The client SHALL be injected at the composition root as
a construction-time dependency; callers SHALL NOT import a backend
implementation directly, and the interface SHALL NOT leak backend-specific types.

`createSandbox` MUST take the `SpawnSession` of the work, a `RunSession` whose
`runFrame.stepId` is present. Thus a spawn without a session does not compile. The client MUST
read the analysis id from `session.scope.analysisId`, the run id from `session.runFrame.runId`,
and the step id from `session.runFrame.stepId`. `SandboxSpec` holds the other fields of the
spawn: `childWorkflowId`, `image`, `extraEnv`, `resources`, `readOnly`, `writableTail`, and
`execId`. `SandboxSpec` carries no label, because the client gets the host labels from its
label hook (see the sandbox-labels spec).

`createSandbox` MUST give each `SandboxError` as an `err` value, and it MUST NOT throw it. Thus
the caller reads a refusal that asks for a suspension with no `catch`. A caller that must fail
its DBOS step throws the error through `unwrapOrThrow`.

#### Scenario: A failed spawn is a value

- **GIVEN** a spawn that the backend refuses
- **WHEN** a caller runs `createSandbox(session, spec, identity)`
- **THEN** the result is an `err` that carries the `SandboxError` variant
- **AND** the client throws nothing

#### Scenario: Docker backend selected in dev

- **GIVEN** `SANDBOX_BACKEND=docker`
- **WHEN** `createSandboxClient()` is called
- **THEN** the returned client SHALL be the Docker implementation
- **AND** `createSandbox` SHALL launch a `sandbox-base` container with its exec port published to `127.0.0.1` only

#### Scenario: K8s backend selected in prod

- **GIVEN** `SANDBOX_BACKEND=k8s`
- **WHEN** `createSandboxClient()` is called
- **THEN** the returned client SHALL be the K8s implementation
- **AND** `createSandbox` SHALL create a K8s Job whose pod runs `sandbox-base`

#### Scenario: Interface surface is the seven operations

- **WHEN** a consumer imports `SandboxClient`
- **THEN** the type SHALL expose exactly `createSandbox`, `submitExec`, `awaitExec`, `isAlive`, `teardown`, `teardownById`, and `listManagedSandboxes`
- **AND** SHALL NOT leak backend-specific types (Docker `Container`, K8s `Pod`)

#### Scenario: A spawn takes its ids from the session

- **GIVEN** a `SpawnSession` for the analysis `an-1`, the run `run-1`, and the step `step-a`
- **WHEN** a caller runs `createSandbox(session, spec, identity)`
- **THEN** the sandbox holds the step directory of `an-1`, `run-1`, and `step-a` as its writable mount
- **AND** the active-sandbox registry records the sandbox under `run-1` and `step-a`

#### Scenario: A session with no step id does not compile

- **GIVEN** a `RunSession` whose `runFrame` has no `stepId`
- **WHEN** a caller gives that session to `createSandbox`
- **THEN** the typecheck fails
