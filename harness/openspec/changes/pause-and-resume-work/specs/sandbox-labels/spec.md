## MODIFIED Requirements

### Requirement: The sandbox client resolves the host labels at each spawn

`CreateSandboxClientConfig` MUST take an optional hook `resolveSandboxLabels`, of the type
`(session: RunSession) => ResultAsync<SandboxLabels, GateFailure>`. `SandboxLabels` is
`Readonly<Record<string, string>>`. The hook is a gate, as the host-hooks spec defines it.
If the hook is absent, the sandbox MUST carry no host labels.

The client MUST call the hook in `createSandbox`, with the session of that call. The client
MUST call the hook before it makes the step tree and before it calls a backend. The harness
calls the hook at no other place. Thus each spawn path gets the host labels on both backends,
and no spawn path has label code of its own.

If the hook gives an `err`, the client MUST refuse the spawn with the `SandboxError` variant
`labels_refused`. The variant MUST carry the reason and the suspend flag of the `GateFailure`.
The client MUST NOT make the step tree, and it MUST NOT call a backend. `createSandbox` MUST
give the refusal as an `err` value, the same as each other `SandboxError` of the client seam. If
the suspend flag is true, a caller inside a workflow pauses the work (see the work-pause spec).

#### Scenario: A spawn path with no label code gets the host labels

- **GIVEN** a sandbox client whose hook gives `{ "example.com/tenant": "acme" }`
- **WHEN** the derivation of `derive_table` makes a sandbox
- **THEN** the sandbox carries the label `example.com/tenant=acme`

#### Scenario: The hook gets the session of the spawn

- **GIVEN** a `SpawnSession` for the analysis `an-1`, the run `run-1`, and the step `step-a`
- **WHEN** a caller runs `createSandbox(session, spec, identity)`
- **THEN** the client calls `resolveSandboxLabels` with that session
- **AND** the client calls the hook before it makes the step tree

#### Scenario: An absent hook stamps no host label

- **GIVEN** a sandbox client with no `resolveSandboxLabels`
- **WHEN** the client makes a sandbox
- **THEN** the sandbox carries the harness labels and no host label

#### Scenario: A refused spawn makes no machine

- **GIVEN** a hook that gives `err({ reason: "no_funds", suspend: true })`
- **WHEN** a caller runs `createSandbox(session, spec, identity)`
- **THEN** `createSandbox` gives an `err` whose variant is `labels_refused`
- **AND** the variant carries the reason `no_funds` and the suspend flag `true`
- **AND** the client makes no step tree and calls no backend
