# Spec Delta

## MODIFIED Requirements

### Requirement: The server approves a plan by its id

`POST {A}/plans/:planId/approve` MUST approve the plan through the approval of the harness runtime, with the body `{ threadId, newestRunId }`. The server gives the local identity and the local auth, as the chat turn does. The route MUST NOT call a model.

`newestRunId` is the newest run of the plan that the client saw: the first id of the `runIds` of `GET {A}/plans/:planId`. It is `null` when that list was empty. The server MUST give it to the approval of the harness, which compares it with the newest run of the plan.

The route MUST answer in this order:

1. 503 `draining` while the server stops, before it reads the body.
2. 400 `validation_error` for a body with no non-empty `threadId`, or with a `newestRunId` that is absent, empty, or not a string or `null`.
3. 409 `busy` while a chat turn of the registry runs on the thread. The details carry `reasons: ["chat_turn"]`.
4. The outcome of the approval, below.

A success MUST answer 201 with `{ planId, runId, started, message }`. `started: false` means that the approval started no run. Then a run of the plan is active, or the newest run of the plan is not `newestRunId`, and `runId` names that run. The approval then records nothing, and `message` is `null`. Otherwise `message` is the record of the approval, with the shape of a message of `GET {T}/messages` and with no creation time. A success that started the run MUST note the activity of the analysis.

A refusal MUST answer as follows:

- 404 `not_found` for an unknown thread, an archived thread, or a thread of a different analysis
- 404 `not_found` for an unknown plan, or a plan of a different analysis
- 404 `not_found` for a `newestRunId` that is not `null` when the plan has no run
- 409 `conflict` with `details.reason` for each other refusal: `superseded`, `plan_invalid`, `packages_missing`, `not_authorized`, and `suspended`
- 500 `internal_error` for a failed store read or write, and for a failed start of the workflow

A `superseded` refusal MUST carry `details.supersededBy`, the id of the newest plan that revised the plan. A `plan_invalid` refusal carries `details.errors`. A `packages_missing` refusal carries `details.missing` and `details.collisions`, and `details.unavailable` when the store cannot answer.

The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`.

#### Scenario: A click on Approve starts the run

- **GIVEN** plan `pln-0000000a` of analysis `a1`, a live thread `t1`, and no run of the plan
- **WHEN** a client sends `POST /api/v1/analyses/a1/plans/pln-0000000a/approve` with `{ "threadId": "t1", "newestRunId": null }`
- **THEN** the server answers 201 with the plan id, a new run id, `started: true`, and the record message

#### Scenario: A second click names the active run

- **GIVEN** plan `pln-0000000a` with the active run `r1`
- **WHEN** a client approves `pln-0000000a` with the `newestRunId` `r1`
- **THEN** the server answers 201 with the run id `r1`, `started: false`, and `message: null`

#### Scenario: A stale view names the newest run

- **GIVEN** plan `pln-0000000a` with the run `r1`, which ended
- **WHEN** a client approves `pln-0000000a` with the `newestRunId` `null`
- **THEN** the server answers 201 with the run id `r1`, `started: false`, and `message: null`, and no run starts

#### Scenario: A view of the newest run runs the plan again

- **GIVEN** plan `pln-0000000a` with the run `r1`, which ended
- **WHEN** a client approves `pln-0000000a` with the `newestRunId` `r1`
- **THEN** the server answers 201 with a new run id, `started: true`, and the record message

#### Scenario: A view of a run that the plan does not have is not found

- **GIVEN** plan `pln-0000000a` with no run
- **WHEN** a client approves `pln-0000000a` with the `newestRunId` `r9`
- **THEN** the server answers 404 `not_found`, and no run starts

#### Scenario: A body with no newest run id is refused

- **WHEN** a client approves a plan with the body `{ "threadId": "t1" }`
- **THEN** the server answers 400 `validation_error`, and no run starts

#### Scenario: A replaced plan is a conflict

- **GIVEN** plan `pln-0000000a`, and plan `pln-0000000b` that revised it
- **WHEN** a client approves `pln-0000000a`
- **THEN** the server answers 409 `conflict` with `details.reason` `superseded` and `details.supersededBy` `pln-0000000b`

#### Scenario: A running turn holds the thread

- **GIVEN** a chat turn that runs on thread `t1`
- **WHEN** a client approves a plan on `t1`
- **THEN** the server answers 409 `busy`, and no run starts

#### Scenario: An unknown thread is not found

- **WHEN** a client approves a plan on a thread id that analysis `a1` does not hold
- **THEN** the server answers 404 `not_found`

#### Scenario: A stop refuses an approval

- **GIVEN** a server that stops
- **WHEN** a client approves a plan
- **THEN** the server answers 503 `draining`, and no run starts
