# workflow-suspension Specification

## Purpose

Define the suspension of work. A suspension starts from a model request that fails with a `suspend` error,
or from a gate refusal with the suspend flag. The owner of the result of a workflow selects the mechanism. The
harness carries the reason of the host with no change, and it never reads the reason.

## Requirements

### Requirement: A suspension starts only from a suspend error or from a gate failure with the suspend flag

The harness MUST start a suspension only from one of these two sources:

- A model request fails with a `ProviderError` of the kind `suspend`, for example for a status in the `suspendOn` map
  of the provider (see the harness-providers spec).
- A gate hook gives an `err` whose `suspend` flag is true (see the host-hooks spec). The reason is the `reason` of that
  `GateFailure`. The provider changes such a failure of `resolveRequestHeaders` into a `suspend` error. A refused spawn
  carries the flag and the reason in its `labels_refused` variant (see the sandbox-labels spec).

If a gate hook gives an `err` whose `suspend` flag is false, the operation MUST fail with the reason. The operation
MUST NOT suspend. The harness MUST identify a suspension only from the kind of the error or from the `suspend` flag.
The harness MUST NOT identify a suspension from the text of an error message.

#### Scenario: A suspend error of a model request suspends the step

- **GIVEN** a provider whose `suspendOn` map is `{ 402: "payment_required" }`
- **WHEN** a model request of a sandbox step fails with the status `402`
- **THEN** the step suspends with the reason `payment_required`

#### Scenario: A gate failure with the suspend flag suspends the operation

- **GIVEN** a `resolveSandboxLabels` hook that gives `err({ reason: "account_frozen", suspend: true })`
- **WHEN** a sandbox step spawns its sandbox
- **THEN** the client calls no backend, and the step suspends with the reason `account_frozen`

#### Scenario: A gate failure without the suspend flag fails the operation

- **GIVEN** a `RunCharge.open` hook that gives `err({ reason: "charge_refused", suspend: false })`
- **WHEN** an analysis run starts
- **THEN** the run fails with the reason `charge_refused`, and the status of the analysis does not change

#### Scenario: The text of an error message does not start a suspension

- **GIVEN** a model request that fails with the status `400` and a response body with the text `budget exceeded`
- **WHEN** the harness examines the failure
- **THEN** no suspension starts

### Requirement: The owner of the result of a workflow selects the mechanism of a suspension

The owner of the result of a workflow MUST select the mechanism of a suspension. There are two kinds of owner.

`executeAnalysis`, `sandbox-step`, and `data-profile` are durable owners. The result of each goes to stored state.
When a durable owner suspends, it MUST record the reason in its stored state. Then it MUST end in the DBOS state
`CANCELLED`, and never in the state `ERROR`, because `resumeWorkflow` reads the state `CANCELLED`.

`derive-table-exec` and `extract-values` have a live caller. A chat turn awaits the result of each, and nothing reads
the result after that turn. When such a workflow suspends, it MUST NOT cancel. It MUST return
`err({ kind: "suspended", reason })` as its value. The tool that awaits the workflow MUST report the reason.

#### Scenario: A sandbox step that suspends ends canceled

- **GIVEN** a `sandbox-step` child workflow
- **WHEN** its model request fails with a `suspend` error with the reason `payment_required`
- **THEN** the step row records the reason, and the child workflow ends in the DBOS state `CANCELLED`

#### Scenario: A data profile that suspends ends canceled

- **GIVEN** a `data-profile` workflow
- **WHEN** its model request fails with a `suspend` error with the reason `payment_required`
- **THEN** the workflow records the reason, and it ends in the DBOS state `CANCELLED`

#### Scenario: A workflow with a live caller gives the suspension as a value

- **GIVEN** a chat turn whose tool awaits `derive-table-exec`
- **WHEN** a gate failure with the reason `account_frozen` and the suspend flag stops the spawn of the workflow
- **THEN** the workflow does not cancel, and it returns `err({ kind: "suspended", reason: "account_frozen" })`
- **AND** the tool reports the reason `account_frozen`

### Requirement: One function marks the analysis as suspended

For each suspension of an analysis run or of a data profile, the harness MUST mark the analysis as suspended through
one function. The function MUST set the status of the analysis to `suspended_insufficient_funds` for each reason. This
literal is the name of the one suspended state. Thus no data migration is necessary.

A workflow with a live caller MUST NOT mark the analysis. The tool that awaits the workflow reports the suspension to
the conversation agent, and the agent selects the next step.

