## Context

The harness calls host code through injected hooks. Today these hooks have four problems.

- **The pod labels come from the callers.** `resolvePodLabels` is an optional field on `SandboxStepDeps`
  (`src/workflows/sandbox-step.ts:288`) and on `DataProfileDeps` (`src/tasks/data-profile.ts:144`). Each caller must
  resolve the labels and give them to `createSandbox`. `derive-table-exec` and `extract-values` borrow the sandbox
  client of the data profile (`src/runtime/assemble.ts:310-325`), but not its resolver. Thus their pods have no host
  labels.
- **The harness holds the words of one host.** `ResolveBilling` names a billing seam. `src/providers/errors.ts:9-11`
  reads `402` as a budget and `403` as a blocked tenant, because one gateway uses these codes that way. The run writes
  `budget_exceeded` and the analysis status `suspended_insufficient_funds`.
- **Each hook has its own failure policy.** `RunCharge.open` throws and fails the run
  (`src/workflows/execute-analysis.ts:952-960`), but the cortex realization discards each failure.
  `RunCharge.close` and `revoke` are caught and logged. `UsageRecorder.record` must not fail, by contract. The billing
  seam fails a model call through a wrapper class (`BillingSeamFailure`, `src/providers/ai-sdk.ts:338-367`).
- **The labels change silently.** `sanitizeLabelValue` (`src/sandbox/k8s-client.ts:84-92`) rewrites each value, and
  its own comment says that a rewritten value cannot be a lookup key. The host reconciler uses the labels as lookup
  keys.

The embedders are cortex and the CLI. Cortex runs K8s in production and Docker in development. The CLI runs Docker
only. All three packages use neverthrow `8.2.0`.

## Goals / Non-Goals

**Goals:**

- The harness asks only for the values that it uses, and it does not read them.
- The type of each hook shows its failure rule.
- No spawn path can skip the label hook.
- The labels are the same on both backends, and the format of each value has one document.
- A host decides which status codes suspend work. The harness owns the mechanism of a suspension, but not its reason.
- The harness throws only at a DBOS boundary or in a tool body. It catches only at a boundary.

**Non-Goals:**

- A new name for `RunCharge` or for the `src/billing/` directory.
- The other seams: `resolveWorkspaceRoot`, `farmSource`, the provenance seam, and the eyes. Each keeps its contract.
- A resume of a workflow other than an analysis run.
- A change of the tool bodies that throw through `unwrapOrThrow` (63 sites in 16 files under `src/tools/`).
- A change to the metering reconciler of the host.

## Decisions

### D1. Two kinds of hook: gate and notice

A gate gives a value or a permission that is necessary before the harness can continue an operation. A notice reports a
fact after the fact. The type of the hook shows its kind.

```ts
interface GateFailure { readonly reason: string; readonly suspend: boolean }
interface NoticeFailure { readonly reason: string }

// A gate.
(input) => ResultAsync<T, GateFailure>
// A notice.
(input) => ResultAsync<void, NoticeFailure>
```

- If a gate gives `err`, the operation fails with the reason of the host. If `suspend` is true, the operation
  suspends (D6).
- If a notice gives `err`, the harness logs the reason at the error level. The outcome of the operation does not
  change, because the work is complete.
- The harness calls each hook through one of two internal helpers, one for each kind. Thus no call site selects its
  own policy, and no call site has a `try` or a `catch` around a hook.
- If the promise inside a hook rejects, that is a defect of the host. The harness does not catch it.

The kind of each hook:

| Hook | Kind | Value |
|-|-|-|
| `RunAuthorizer.authorize` | gate | `RunAuthorization` |
| `RunAuthorizer.revoke`, `RunAuthorizer.revokeByJti` | notice | none |
| `resolveRequestHeaders` | gate | `RequestHeaders` |
| `resolveSandboxLabels` | gate | `SandboxLabels` |
| `RunCharge.open` | gate | none |
| `RunCharge.close` | notice | none |
| `ArtifactRegistry.register` | gate | `ExternalRegistrationResult` |
| `ArtifactRegistry.sync` | notice | none |
| `UsageRecorder.record` | notice | none |

