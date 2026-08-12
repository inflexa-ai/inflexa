# Design — restore-sandbox-billing-labels

Re-lands Cortex's approved `fix-sandbox-compute-billing` design (Cortex commit `71d7dc99`, implemented against the old in-repo harness copy) in the published package source. The decisions below are that design's, adapted to this tree; deviations are listed at the end.

## Context

The metering side polls OpenCost for allocations in the sandbox namespace, aggregated by pod labels, filtered on `label[cortex_billing_context]!:""`. Required labels (OpenCost-sanitized keys): `cortex_billing_context`, `cortex_user_id`, `cortex_analysis_id` — parsed as UUIDs; `cortex_run_id` optional (absent/non-UUID ⇒ one-off `Charge` per analysis instead of run-rollup `AccrueCost`). K8s label keys with `/`, `-` sanitize to `_`, so the keys `cortex/billing-context` etc. match. `buildJobSpec` stamps no billing labels today, so every pod is filtered out before any metric can fire.

## Goals / Non-Goals

**Goals:**
- Every K8s sandbox pod carries valid billing attribution labels ⇒ OpenCost metering resumes.
- Zero DBOS step-sequence or workflow-input changes — safe for in-flight runs at deploy.
- Resolution failures are loud (error-level) but never block a run.

**Non-Goals:**
- Charge open/close changes; one-resolution-per-run BC pinning (per-step resolution accepts rare `AccrueBCMismatch` fallback noise on mid-run VK rotation — still billed).
- Backfill, alert rules, docker-backend labels, upstream metering changes.

## Decisions

### D1 — Resolve the BC at each spawn site via the existing resolver seam

No new billing mechanism: each spawn path calls the existing `ResolveBilling` seam under its own session and passes `{ billingContextId, userId }` through `CreateSandboxMeta.billing`. The billing-context id is read from the resolved header map's `X-Inflexa-Billing-Context` key; the user id is the session's `identity.user`. Threading one resolution from charge-open through the workflow spine would touch `execute-analysis.ts`, the dep signatures, and `SandboxStepInput` — invasive, and per-step resolution costs one cached resolver call per step.

### D2 — Resolution happens INSIDE the existing `sandbox.create` DBOS step

In `sandbox-step`, the resolve + label construction runs inside the `sandbox.create` runStep closure, not as its own step. A separate `billing.resolve` step inserted before `sandbox.create` would shift the child workflow's step sequence and break replay for in-flight workflows resumed across the deploy; inside the checkpointed step, already-created sandboxes never re-execute it and new runs get resolution atomically with the spawn. Data-profile resolves inline before its `createSandbox` call (no new DBOS step there either).

### D3 — Label set and placement mirror the pre-migration contract exactly

`cortex/billing-context`, `cortex/user-id`, `cortex/analysis-id`, `cortex/run-id` on **both** Job metadata and pod template metadata, all through the existing `sanitizeLabelValue`. The pod template is what OpenCost allocates on; Job metadata aids kubectl triage. Data-profile passes its literal non-UUID run id — the reconciler parses run-id leniently and routes it to the per-analysis one-off Charge path, the designed behavior for run-less workloads.

### D4 — `CreateSandboxMeta.billing` is optional; absence is loud at the spawn site

`billing?: { billingContextId, userId }`. The k8s client stamps labels only when present; the "spawned without billing labels" error log lives at the spawn site (which knows whether a resolver was wired), so no `expectBillingLabels` config threads through the sandbox client. Wirings without a resolver get no `resolveBilling` dep and no noise. `SandboxStepDeps.resolveBilling` and `DataProfileDeps.resolveBilling` are the optional dep seams; both flow through `CoreWorkflowDeps` untouched (structural `Omit`s).

## Risks / Trade-offs

- [Charge appears only when the first allocation lands (~60–120s into a run)] → cosmetic; settlement on close is unchanged.
- [Mid-run VK rotation ⇒ pod-label BC differs from the auto-opened RC's BC] → billed via the `AccrueBCMismatch` isolated-charge fallback; rare and observable.
- [Per-spawn resolution failure ⇒ unlabeled pod ⇒ that step unbilled] → error-logged on every occurrence.
- [`sanitizeLabelValue` could alter a UUID] → UUIDs are label-safe; sanitization is a defensive pass-through.

## Deviations from the original Cortex design

- **Ephemeral runner**: `harness/execution/ephemeral-runner.ts` does not exist in this tree (the runEphemeral port was deferred during the migration) — no port target. When it lands, it takes the same optional `resolveBilling` + inline resolution pattern.
- **`build-deps.ts` wiring**: this tree has no `workflows/build-deps.ts`; deps are host-supplied via `CoreWorkflowDeps` (`assembleCoreRuntime`). Adding the optional `resolveBilling` fields to `SandboxStepDeps` / `DataProfileDeps` is the whole wiring — embedders bind their resolver at their composition root.
- **Logging**: `console.error` in the original becomes the `Logger` seam (`logger.error` with the `[billing]` prefix), matching this tree's structured-logging convention.
- **Header-key constant**: the original imported `HEADERS.BillingContext` from `harness/lib/billing-headers.ts`; that module lives in the managed host now, so the `"X-Inflexa-Billing-Context"` key is a local constant at each of the two spawn sites.
