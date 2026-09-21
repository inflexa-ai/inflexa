## 1. A `Result` survives a DBOS checkpoint

- [x] 1.1 Register the neverthrow `Ok` and `Err` classes with `DBOS.registerSerialization` before DBOS launches (D7)
- [x] 1.2 Add a test: a step that returns `err` gives the same `err` again on replay, with the methods of a `Result`
- [x] 1.3 Add a test: a workflow that returns `err` gives the `err` to the caller of `getResult()`

## 2. The hook kinds

- [x] 2.1 Add the types `GateFailure` and `NoticeFailure` (D1)
- [x] 2.2 Add one internal helper for a gate and one for a notice. The notice helper logs an `err` at the error level
- [x] 2.3 Add tests for the two helpers: a gate `err`, a gate `err` with `suspend`, and a notice `err`
- [x] 2.4 Change `RunAuthorizer`: `authorize` becomes a gate, and `revoke` and `revokeByJti` become notices. Update
  `createLocalRunAuthorizer`
- [x] 2.5 Change each caller of `authorize`, `revoke`, and `revokeByJti` to use the helpers. Remove each `try`,
  `catch`, and `.catch(() => {})` around them (`src/tools/execute-analysis.ts`,
  `src/tools/report-session/derive-table.ts`, `src/tasks/extract-values.ts`, `src/tasks/data-profile.ts`,
  `src/workflows/execute-analysis.ts`, `src/execution/run-canceler.ts`)
- [x] 2.6 Change `RunCharge`: `open` becomes a gate, and `close` becomes a notice that takes the outcome union of D6.
  Update `createNoopRunCharge` and each caller
- [x] 2.7 Change `UsageRecorder.record` to a notice. Update `createNoopUsageRecorder` and the delivery in
  `src/loop/run-agent.ts`, which does not wait for the result
- [x] 2.8 Change `ArtifactRegistry`: `register` becomes a gate, and `sync` becomes a notice. Update
  `createNoopArtifactRegistry`, `src/execution/artifact-registration.ts`, and `src/workflows/sandbox-step.ts`

## 3. The model request headers hook and the provider errors

- [x] 3.1 Replace `resolveBilling` with the optional `resolveRequestHeaders` in `src/providers/ai-sdk.ts`,
  `anthropic.ts`, and `embedding.ts`. Remove `BillingSeamFailure`
- [x] 3.2 Remove `ResolveBilling`, `createNoopBillingResolver`, `BillingResolutionError`, `BillingMap`,
  `BillingHeaders`, `BillingFetchResult`, and `BillingFetcher`. Rename `BillingSessionView` to `HookSessionView`
- [x] 3.3 Add the optional `suspendOn` map to the provider configuration, with the default `{ 402: "payment_required" }`
- [x] 3.4 In `src/providers/errors.ts`, replace the kinds `budget` and `tenant-blocked` with the kind `suspend`. Make
  the messages generic HTTP messages. Make sure that the retry envelope never retries a `suspend` error
- [x] 3.5 Remove `src/loop/budget-exceeded.ts` and its text match. Change its callers to read the kind `suspend`
- [x] 3.6 Update the provider tests: a mapped status, an unmapped `403`, a hook `err`, and an absent hook

## 4. The sandbox spawn and the labels

- [ ] 4.1 Change `createSandbox` to `(session: SpawnSession, spec: SandboxSpec, identity)` (D4). Read the analysis
  id, the run id, and the step id from the session in `create-sandbox.ts`, `k8s-client.ts`, `docker-client.ts`, and
  `mount-plan.ts`
- [ ] 4.2 Add the optional `resolveSandboxLabels` to `CreateSandboxClientConfig`. Call it in `createSandbox` before
  `precreateStepTree`. Add the `SandboxError` variant `labels_refused`
- [ ] 4.3 Stamp the label set of D5 on the Docker container, the K8s Job, and the K8s pod template. Merge the host
  labels first. Keep the owner workflow id as a Docker label and as a K8s annotation
- [ ] 4.4 Remove `sanitizeLabelValue` and its tests
- [ ] 4.5 Remove `resolvePodLabels` from `SandboxStepDeps` and `DataProfileDeps`, with their branches and warnings
- [ ] 4.6 Pass the session at the four spawn paths. Add `runSession` to `DeriveTableExecInput`, and fill it from the
  authorization in `src/tools/report-session/derive-table.ts`
