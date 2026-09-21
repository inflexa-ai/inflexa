# sandbox-labels Specification

## Purpose

Define the labels of a sandbox. The sandbox client stamps the harness labels and the labels of the host at
each spawn, on the Docker backend and on the K8s backend. The client takes the ids of the labels from the session
of the spawn, and it stamps each host value as the host gives it.

## Requirements

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
the suspend flag is true, the caller suspends the work (see the workflow-suspension spec).

#### Scenario: A spawn path with no label code gets the host labels

- **GIVEN** a sandbox client whose hook gives `{ "example.com/tenant": "acme" }`
- **WHEN** `derive-table-exec` makes a sandbox
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

### Requirement: Each sandbox carries the harness label set on both backends

Each sandbox MUST carry the harness labels in this table, on the Docker backend and on the K8s
backend:

| Key | Value |
|-|-|
| `app.kubernetes.io/managed-by` | `cortex` |
| `role` | `sandbox` |
| `cortex/sandbox-id` | the sandbox id |
| `cortex/analysis-id` | `session.scope.analysisId` |
| `cortex/run-id` | `session.runFrame.runId` |
| `cortex/step-id` | `session.runFrame.stepId` |

On Docker, the container MUST carry the labels. On K8s, the Job metadata and the pod template
metadata MUST both carry the labels. A cost reconciler of a host reads the labels of a pod. Thus
a label on the Job only is not visible to that reconciler.

The owner workflow id (`spec.childWorkflowId`) MUST be the label `cortex/owner-workflow-id` on
Docker. On K8s, the owner workflow id MUST be the Job annotation `cortex/owner-workflow-id`. A
DBOS workflow id can be longer than 63 characters, and it can hold `:`. Thus it is not a valid
K8s label value, but an annotation holds it with no change.

#### Scenario: A Docker container carries the label set

- **GIVEN** a `SpawnSession` for the analysis `an-1`, the run `run-1`, and the step `step-a`, and the sandbox id `sbx-run1-0a1b2c3d`
- **WHEN** the Docker backend makes the container
- **THEN** the container carries `app.kubernetes.io/managed-by=cortex`, `role=sandbox`, `cortex/sandbox-id=sbx-run1-0a1b2c3d`, `cortex/analysis-id=an-1`, `cortex/run-id=run-1`, and `cortex/step-id=step-a`
- **AND** the container carries the label `cortex/owner-workflow-id` with the value of `spec.childWorkflowId`

#### Scenario: A K8s Job and its pod template carry the same label set

- **GIVEN** a `SpawnSession` for the analysis `an-1`, the run `run-1`, and the step `step-a`, on the K8s backend
- **WHEN** the K8s backend makes the Job
- **THEN** the Job metadata and the pod template metadata each carry the six harness labels
- **AND** the Job annotation `cortex/owner-workflow-id` holds `spec.childWorkflowId` with no change

### Requirement: The host labels merge under the harness labels with no rewrite

The client MUST merge the host labels first and the harness labels last. Thus, if a host key is
the same as a harness key, the sandbox carries the harness value. On Docker, the label
`cortex/owner-workflow-id` is a harness key too.

The client MUST stamp each host value exactly as the host gives it. The harness MUST NOT change
a host value to make it valid. A host reconciler uses a label value as a lookup key. Thus a
changed value cannot find its record.

The Docker engine sets no limit on a label value. On K8s, the API server does a check of each
label value. If the API server refuses a value at admission, the spawn MUST fail as
`container_create_failed`, with the status and the cause from the API server. The harness MUST
NOT apply the K8s rules to a host value, because the API server is the authority.

#### Scenario: A harness key wins a clash

- **GIVEN** a hook that gives `{ "cortex/run-id": "other", "example.com/tenant": "acme" }`
- **WHEN** the client makes a sandbox for the run `run-1`
- **THEN** the sandbox carries `cortex/run-id=run-1` and `example.com/tenant=acme`

#### Scenario: A host value reaches the container with no change

- **GIVEN** a hook that gives `{ "example.com/user": "user@example.com" }`, on the Docker backend
- **WHEN** the client makes a sandbox
- **THEN** the container carries `example.com/user=user@example.com`

#### Scenario: K8s refuses a host value that is not a valid label value

- **GIVEN** a hook that gives `{ "example.com/user": "user@example.com" }`, on the K8s backend
- **WHEN** the client makes a sandbox
- **THEN** the Job carries the value `user@example.com` with no change
- **AND** the API server refuses the Job at admission
- **AND** the spawn fails as `container_create_failed`, with the status and the cause from the API server

### Requirement: The harness label values are valid by construction

The harness MUST make each label value that it owns valid by construction. It MUST NOT change a
value to make it valid. A valid label value has 1 to 63 characters. It holds only letters,
digits, `.`, `_`, and `-`, and it starts and ends with a letter or a digit.

The format of each harness value:

- `app.kubernetes.io/managed-by` and `role` hold the constants `cortex` and `sandbox`.
- `cortex/sandbox-id` holds the sandbox id that the harness makes, in the form `sbx-{run8}-{rand8}`.
- `cortex/run-id` holds a UUID, or a short literal of the harness, for example `data-profile`.
- `cortex/step-id` holds a step id that obeys the step-id rule of the workspace-layout spec.
  Each literal step id of the harness (`synthesis`, `profile`, `derive`, and `extract`) obeys
  the same rule.
- `cortex/analysis-id` holds the analysis id that the host gives. On K8s, the host MUST give an
  analysis id that is a valid label value.

#### Scenario: A plan step stamps valid values

- **GIVEN** a UUID run id, a step id that the plan validator accepted, and an analysis id that is a valid label value
- **WHEN** the K8s backend makes the Job for that step
- **THEN** each harness label value is a valid label value
- **AND** the harness changed no value

#### Scenario: A literal spawn path stamps valid values

- **GIVEN** the data profile, with the run id `data-profile` and the step id `profile`
- **WHEN** the K8s backend makes the Job
- **THEN** the Job carries `cortex/run-id=data-profile` and `cortex/step-id=profile`

#### Scenario: An analysis id that is not a valid label value fails on K8s

- **GIVEN** an analysis id of 70 characters from the host, on the K8s backend
- **WHEN** the client makes a sandbox
- **THEN** the Job carries that analysis id with no change
- **AND** the API server refuses the Job, and the spawn fails as `container_create_failed`
