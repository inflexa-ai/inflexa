## ADDED Requirements

### Requirement: Every sandbox spawn path offers the host a pod-label seam

Every code path that creates a sandbox SHALL offer an optional
`resolvePodLabels: (session) => Promise<Record<string, string>>` dep, call it
under the session that the path holds, and pass the result as
`CreateSandboxMeta.podLabels`:

1. **Analysis sandbox steps** (`src/workflows/sandbox-step.ts`): called under the
   step's session **inside the existing `sandbox.create` DBOS step**, thus the
   child workflow's step sequence is unchanged and an in-flight workflow that
   resumes across a deploy replays cleanly.
2. **Data profile** (`src/tasks/data-profile.ts`): called under the profiling
   session, inline at the spawn.

The map is opaque. A spawn path SHALL NOT read a key of it, and it SHALL NOT
derive a value from the meaning of one. The host owns what a label means.

Attribution SHALL NOT block compute. When the dep is absent, the sandbox SHALL
spawn with no host label and the path SHALL log nothing — the host chose to
attribute nothing. When a wired dep throws, or gives an empty map, the sandbox
SHALL spawn with no host label and the path SHALL log a warning.

#### Scenario: The resolved map reaches the spawn

- **GIVEN** a sandbox step whose deps carry a `resolvePodLabels` seam
- **WHEN** the `sandbox.create` step executes
- **THEN** the seam is called under the step's own session
- **AND** the spawn carries exactly the map that the seam gave

#### Scenario: An absent seam spawns a clean sandbox

- **GIVEN** a sandbox step whose deps carry no `resolvePodLabels` seam
- **WHEN** the step runs
- **THEN** the sandbox spawns with no host label
- **AND** the step completes

#### Scenario: A seam that throws does not fail the step

- **GIVEN** a `resolvePodLabels` seam whose upstream is unreachable
- **WHEN** the sandbox spawns
- **THEN** the sandbox spawns with no host label
- **AND** a warning records the failure
- **AND** the step completes

## REMOVED Requirements

### Requirement: Every K8s sandbox spawn path supplies billing attribution

**Reason**: The spawn paths read a billing-context id out of the `ResolveBilling`
seam by the raw map key `X-Inflexa-Billing-Context`. That seam gives the FINAL
wire headers, where a managed host has rewritten each key, thus the read always
gave `undefined` and every pod spawned unlabeled. The harness holds no billing
vocabulary at the sandbox boundary now.

**Migration**: `SandboxStepDeps.resolveBilling` and `DataProfileDeps.resolveBilling`
become `resolvePodLabels`. The host resolves the labels in final form and gives
them as an opaque map. The `ResolveBilling` seam keeps its own consumers, which
are the chat provider and the embedding provider.