- [ ] 4.7 In `src/schemas/validate-plan.ts`, accept a step id only if it is a safe id and a valid label value (D8)
- [ ] 4.8 Add a test of the label set on each backend
- [ ] 4.9 Add a test of a host key that clashes with a harness key
- [ ] 4.10 Add a test of an absent label hook, and a test of `labels_refused` with no backend call
- [ ] 4.11 Add a test of a step id that is too long, and a test of a step id with a wrong first character

## 5. The suspension

- [ ] 5.1 Make one function mark the analysis as suspended for each workflow suspension, with the literal
  `suspended_insufficient_funds`
- [ ] 5.2 In `src/workflows/sandbox-step.ts`, on a `suspend` error or a gate `err` with `suspend`, record the reason.
  Send the typed suspension on the topic `child-suspended`, then cancel the workflow
- [ ] 5.3 In `src/workflows/execute-analysis.ts`, read the kind of the child message, not a reason string. Cancel the
  sibling steps. Carry the reason to the failure reason of the run and to `RunCharge.close`
- [ ] 5.4 In `src/tasks/data-profile.ts`, suspend on a `suspend` error or a gate `err` with `suspend`. Set the
  profile row to `failed` with the reason, then end in `CANCELLED`
- [ ] 5.5 In `src/tools/execute-analysis.ts`, on an `authorize` `err`, start no workflow. Set the run row to
  `failed`, or to `canceled` with a mark on the analysis when `suspend` is true
- [ ] 5.6 In `src/workflows/execute-analysis.ts`, on a `RunCharge.open` `err`, start no step. End the run as
  `failed`, or suspend it when `suspend` is true
- [ ] 5.7 In `src/tasks/derive-table-exec.ts` and `src/tasks/extract-values.ts`, return
  `err({ kind: "suspended", reason })`. Make the awaiting tools report the reason
- [ ] 5.8 Make a `suspend` error in a chat turn fail the turn with the reason, with no mark on the analysis
- [ ] 5.9 Give the reason to the `cause` label in `src/workflows/metrics.ts` and to the failure code of the chat event
- [ ] 5.10 Add a test of a run suspension from a model error, and a test of a run suspension from a gate `err`
- [ ] 5.11 Add a test of a profile suspension, and a test of an awaited workflow that returns the suspension
- [ ] 5.12 Add a test of a chat turn with a `suspend` error

## 6. Remove the throws and the catches

- [ ] 6.1 Remove the `try` and `catch` blocks around the hooks and the state writes in
  `src/workflows/execute-analysis.ts`. Use the `Result` values of the steps
- [ ] 6.2 Search `src/workflows/` and `src/tasks/` for each remaining `catch` and `throw`. Keep only the ones at a
  DBOS boundary, an API boundary, or a client boundary

## 7. The exports, the documents, and the archive

- [ ] 7.1 Update `src/index.ts`: export the new hook types and remove the billing names
- [ ] 7.2 Update `CLAUDE.md` and `CONTEXT.md` of the harness where they name the billing seam or the `402` cascade.
  In the house rules of `CLAUDE.md`, add the `Result` recipe of D7 and the throw rule
- [ ] 7.3 After the archive, update the Purpose sections that name `ResolveBilling` or the `402` pause:
  `harness-providers`, `harness-session-model`, and `workflow-failure-lifecycle`. A delta cannot change a Purpose
  section
- [ ] 7.4 Before the archive, archive the change `drop-analysis-billing-context`, which modifies the same requirement
  `cortex_analysis_state table schema`. Then copy the new text of that requirement from `openspec/specs/` into this
  delta, and apply the change of the suspend scenario again

## 8. The CLI, in the same pull request

The `cli` jobs of CI link the working-copy harness. Thus the CLI must change in the same pull request.

- [ ] 8.1 Remove `createNoopBillingResolver` and `resolveBilling` from `cli/src/modules/harness/runtime.ts`
- [ ] 8.2 Change the CLI `UsageRecorder` (`cli/src/modules/harness/usage_recorder.ts`) to a notice
- [ ] 8.3 Change the CLI `ArtifactRegistry` (`cli/src/modules/harness/prov_bridge.ts`) to a gate `register` and a
  notice `sync`
- [ ] 8.4 Run the CLI typecheck and the CLI tests against the linked harness

## 9. Verification

- [ ] 9.1 Run `tsc -p tsconfig.json` in `harness/`
- [ ] 9.2 Run `bun test` in `harness/`
- [ ] 9.3 Run `bun run format:file` on each changed file in `harness/src/`
