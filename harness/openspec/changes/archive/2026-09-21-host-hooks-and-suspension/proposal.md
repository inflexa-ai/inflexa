## Why

A production alert showed sandbox compute that the metering reconciler of the host did not see. Two of the four
sandbox spawn paths (`derive-table-exec` and `extract-values`) do not declare the pod-label resolver, thus their pods
have no attribution labels. The cause is the design of the seam, not one missing line. The resolver is an optional
field on the deps of each caller, and each caller must remember to call it.

The harness also holds the words of one host. It names a "billing" seam. It reads the status codes of one gateway as a
budget or a blocked tenant. It writes the reason `budget_exceeded`. A host that uses a different gateway gets a wrong
message and a wrong retry policy.

Each hook also has its own failure policy, and each call site and each realization selects it. Thus a reader cannot
know which failure stops a run.

## What Changes

- **BREAKING** Replace the `ResolveBilling` seam with the optional hook `resolveRequestHeaders` on each model
  provider. The harness adds the headers that the hook returns to each model request, and it does not read them.
- **BREAKING** Add the optional hook `resolveSandboxLabels` to the configuration of the sandbox client. The client
  calls the hook at each spawn, on the Docker backend and on the K8s backend. Remove `resolvePodLabels` from
  `SandboxStepDeps` and `DataProfileDeps`.
- **BREAKING** `createSandbox` takes the `RunSession` of the work. The analysis id, the run id, and the step id come
  from the session. Thus a spawn without a session does not compile, and no spawn path can skip the label hook.
- **BREAKING** Each hook is a gate or a notice, and its type shows which kind it is. A gate returns
  `ResultAsync<T, GateFailure>`. If a gate fails, the operation fails. A notice returns
  `ResultAsync<void, NoticeFailure>`. If a notice fails, the harness logs the failure, and the outcome does not change.
  This rule applies to `RunAuthorizer`, `RunCharge`, `UsageRecorder`, `ArtifactRegistry`, and the two new hooks.
- Stamp the host labels exactly as the host gives them. Remove `sanitizeLabelValue`. A harness key wins a clash with a
  host key. The harness makes its own label values valid by construction, thus a step id must be a valid label value.
  One document gives the label set and the format of each value on both backends.
- **BREAKING** Replace the provider error kinds `budget` and `tenant-blocked` with the kind `suspend`. The
  configuration of each provider maps an HTTP status code to a suspend reason. The default map is
  `402 → "payment_required"`. Remove the text match `/budget.?exceeded/i`.
- Suspend a durable workflow when a model request fails with a suspend error, or when a gate fails and asks for a
  suspension. The owner of the result of the workflow decides the mechanism. The harness carries the reason of the host
  to the step row, the run, `RunCharge.close`, the metric, and the chat event. The harness does not read the reason.
- Register the neverthrow `Ok` and `Err` classes with `DBOS.registerSerialization`. Thus a step and a workflow can
  return a `Result` as a value. The harness throws only where DBOS needs a throw. It catches only at an API boundary or
  a client boundary.

## Capabilities

### New Capabilities

- `host-hooks`: the two kinds of host hook (gate and notice), with the result type and the failure rule of each kind.
  It also gives the kind of each hook and the model request headers hook.
- `workflow-suspension`: the suspend map of a provider, and the gate failure that asks for a suspension. It also gives
  the suspension of a workflow by the owner of its result, and the reason that the harness carries.
- `sandbox-labels`: the label hook of the sandbox client, the label set, the format of each value, and the merge rule,
  on both backends.

### Modified Capabilities

- `harness-providers`: the billing seam becomes the request headers hook. The error kinds `budget` and
  `tenant-blocked` become the kind `suspend`. The classification of `402` and `403` changes.
- `ai-sdk-provider-runtime`: the handling of the budget kinds and the fail-fast rule of the billing seam.
- `harness-session-model`: `RunAuthorizer.authorize` returns the result of a gate.
- `llm-usage-accounting`: `UsageRecorder.record` becomes a notice.
- `harness-agent-loop`: how the loop delivers a usage record and logs a failure.
- `artifact-manifest`: `ArtifactRegistry.register` becomes a gate and `ArtifactRegistry.sync` becomes a notice.
- `harness-durable-runtime`: the list of seams, the 402 cascade that becomes the suspension cascade, and a `Result`
  value that survives a checkpoint.
- `workflow-failure-lifecycle`: `authorize` becomes a gate. `revoke` and `RunCharge.close` become notices.
  `RunCharge.open` becomes a gate. The 402 pause becomes a suspension.
- `cortex-state-layer`: the cause of the suspension of an analysis.
- `run-state-persistence`: the resume after a suspension.
- `step-execution-tracking`: the resume after a suspension, and the new signature of `createSandbox`.
- `data-profile-init`: `authorize` becomes a gate, `revoke` becomes a notice, and a profile can suspend.
- `docker-sandbox-provider`: the label set and the signature of `createSandbox`.
- `harness-sandbox-exec`: the signature of `createSandbox`.
- `workspace-layout`: a step id must be a valid label value.

## Impact

- Code: `src/billing/`, `src/providers/` (`ai-sdk.ts`, `anthropic.ts`, `embedding.ts`, `errors.ts`),
  `src/loop/budget-exceeded.ts`, `src/loop/run-agent.ts`, `src/sandbox/` (`types.ts`, `client.ts`,
  `create-sandbox.ts`, `k8s-client.ts`, `docker-client.ts`), `src/workflows/` (`sandbox-step.ts`,
  `execute-analysis.ts`, `metrics.ts`), `src/tasks/` (`data-profile.ts`, `extract-values.ts`,
  `derive-table-exec.ts`), `src/tools/report-session/derive-table.ts`, `src/execution/`, `src/auth/`,
  `src/state/analyses.ts`, `src/schemas/validate-plan.ts`, `src/runtime/assemble.ts`, and `src/index.ts`.
- Embedders: cortex and the CLI must change their composition roots and their hook realizations. Cortex must wire
  the two new hooks and the suspend map `402 → "budget_exceeded"`. The cortex `RunCharge.open` must return an `err`,
  because today it discards a failure. The CLI must remove `createNoopBillingResolver`.
- Data: no data migration. The analysis status `suspended_insufficient_funds` stays. With the cortex map, each new
  stored reason stays `budget_exceeded`.
- Deploy: in downtime. A workflow that runs across the deploy is not supported. The DBOS message topic, the input of
  `derive-table-exec`, and the step-id rule change.
- Alerts: the metric of a canceled child carries the reason of the host as its cause label.
