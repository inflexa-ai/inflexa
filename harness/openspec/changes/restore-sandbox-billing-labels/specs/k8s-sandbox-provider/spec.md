## ADDED Requirements

### Requirement: Billing attribution labels on Job and pod template

When `CreateSandboxMeta.billing` is present, `buildJobSpec` SHALL stamp the labels `cortex/billing-context` (= `billing.billingContextId`), `cortex/user-id` (= `billing.userId`), `cortex/analysis-id` (= `meta.analysisId`), and `cortex/run-id` (= `meta.runId`) on **both** the Job metadata labels and the pod template metadata labels. All values SHALL pass through `sanitizeLabelValue`. The pod template placement is normative: the OpenCost-based metering reconciler allocates by pod labels and filters on the sanitized key `cortex_billing_context` being non-empty; a Job-only label is invisible to metering.

When `CreateSandboxMeta.billing` is absent, no billing labels SHALL be stamped and the spawn SHALL proceed unchanged — the provider carries no billing policy of its own; loudness for a missing-billing spawn is the spawn site's responsibility.

#### Scenario: Labels present on the pod template

- **GIVEN** `CreateSandboxMeta` with `billing = { billingContextId: B, userId: U }`, `analysisId: A`, `runId: R`
- **WHEN** the Job spec is built
- **THEN** the pod template labels include `cortex/billing-context: B`, `cortex/user-id: U`, `cortex/analysis-id: A`, `cortex/run-id: R`
- **AND** the Job metadata labels include the same four labels

#### Scenario: Absent billing meta stamps nothing and still spawns

- **GIVEN** `CreateSandboxMeta` without `billing`
- **WHEN** `createSandbox(meta)` runs
- **THEN** the pod template carries no `cortex/billing-context` / `cortex/user-id` / `cortex/analysis-id` labels
- **AND** the Job is still created and the sandbox becomes Ready
