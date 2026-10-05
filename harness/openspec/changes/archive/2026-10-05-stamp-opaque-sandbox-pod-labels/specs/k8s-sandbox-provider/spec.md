## ADDED Requirements

### Requirement: Host-supplied pod labels on the Job and the pod template

When `CreateSandboxMeta.podLabels` is present, `buildJobSpec` SHALL stamp each of
its entries on **both** the Job metadata labels and the pod template metadata
labels. The map is opaque: the provider SHALL read no key and no value of it, and
it SHALL derive no label from the meaning of one. The pod template placement is
normative, because a cost reconciler allocates by pod labels — a Job-only label is
invisible to it.

`buildJobSpec` SHALL also stamp `cortex/analysis-id` (= `meta.analysisId`) and
`cortex/run-id` (= `meta.runId`) on both, because these two are facts of the run
that the provider already holds.

Every value SHALL pass through `sanitizeLabelValue`, including a host value. One
invalid value makes the API server reject the whole Job at admission, thus the
guard stays even though the host promises a valid value.

When `CreateSandboxMeta.podLabels` is absent, the Job SHALL carry the provider's
own labels only, and the spawn SHALL proceed unchanged.

#### Scenario: The host labels reach the pod template

- **GIVEN** `CreateSandboxMeta` with `podLabels = { "cortex/billing-context": B, "cortex/user-id": U }`, `analysisId: A`, and `runId: R`
- **WHEN** the Job spec is built
- **THEN** the pod template labels include `cortex/billing-context: B`, `cortex/user-id: U`, `cortex/analysis-id: A`, and `cortex/run-id: R`
- **AND** the Job metadata labels include the same four labels

#### Scenario: A host value is sanitized

- **GIVEN** `podLabels = { "cortex/user-id": "user@example.com" }`
- **WHEN** the Job spec is built
- **THEN** the pod template carries `cortex/user-id: user-example.com`

#### Scenario: An arbitrary host key passes through

- **GIVEN** `podLabels = { "example.com/tenant": "acme" }`
- **WHEN** the Job spec is built
- **THEN** the pod template carries `example.com/tenant: acme`

#### Scenario: An absent map stamps nothing extra and still spawns

- **GIVEN** `CreateSandboxMeta` without `podLabels`
- **WHEN** `createSandbox(meta)` runs
- **THEN** the pod template carries `cortex/analysis-id` and `cortex/run-id` and no host label
- **AND** the Job is still created and the sandbox becomes Ready

## REMOVED Requirements

### Requirement: Billing attribution labels on Job and pod template

**Reason**: The provider derived `cortex/billing-context` and `cortex/user-id`
from `CreateSandboxMeta.billing`, thus it held a billing vocabulary that belongs
to the host. The host now gives the labels in final form.

**Migration**: `CreateSandboxMeta.billing` becomes `podLabels`. A host that wants
the same two labels puts them in the map under the same two keys.