A chat turn is not a workflow. If a model request of a chat turn fails with a `suspend` error, the turn MUST fail with
the reason. The turn MUST NOT mark the analysis.

#### Scenario: A suspension of an analysis run marks the analysis

- **GIVEN** an analysis run whose sandbox step suspends with the reason `payment_required`
- **WHEN** the run ends
- **THEN** the status of the analysis is `suspended_insufficient_funds`

#### Scenario: A suspension of a workflow with a live caller does not mark the analysis

- **GIVEN** an analysis with the status `active`, and a chat turn whose tool awaits `extract-values`
- **WHEN** the workflow suspends with the reason `quota_exhausted`
- **THEN** the tool reports the reason `quota_exhausted`, and the status of the analysis does not change

#### Scenario: The status literal does not change with the reason

- **GIVEN** one analysis that suspends with the reason `payment_required`, and one that suspends with the reason `quota_exhausted`
- **WHEN** the function marks each analysis
- **THEN** the status of each analysis is `suspended_insufficient_funds`

#### Scenario: A suspend error in a chat turn does not mark the analysis

- **GIVEN** an analysis with the status `active`
- **WHEN** a model request of a chat turn fails with a `suspend` error with the reason `payment_required`
- **THEN** the turn fails with the reason `payment_required`, and the status of the analysis does not change

### Requirement: A sandbox step sends a typed suspension to its parent

Before a `sandbox-step` child cancels itself for a suspension, it MUST send a typed suspension message to its parent.
The child MUST send the message on the DBOS message topic `child-suspended`, which replaces the topic
`child-budget-exceeded`. The message MUST carry its kind, the id of the child workflow, the step id, and the reason.

The parent MUST identify the settlement of a child as a suspension from the kind of this message. The parent MUST NOT
compare a reason string to identify a suspension. After a suspension, the parent MUST cancel the in-flight sibling
steps (see the harness-durable-runtime spec).

#### Scenario: The parent identifies a suspension from the kind of the message

- **GIVEN** an analysis run with two in-flight steps
- **WHEN** one child sends a typed suspension with the reason `quota_exhausted`, and then it cancels itself
- **THEN** the parent identifies the settlement of that child as a suspension
- **AND** the parent cancels the other in-flight step

#### Scenario: A reason string alone is not a suspension

- **GIVEN** an analysis run with two in-flight steps
- **WHEN** one child fails with the error text `budget_exceeded`, and it sends no typed suspension
- **THEN** the parent records a failed step, and the other in-flight step continues

### Requirement: The harness carries the reason of a suspension to each place that records it

The harness MUST carry the reason of a suspension as the host gives it. The harness MUST NOT compare the reason to a
value, and it MUST NOT select a path from the reason (see the host-hooks spec). The harness MUST carry the reason to
each of these places:

- The `error` and the `lastErrorClass` of the step row.
- The failure reason of the run, which the run row keeps in `error`.
- `RunCharge.close`, which takes the outcome
  `{ kind: "ok" | "error" | "canceled" } | { kind: "suspended"; reason: string }`.
- The `cause` label of the metric of a canceled child, `cortex.workflow.parent.cancelled_children`.
- The failure code of the chat event, which is the `reason` of `ChatErrorEvent`.

#### Scenario: Each place gets the reason of the host

- **GIVEN** a provider whose `suspendOn` map is `{ 402: "budget_exceeded" }`, and an analysis run with two in-flight steps
- **WHEN** a model request of one step fails with the status `402`
- **THEN** the step row of that step has `error` and `lastErrorClass` equal to `budget_exceeded`
- **AND** the failure reason of the run is `budget_exceeded`
- **AND** `RunCharge.close` gets the outcome `{ kind: "suspended", reason: "budget_exceeded" }`
- **AND** the metric of the canceled sibling has the `cause` label `budget_exceeded`

#### Scenario: A new reason goes to each place with no change

- **GIVEN** a provider whose `suspendOn` map is `{ 429: "quota_exhausted" }`
- **WHEN** a model request of a sandbox step fails with the status `429`
- **THEN** the step row has `error` equal to `quota_exhausted`
- **AND** `RunCharge.close` gets the outcome `{ kind: "suspended", reason: "quota_exhausted" }`

#### Scenario: The default map gives no budget word

- **GIVEN** a provider with no `suspendOn` map
- **WHEN** a model request of a sandbox step fails with the status `402`
- **THEN** the step row has `error` equal to `payment_required`, and no place gets the text `budget_exceeded`
