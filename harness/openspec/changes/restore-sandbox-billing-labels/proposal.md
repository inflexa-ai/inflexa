# Restore sandbox billing labels

## Why

Sandbox K8s pods spawn with no billing attribution labels, so the OpenCost-based metering reconciler — which filters allocations on a non-empty `cortex_billing_context` pod label — never sees a single sandbox pod: 100% of sandbox compute/storage/network cost is unbilled. The fix was designed and approved as Cortex's `fix-sandbox-compute-billing` change (landed against Cortex's old in-repo harness copy, commit `71d7dc99`), but that copy was deleted in the migration to this published package and the package source never received it. This change re-lands that design here, post-migration; it is a launch blocker.

## What Changes

- `CreateSandboxMeta` gains an optional `billing?: { billingContextId: string; userId: string }` field.
- The K8s Job spec builder stamps `cortex/billing-context`, `cortex/user-id`, `cortex/analysis-id`, `cortex/run-id` on BOTH the Job metadata and the pod template labels (pod template is what OpenCost allocates on), all values through `sanitizeLabelValue`. Absent `billing` ⇒ no billing labels, spawn unchanged.
- Each K8s spawn path resolves billing attribution via the existing `ResolveBilling` seam under its own session and passes `meta.billing`: analysis sandbox steps (`src/workflows/sandbox-step.ts`, INSIDE the existing `sandbox.create` DBOS step — replay-safe) and the data-profile task (`src/tasks/data-profile.ts`, inline at spawn). Resolution failure error-logs (`[billing]` prefix) and spawns unlabeled — billing never blocks a run.
- `SandboxStepDeps` and `DataProfileDeps` gain an optional `resolveBilling` dep; hosts without an upstream resolver (dev/OSS) wire nothing and pods spawn unlabeled with no noise.

## Capabilities

### New Capabilities

- `compute-billing-attribution`: every K8s sandbox spawn path resolves billing attribution (billing-context id, user id) under its session and passes it to the sandbox client for pod-label stamping.
- `k8s-sandbox-provider`: the K8s Job spec requirement for billing attribution labels on the pod template and Job metadata, sanitized via `sanitizeLabelValue`. (This repo has a `docker-sandbox-provider` spec but no K8s provider spec yet; the billing-label requirement seeds it.)

### Modified Capabilities

(none — no existing spec's requirements change)

## Impact

- `src/sandbox/types.ts` — `CreateSandboxMeta.billing`.
- `src/sandbox/k8s-client.ts` — billing-label stamping in `buildJobSpec`.
- `src/workflows/sandbox-step.ts` — optional `resolveBilling` dep; resolution + `meta.billing` inside the `sandbox.create` step.
- `src/tasks/data-profile.ts` — optional `resolveBilling` dep; inline resolution at spawn.
- No changes to `execute-analysis.ts`, any DBOS workflow input shape, or the docker backend (label parity deferred, as in the original design). The ephemeral runner named in the original design does not exist in this tree — no port target.
- Embedders that want labeled pods wire `resolveBilling` into their `CoreWorkflowDeps.sandboxStep` / `dataProfile` bundles; the metering reconciler's label contract (`cortex_billing_context` etc., UUID-parsed, run-id optional) is the fixed interface.
