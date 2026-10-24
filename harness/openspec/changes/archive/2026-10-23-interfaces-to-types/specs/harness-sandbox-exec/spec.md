## MODIFIED Requirements

### Requirement: SandboxClient exposes seven backend-selected operations

The harness MUST expose a `SandboxClient` type with exactly seven
operations: `createSandbox(session, spec, identity) → ResultAsync<SandboxRef, SandboxError>`,
`exec(ref, request, emit, deadline) → ExecResult`, `isAlive(ref) → SandboxLiveness`,
`isAliveById(sandboxId) → SandboxLiveness`, `teardown(ref) → void`,
`teardownById(sandboxId) → void`, and `listManagedSandboxes() → ManagedSandbox[]`.
A `createSandboxClient()` factory MUST select the Docker (dev) or K8s (prod)
implementation from the `SANDBOX_BACKEND` value. The client MUST be injected at
the composition root as a construction-time dependency. A caller MUST NOT import
a backend implementation directly, and the client type MUST NOT leak a
backend-specific type.

`createSandbox` MUST take the `SpawnSession` of the work, a `RunSession` whose
`runFrame.stepId` is present. Thus a spawn without a session does not compile. The client MUST
read the analysis id from `session.scope.analysisId`, the run id from `session.runFrame.runId`,
and the step id from `session.runFrame.stepId`. `SandboxSpec` holds the other fields of the
spawn: `childWorkflowId`, `image`, `extraEnv`, `resources`, `readOnly`, and `writableTail`.
`SandboxSpec` carries no label, because the client gets the host labels from its
label hook (see the sandbox-labels spec). `SandboxSpec` carries no exec id.

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
- **THEN** the returned client is the Docker implementation
- **AND** `createSandbox` launches a `sandbox-base` container with its exec port published to `127.0.0.1` only

#### Scenario: K8s backend selected in prod

- **GIVEN** `SANDBOX_BACKEND=k8s`
- **WHEN** `createSandboxClient()` is called
- **THEN** the returned client is the K8s implementation
- **AND** `createSandbox` makes a K8s Job whose pod runs `sandbox-base`

#### Scenario: Interface surface is the seven operations

- **WHEN** a consumer imports `SandboxClient`
- **THEN** the type exposes exactly `createSandbox`, `exec`, `isAlive`, `isAliveById`, `teardown`, `teardownById`, and `listManagedSandboxes`
- **AND** it does not leak a backend-specific type (Docker `Container`, K8s `Pod`)

#### Scenario: A spawn takes its ids from the session

- **GIVEN** a `SpawnSession` for the analysis `an-1`, the run `run-1`, and the step `step-a`
- **WHEN** a caller runs `createSandbox(session, spec, identity)`
- **THEN** the sandbox holds the step directory of `an-1`, `run-1`, and `step-a` as its writable mount
- **AND** the active-sandbox registry records the sandbox under `run-1` and `step-a`

#### Scenario: A session with no step id does not compile

- **GIVEN** a `RunSession` whose `runFrame` has no `stepId`
- **WHEN** a caller gives that session to `createSandbox`
- **THEN** the typecheck fails
