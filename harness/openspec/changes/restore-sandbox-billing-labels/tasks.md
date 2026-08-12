# Tasks — restore-sandbox-billing-labels

## 1. Billing labels on K8s sandbox Jobs

- [x] 1.1 Add `billing?: { billingContextId: string; userId: string }` to `CreateSandboxMeta` in `src/sandbox/types.ts`
- [x] 1.2 Stamp `cortex/billing-context`, `cortex/user-id`, `cortex/analysis-id`, `cortex/run-id` on BOTH Job metadata and pod template labels in `src/sandbox/k8s-client.ts` `buildJobSpec`, all via `sanitizeLabelValue`
- [x] 1.3 Tests: four labels on pod template + Job metadata when `billing` set; sanitized values; no billing labels and successful spawn when unset; `sanitizeLabelValue` edge cases (UUID pass-through, cap-then-trim, all-invalid input)

## 2. Spawn sites resolve and supply attribution

- [x] 2.1 `src/workflows/sandbox-step.ts`: optional `resolveBilling` dep on `SandboxStepDeps`; resolve under the step session INSIDE the existing `sandbox.create` runStep (no new DBOS step — replay-safe for in-flight workflows) and pass `meta.billing`; error-log (`[billing]`) and spawn unlabeled on failure
- [x] 2.2 `src/tasks/data-profile.ts`: optional `resolveBilling` dep on `DataProfileDeps`; resolve under the profiling session inline at spawn; pass `meta.billing`; error-log (`[billing]`) on failure

## 3. Verification

- [x] 3.1 `npx tsc --noEmit`; `bun test src/sandbox/k8s-client.test.ts src/workflows/sandbox-step.test.ts src/tasks/data-profile.trigger.test.ts`
- [ ] 3.2 Staging end-to-end: run an analysis; `kubectl get pods -n staging-sandbox --show-labels` shows the four labels; metering `allocations_dispatched` > 0 within ~2 min; the run's compute settles on close

## Deferred

- Ephemeral-runner spawn path (module not yet ported to this tree — takes the same pattern when it lands)
- Docker-backend label parity