`RunCharge.open` gives no value, but the run must not start if it fails. Thus it is a gate. `ArtifactRegistry.sync`
gives no value, and `queryUnsyncedStepArtifacts` selects each row again after a failure. Thus it is a notice.
`UsageRecorder.record` stays off the path of the loop. The loop does not wait for it, and it logs an `err` when the
result arrives.

Alternative: one rule for all hooks, "a failure stops the run". A notice runs after the work, thus nothing is left
to stop. This rule does not fit `close`, `revoke`, or `record`.

Alternative: `PromiseLike<Result<T, E>>` as the return type. It also accepts a plain `async` function. The two
embedders use neverthrow already, and the harness composes with `ResultAsync` in its own code. Thus `ResultAsync` is
the simpler contract. The `ResultAsync` class has a private field, thus the three packages must keep one neverthrow
version.

### D2. The model request headers hook replaces `ResolveBilling`

Each provider (`src/providers/ai-sdk.ts`, `anthropic.ts`, `embedding.ts`) takes an optional
`resolveRequestHeaders: (session: ResolvableSession) => ResultAsync<RequestHeaders, GateFailure>`. The provider calls
it before each attempt of a model request, and it adds the headers as they are. If the hook is absent, the provider
adds no headers. `RequestHeaders` is `Readonly<Record<string, string>>`.

An `err` fails the request at once, with no retry, because the hook is not the model wire. This replaces
`BillingSeamFailure`. Remove `ResolveBilling`, `createNoopBillingResolver`, `BillingResolutionError`, `BillingMap`,
`BillingHeaders`, `BillingFetchResult`, and `BillingFetcher`. The session view `BillingSessionView` becomes
`HookSessionView`.

Alternative: one hook that returns the headers and the labels together. It couples a host that attributes model
calls to compute. The drift of the two old seams came from their position (a caller against the component that uses
the value), not from their number.

### D3. The sandbox label hook

`CreateSandboxClientConfig` takes an optional
`resolveSandboxLabels: (session: RunSession) => ResultAsync<SandboxLabels, GateFailure>`. `SandboxLabels` is
`Readonly<Record<string, string>>`. The client calls the hook in `createSandbox`, before it makes the step tree and
before it calls a backend. If the hook is absent, the sandbox has no host labels. An `err` refuses the spawn with the
new `SandboxError` variant `labels_refused`, which carries the reason and the suspend flag. No backend call occurs.

`createSandbox` gives each `SandboxError` as an `err` value, and it does not throw. Thus a spawn path reads a
`labels_refused` with `suspend` as a suspension, and it needs no `catch`. For each other error, the spawn path fails
its DBOS step through `unwrapOrThrow`. The other client operations keep their contract.

Both backends stamp the labels. This is the only place where the harness uses the hook. Thus a new spawn path gets
the labels with no extra code.

Alternative: a field on the K8s configuration only. Nothing meters a Docker container today, but that is a fact about
one host. A host can read Docker labels, for example through cAdvisor. A field on one backend makes the composition
of a host depend on its backend.

### D4. `createSandbox` takes the session

```ts
createSandbox(session: SpawnSession, spec: SandboxSpec, identity: SandboxIdentity): ResultAsync<SandboxRef, SandboxError>
```

`SpawnSession` is a `RunSession` whose `runFrame.stepId` is present. The client reads the analysis id from
`session.scope.analysisId`, the run id from `session.runFrame.runId`, and the step id from `session.runFrame.stepId`.
`SandboxSpec` holds the other fields of today's `CreateSandboxMeta`: `childWorkflowId`, `image`, `extraEnv`,
`resources`, `readOnly`, `writableTail`, and `execId`. Remove `podLabels`.

Each of the four spawn paths holds such a session already:

- `sandbox-step`: the step session (`src/workflows/sandbox-step.ts:433`).
- `data-profile`: `childSession` (`src/tasks/data-profile.ts:515`).
- `extract-values`: `input.runSession` (`src/tasks/extract-values.ts:68-70`).
- `derive-table-exec`: the tool authorizes a session (`src/tools/report-session/derive-table.ts:335-340`). The
  workflow input `DeriveTableExecInput` gets the new field `runSession`.

The session frames of today use the same ids as the meta of today. Thus the stamped values do not change.

### D5. The label set and the merge rule

Each sandbox carries these harness labels on both backends. On K8s, the Job metadata and the pod template metadata
both carry them.

