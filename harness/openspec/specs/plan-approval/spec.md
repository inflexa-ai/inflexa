# plan-approval Specification

## Purpose

The approval of a stored plan by its id. A host starts the run of an approved plan with no model call, and the thread and the provenance record the approval.

## Requirements

### Requirement: The harness launches a stored plan through one function

The harness MUST give a function that launches the run of one stored plan. It takes a session with an analysis scope and the plan id. It gives the run id and a `started` flag, or a typed refusal. The function MUST NOT throw for any outcome below.

The function MUST do these steps in this order:

1. Read the plan under the analysis of the session. An unknown plan, or a plan of a different analysis, gives `plan_not_found`.
2. Parse and validate the plan. A plan that fails the stored plan schema or the plan validation gives `plan_invalid`, with the errors of the validation.
3. Read the active run of the plan. When one exists, give its run id with `started: false`. The function then links nothing, reserves nothing, and authorizes nothing.
4. Link the packages of the plan through the farm link function of the host, when the host gives one. A pool miss, a collision, or an unavailable store gives `packages_missing`, with the missing entries, the collisions, and the reason of an unavailable store. No run row exists after this refusal.
5. Reserve a run row with a new run id, the plan id, and the thread id of the scope. A collision with a concurrent launch of the same plan gives the active run with `started: false`. When the collision finds no active run, the function gives `store_failed`.
6. Authorize the run. A `suspended` refusal marks the run `suspended_insufficient_funds`, suspends the analysis, and gives `suspended` with the reason. Each other refusal marks the run `failed` and gives `not_authorized` with the reason. A failed write of the run status does not change the refusal. A failed suspension of the analysis gives `store_failed`.
7. Start the workflow under the run id. A failed start revokes the authorization, marks the run `failed`, and gives `launch_failed`. A failed write of the run status does not change this refusal either.
8. Give the run id with `started: true`.

A failed store read or write gives `store_failed`. The function emits no chat part.

#### Scenario: A launch starts the run of a stored plan

- **GIVEN** a valid stored plan `pln-0000000a` of analysis `a1`, with no active run
- **WHEN** a host launches `pln-0000000a` under a session of `a1` and thread `t1`
- **THEN** the result has a new run id and `started: true`
- **AND** the run row holds the plan id and the thread id `t1`

#### Scenario: A plan with an active run starts no second run

- **GIVEN** plan `pln-0000000a` with the active run `r1`
- **WHEN** a host launches `pln-0000000a`
- **THEN** the result has the run id `r1` and `started: false`, and no new run row exists

#### Scenario: An unknown plan is refused

- **WHEN** a host launches a plan id that analysis `a1` does not hold
- **THEN** the result is the refusal `plan_not_found`, and no run row exists

#### Scenario: A package miss leaves no run behind

- **GIVEN** a plan whose package the pool does not hold
- **WHEN** a host launches the plan
- **THEN** the result is the refusal `packages_missing` with the missing entry, and no run row exists

#### Scenario: A refused authorization ends the reserved run

- **GIVEN** a run authorizer that refuses the run with a reason that is not a suspension
- **WHEN** a host launches the plan
- **THEN** the result is the refusal `not_authorized` with the reason, and the run row is `failed`

### Requirement: The plan mode of execute_analysis keeps its failure protocol

The plan mode of `execute_analysis` MUST launch through the launch function of a stored plan. The tool MUST keep the outcome that it gave before for each case:

- an unknown plan, an invalid plan, a package refusal, a store failure, and a failed start fail the call with the same error as before
- an authorization refusal and a suspension give the same error result text as before
- a new run and an active run each emit the run card and give the run id with `status: "in_progress"`

The ad hoc mode MUST keep its behavior.

#### Scenario: An unknown plan fails the tool call

- **WHEN** the agent calls `execute_analysis` in plan mode with an unknown plan id
- **THEN** the call fails with the plan-not-found error, and no run row exists

#### Scenario: A refused authorization gives the error result

- **GIVEN** a run authorizer that refuses the run
- **WHEN** the agent calls `execute_analysis` in plan mode
- **THEN** the tool gives the error result "The run was not authorized: <reason>"

### Requirement: The harness approves a plan by its id

The harness MUST give a function that approves a plan by its id. It takes the analysis id, the thread id, the plan id, and the identity and the auth of the host. It gives `{ planId, runId, started, message }`, or a typed refusal. The function MUST NOT throw for any outcome below, and it MUST NOT call a model.

The function MUST refuse these cases before it launches anything:

- `thread_not_found`: the thread is absent, archived, or of a different analysis
- `plan_not_found`: the plan is unknown, or of a different analysis
- `superseded`: a newer plan of the analysis names the plan as its parent. The refusal carries `supersededBy`, the id of the newest such plan.

Then the function MUST launch the plan through the launch function of a stored plan. The session of the launch MUST hold the identity and the auth that the host gave, and the scope of the analysis and the thread. Its provenance MUST be the agent `plan-approval`, with a call path of that one entry. A refusal of the launch MUST pass through as the refusal of the approval.

