# Tasks — stamp-opaque-sandbox-pod-labels

## 1. The opaque label map

- [x] 1.1 Replace `CreateSandboxMeta.billing` with `podLabels?: Record<string, string>` in `src/sandbox/types.ts`, documented as opaque host labels.
- [x] 1.2 Stamp `meta.podLabels` on both the Job metadata and the pod template in `src/sandbox/k8s-client.ts`; keep `cortex/analysis-id` and `cortex/run-id` derived from `meta`; keep `sanitizeLabelValue` on each value; delete the `BILLING_CONTEXT_LABEL` and `USER_ID_LABEL` constants.

## 2. The spawn seam

- [x] 2.1 `src/workflows/sandbox-step.ts`: replace `resolveBilling` with `resolvePodLabels` on `SandboxStepDeps`; call it inside the existing `sandbox.create` step; warn and spawn unlabeled when it throws or gives an empty map.
- [x] 2.2 `src/tasks/data-profile.ts`: the same replacement on `DataProfileDeps`, resolved inline at the spawn.

## 3. Tests

- [x] 3.1 `src/sandbox/k8s-client.test.ts`: the host labels reach both the Job and the pod template; each value is sanitized; an arbitrary host key passes through; an absent map keeps the harness's own two labels and still spawns.
- [x] 3.2 `src/workflows/sandbox-step.test.ts`: the resolved map reaches the spawn; the seam sees the step's own session; an absent seam and a seam that throws each spawn with no labels and complete the step.

## 4. Release

- [x] 4.1 Bump `harness/package.json` to 0.20.0 — the dep change is breaking.

## 5. Verification

- [x] 5.1 `npx tsc --noEmit`, `npx eslint .`, and `bun test`.
- [ ] 5.2 Staging: run an analysis and read the pod labels with `kubectl get pods -n staging-sandbox --show-labels`; the reconciler dispatches allocations for the run.

## Notes

- `restore-sandbox-billing-labels` is the superseded change. Archive it before
  this one, so that the removed requirements resolve against the main specs.