| Key | Value |
|-|-|
| `app.kubernetes.io/managed-by` | `cortex` |
| `role` | `sandbox` |
| `cortex/sandbox-id` | the sandbox id |
| `cortex/analysis-id` | `session.scope.analysisId` |
| `cortex/run-id` | `session.runFrame.runId` |
| `cortex/step-id` | `session.runFrame.stepId` |

The owner workflow id is the label `cortex/owner-workflow-id` on Docker and the annotation of the same key on K8s. A
DBOS workflow id can be longer than 63 characters and can hold `:`, thus it is not a valid K8s label value.

The client merges the host labels first and the harness labels last. Thus a harness key wins a clash. The client
stamps each host value as the host gives it. If a value is not valid on K8s, the API server refuses the Job at
admission. The spawn then fails as `container_create_failed` with the status and the cause. The harness does not
apply the rules of K8s, because the API server is the authority.

The harness makes its own values valid by construction:

- A run id is a UUID (`src/tools/execute-analysis.ts:409`, `src/.../analysis-invocation.ts:15`) or a short literal.
- A step id obeys the step-id rule (D8), and each literal step id obeys it too.
- A sandbox id is built by the harness.
- An analysis id comes from the host. On K8s, the host must give an analysis id that is a valid label value.

Remove `sanitizeLabelValue`.

### D6. Suspension

A provider configuration takes an optional `suspendOn: Readonly<Record<number, string>>`, a map from an HTTP status
code to a suspend reason. The default is `{ 402: "payment_required" }`. A map from the host replaces the default
map, and the two maps do not merge. If a model request fails with a status in the
map, the provider gives the error kind `suspend` with the status and the reason. The provider never retries it.

The map belongs to the provider, because the meaning of a code belongs to the gateway. The CLI builds one provider for
each agent model (`cli/src/modules/harness/runtime.ts:914`), and each can use a different gateway. The retry envelope
also lives in the provider. Thus the provider must know a suspend code to not retry it, for example a `429` that a
host maps to a quota reason.

The kinds `budget` and `tenant-blocked` go. A `403` that is not in the map is a normal non-retryable `provider`
error. The messages become generic HTTP messages. The predicate `isBudgetExceeded` and its text match
`/budget.?exceeded/i` go. The Go sandbox server (`images/sandbox-base/server`) has no model code, thus nothing
produces that text.

A gate failure with `suspend: true` also suspends the operation. Thus a host can suspend work when it refuses a
spawn, a run charge, or an authorization, for example because the account has no funds.

The owner of the result of a workflow decides the mechanism:

- **A durable owner** (`executeAnalysis`, `sandbox-step`, `data-profile`). The result goes to stored state. The
  workflow records the reason and ends in the DBOS state `CANCELLED`, because `resumeWorkflow` reads that state
  (`src/workflows/sandbox-step.ts:700-705`). A `sandbox-step` child sends a typed suspension on the message topic
  `child-suspended`, which replaces `child-budget-exceeded` (`src/workflows/sandbox-step.ts:156`). The parent reads
  the kind of the message, not a reason string (today `r.error === "budget_exceeded"` at
  `src/workflows/execute-analysis.ts:1236`). The parent then cancels the sibling steps, as today.
- **A live caller** (`derive-table-exec`, `extract-values`). A chat turn awaits the result, and nothing reads the
  result after that turn. The workflow does not cancel. It returns `err({ kind: "suspended", reason })` as its value.
  The tool that awaits it reports the reason.

In both cases, one function marks the analysis as suspended. The analysis status keeps the literal
`suspended_insufficient_funds`, which is now the name of the one suspended state. Thus no data migration is
necessary.

A chat turn is not a workflow. A suspend error in a chat turn fails the turn with the reason. It does not mark the
analysis, because cortex resumes the analysis on the next chat message (`cortex/managed/http/chat.ts:331`).

The harness carries the reason as a string and does not read it:

- the `error` and `lastErrorClass` of the step row
- the failure reason of the run
- `RunCharge.close`, which takes the outcome
  `{ kind: "ok" | "error" | "canceled" } | { kind: "suspended"; reason: string }`
- the `cause` label of the metric of a canceled child (`src/workflows/metrics.ts:39`)
- the failure code of the chat event (`src/contracts/chat-events.ts:137`)