The function MUST read the time of the approval before the launch. When the launch gives `started: true`, the function MUST emit one `approve-plan` session event with that time, and then append the approval record to the thread. The result then holds the display message of the record as `message`.

When the launch gives `started: false`, a run of the plan is already active. The function MUST NOT emit an event, and it MUST NOT append a record. `message` is then `null`.

A refusal emits nothing and appends nothing. A failed append of the record MUST NOT fail the approval, because the run started. The function then logs the failure, and `message` is `null`.

#### Scenario: An approval starts the run with no model call

- **GIVEN** a valid plan `pln-0000000a` of analysis `a1`, a live thread `t1` of `a1`, and no active run of the plan
- **WHEN** a host approves `pln-0000000a` on `t1`
- **THEN** the result has a new run id, `started: true`, and the display message of the record
- **AND** the run row holds the thread id `t1`
- **AND** no chat provider receives a request

#### Scenario: A replaced plan is refused

- **GIVEN** plan `pln-0000000a`, and plan `pln-0000000b` whose parent is `pln-0000000a`
- **WHEN** a host approves `pln-0000000a`
- **THEN** the result is the refusal `superseded` with `supersededBy` `pln-0000000b`
- **AND** no run row exists, the thread holds no new row, and the provenance sink receives no event

#### Scenario: A plan of a different analysis is refused

- **WHEN** a host approves a plan of analysis `a2` under analysis `a1`
- **THEN** the result is the refusal `plan_not_found`

#### Scenario: An archived thread is refused

- **WHEN** a host approves a plan on an archived thread of the analysis
- **THEN** the result is the refusal `thread_not_found`, and no run row exists

#### Scenario: A second approval of an active plan records nothing

- **GIVEN** plan `pln-0000000a` with the active run `r1`
- **WHEN** a host approves `pln-0000000a`
- **THEN** the result has the run id `r1`, `started: false`, and `message: null`
- **AND** the thread holds no new row, and the provenance sink receives no event

#### Scenario: The approval event comes with the time before the launch

- **WHEN** a host approves a plan and the launch starts the run
- **THEN** the provenance sink receives one `approve-plan` event with the analysis id, the thread id, the plan id, the run id, and `atMs`
- **AND** `atMs` is not later than the start of the launch

### Requirement: The approval record tells the model that the run started

The approval record MUST be one host record in the thread. It opens no turn and makes no turn record, the same as each host record.

The model message of the record MUST be the synthetic record text `The person approved plan <planId>. Run <runId> started.`, with the ids of the approval. The model message MUST hold no time.

The display message of the record MUST have the role `system`. It MUST hold the `data-plan-approval` part, and then the `data-run-card` part of the run. It holds no text part. The card read gives a card for each plan that the launch accepted. A failed card read leaves the card out, and the function logs the failure.

The record append MUST accept display parts in place of the display text. A record append with no display parts MUST keep the display text, as before.

The `message` of the approval result MUST equal the message that the transcript read gives for the record. The one exception is the creation time, which the result does not carry.

#### Scenario: The next turn reads the approval

- **GIVEN** an approval of `pln-0000000a` that started run `r1` on thread `t1`
- **WHEN** the next turn of `t1` loads its history
- **THEN** the history holds the record text `The person approved plan pln-0000000a. Run r1 started.`, with no time

#### Scenario: The transcript shows the approval and the run card

- **GIVEN** an approval of `pln-0000000a` that started run `r1` on thread `t1`
- **WHEN** a host reads the transcript of `t1`
- **THEN** the last message has the role `system`, a `data-plan-approval` part with `pln-0000000a` and `r1`, and a `data-run-card` part of `r1`

### Requirement: The data-plan-approval part records an approval

The chat part `data-plan-approval` MUST carry these fields:

- `planId`, with the plan id shape `pln-<8hex>`
- `runId`, the run that the approval started
- `approvedAt`, the ISO 8601 form of the same instant as the `atMs` of the approval event

The part schema MUST validate the part, and it MUST refuse an `approvedAt` that is not an ISO 8601 date and time. The part registry MUST list it as a part that the conversation emits and the conversation shows, not transient and not reconciling. The stored display vocabulary MUST hold it, thus a stored part reads back field for field.

#### Scenario: A stored approval part round-trips

- **WHEN** a display message with a `data-plan-approval` part is stored and read back
- **THEN** the part equals the stored part, field for field

### Requirement: The runtime binds the approval, and the root exports it

`CoreRuntime` MUST carry the approval function, bound over the deps of the conversation agent: the pool, the registered analysis workflow, the run authorizer, the run launcher, the resource policy, the farm link function, the provenance sink, and the logger. Thus the approval and the tool launch a plan with the same host functions.

The package root MUST export the launch function, the approval function, their input, result, and refusal types, and the type of the `data-plan-approval` part.

#### Scenario: An embedder approves through the runtime

- **WHEN** an embedder calls the approval of the assembled runtime with a thread, a plan, an identity, and an auth
- **THEN** the run starts through the same run launcher that the conversation agent uses
