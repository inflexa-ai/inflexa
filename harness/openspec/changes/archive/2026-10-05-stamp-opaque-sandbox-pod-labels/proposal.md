# Stamp opaque sandbox pod labels

## Why

The sandbox pods still carry no attribution labels, and the cost reconciler still
sees none of them. `restore-sandbox-billing-labels` read the billing-context id
out of the `ResolveBilling` seam by the raw map key `X-Inflexa-Billing-Context`,
but that seam is typed `(session) => Promise<BillingHeaders>` — the FINAL wire
headers. A managed host assembles them for its gateway, where each key becomes
`x-bf-lh-<name>`. The raw key is thus never present, the lookup gives
`undefined`, `meta.billing` stays unset, and `buildJobSpec` stamps nothing. The
staging cluster confirms it.

The key mismatch is a symptom. The cause is that the harness knows what a billing
context is. It must not. A billing context is a coordinate of one host's metering
system, and the harness has no use for the value that it reads.

## What Changes

- `CreateSandboxMeta.billing` becomes `podLabels?: Record<string, string>` — an
  opaque map of labels that the harness stamps and never reads.
- `buildJobSpec` stamps `meta.podLabels` on both the Job metadata and the pod
  template. It keeps its own two identifiers, `cortex/analysis-id` and
  `cortex/run-id`, and it keeps `sanitizeLabelValue` on each value.
- `SandboxStepDeps.resolveBilling` and `DataProfileDeps.resolveBilling` become
  `resolvePodLabels?: (session: RunSession) => Promise<Record<string, string>>`.
  The step resolves the labels inside the existing `sandbox.create` DBOS step.
- An absent seam, a seam that throws, and a seam that gives an empty map each
  spawn the sandbox with no host labels. Attribution never blocks compute.

The host supplies the labels in their final form. Nexus pull request #145 does
this: `resolve-headers` becomes `resolve-attribution` and it gives back
`{ headers, podLabels }`.

## Capabilities

### Modified Capabilities

- `compute-billing-attribution`: the spawn paths resolve an opaque label map
  through a host seam. They no longer read a billing-context id, and they no
  longer name a header key.
- `k8s-sandbox-provider`: the Job spec stamps the host's label map, in place of
  the four billing labels that it derived itself.

## Impact

- `src/sandbox/types.ts` — `CreateSandboxMeta.podLabels`.
- `src/sandbox/k8s-client.ts` — the label stamping in `buildJobSpec`; the
  `BILLING_CONTEXT_LABEL` and `USER_ID_LABEL` constants are gone.
- `src/workflows/sandbox-step.ts`, `src/tasks/data-profile.ts` — the
  `resolvePodLabels` seam in place of `resolveBilling`.
- Breaking for an embedder that wires either dep: version 0.20.0.
- The `ResolveBilling` seam itself, the providers, and the billing resolver are
  untouched. Each LLM call and each embedding call keeps its own resolver.