Cortex maps `402` to `"budget_exceeded"`. Thus each new stored reason is the same as each old one.

Alternative: one suspend map at `assembleCoreRuntime`. The retry envelope would then not know a suspend code, and all
providers would share one gateway meaning.

### D7. A `Result` survives a DBOS checkpoint

DBOS saves each input, step output, workflow output, and message with SuperJSON. SuperJSON drops the class of a
neverthrow `Ok` or `Err`, thus a replay gets a plain object without the methods of a `Result`. Today each step unwraps
its `Result` inside the step and throws.

The harness registers `Ok` and `Err` one time with `DBOS.registerSerialization`, before DBOS launches
(`@dbos-inc/dbos-sdk`, `dbos.d.ts:631`). Then a step and a workflow can return a `Result`. An `err` from a step is a
value: DBOS records the step as a success, and a replay returns the same `err`. The body must then use the `err`.

The rules of the harness:

- The harness throws only at a DBOS boundary: a step or a workflow that must fail, a step that DBOS must retry, and
  the self-cancel of a suspension. `unwrapOrThrow` stays the one bridge from a `Result` to a throw.
- A tool `execute` body keeps its sanctioned bridge (`harness/CLAUDE.md`): it can throw through `unwrapOrThrow`, and
  the dispatch catch of the loop changes the throw into an error tool result.
- The harness catches only at a DBOS boundary, an API boundary, a client boundary, or the dispatch catch of the loop.
  A DBOS boundary is a workflow body that gets the throw of a failed step or a failed child, and that runs its failure
  path. An exception from DBOS, for example `DBOSWorkflowCancelledError`, passes through.
- The `try` and `catch` blocks around the hooks in `executeAnalysis` go (`src/workflows/execute-analysis.ts:1515-1560`).

A failure that must fail a step still crosses the DBOS boundary as a throw, as the workspace-root-resolution spec
requires.

Alternative: convert each `Result` to plain data inside each step. Each awaited workflow would then have its own
result format.

### D8. The step-id rule

The plan validator (`src/schemas/validate-plan.ts`) accepts a step id only if it is a safe id and a valid label value:
1 to 63 characters, `[A-Za-z0-9._-]` only, and a letter or a digit at the start and at the end. `SAFE_ID`
(`src/workspace/paths.ts:305`) has no length limit and lets `_`, `.`, and `-` start or end an id. The literal step ids
`synthesis`, `profile`, `derive`, and `extract` obey the new rule.

## Risks / Trade-offs

- **Risk:** The validator refuses a long step id that it accepted before. **Mitigation:** The message gives the rule,
  and the planner makes the plan again.
- **Risk:** A host label that K8s does not accept now fails the spawn. Before, the harness rewrote it.
  **Mitigation:** The failure carries the reason of the API server. The rewrite hid a wrong lookup key, and that was
  the original fault.
- **Risk:** A new DBOS topic, a new workflow input, and new step outputs break a workflow that runs across the deploy.
  **Mitigation:** Deploy in downtime.
- **Risk:** The `ResultAsync` class has a private field. Thus two neverthrow versions do not share its type.
  **Mitigation:** Keep one neverthrow version in the harness, cortex, and the CLI.
- **Risk:** A host can map a common code to a suspension, for example `429`. Then each throttle suspends a workflow.
  **Mitigation:** The map is a decision of the host. The default map holds `402` only.
- **Risk:** An alert that matches the cause `budget_exceeded` breaks if cortex uses a different reason.
  **Mitigation:** Cortex maps `402` to `"budget_exceeded"`.

## Migration Plan

1. Release the harness as a breaking version.
2. Change cortex: wire `resolveRequestHeaders` and `suspendOn` on each provider, and wire `resolveSandboxLabels` on
   the sandbox client. Move each realization of `RunAuthorizer`, `RunCharge`, `UsageRecorder`, and
   `ArtifactRegistry` to `ResultAsync`. Make `RunCharge.open` return `err` on a failure.
3. Change the CLI: remove `createNoopBillingResolver`. Keep the local adapters of the harness.
4. Deploy cortex in downtime, with no workflow in flight.
5. Rollback: deploy the previous cortex with the previous harness pin. The stored data does not change format.

## Open Questions

None.
