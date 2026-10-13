# Spec Delta

## MODIFIED Requirements

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- the attention read (`/api/v1/attention`): the work that waits for the person, over each analysis
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, and the asks
- the runs of `{A}`: the runs, one run, its stream, its synthesis, its cancel, its seen mark, and one plan
- the profile of `{A}`: the chat context, the data profile, the sandbox readiness, and the farm heal and link
- the records of `{A}`: the usage, the provenance, the artifacts, and the bytes of a file
- the package store: the state, the transfers, and the failed flights (retry and delete)
- the browser sign-in (`/api/v1/session`): the nonce and the sign-in link
- the file system (`/api/v1/fs`): the home folder and the list of a folder

The `store` commands run in their own process, with no server. Thus the server MUST NOT give a route for these operations:

- the inventory of the store
- an add
- a cancel of the catalog transfer
- a reclamation
- the sandbox status

A route that does the same work as a Cortex route MUST keep the path tail of Cortex without the organization segment. Path segments MUST be kebab-case, a run list MUST be `runs`, and one run MUST be `run/:runId`. JSON fields MUST be camelCase, and timestamps MUST be ISO 8601 strings. The server MUST map each harness row to its wire type, and a client MUST never get a harness row type.

A client can call a route with no request body. If such a route can work for longer than 10 s before its response, it MUST lift the idle timeout of the connection for that request. `Bun.serve` closes a silent connection at 10 s only when its request has no body.

#### Scenario: A thread route keeps the Cortex tail

- **WHEN** a client lists the threads of analysis `a1`
- **THEN** the path is `/api/v1/analyses/a1/threads`, the Cortex tail with no organization segment

#### Scenario: The server gives no reclaim route

- **WHEN** a client sends `POST /api/v1/store/reclaim`
- **THEN** the server answers 404 `not_found`

## ADDED Requirements

### Requirement: A run read gives the plan of the run

Each run of `GET {A}/runs` and the run of `GET {A}/run/:runId` MUST carry `planId`. It is the plan id of the run row, or `null` for a run with no plan. The list MUST send no read for this field.

`GET {A}/run/:runId` MUST carry `plan`, as `{ planId, steps }`. `steps` MUST hold one entry for each step of the stored plan, in the order of the plan. Each entry MUST carry these fields:

- `id`, the step id
- `name`, the step name
- `agent`, the agent of the step, or `"unknown"` when the plan names no agent
- `dependsOn`, the step ids that the step depends on
- `level`, the level of the step in the plan graph, as the `data-dag-state` part gives it

`plan` MUST be `null` in these cases:

- the run has no plan
- the plan is gone, or its read failed
- the plan document fails the stored plan schema, or its steps do not form a valid graph

A plan step with no ledger row MUST be in `plan.steps`, and it MUST NOT be in `steps`. Such a step did not start. The server MUST read the stored plan one time for each request. A failed plan read MUST NOT fail the response.

#### Scenario: The plan graph of a finished run

- **GIVEN** run `r1` of plan `p1`, with steps `T1S1` and `T1S2`, where `T1S2` depends on `T1S1`
- **WHEN** a client sends `GET /api/v1/analyses/a1/run/r1`
- **THEN** `planId` is `p1`, and `plan.steps` gives `T1S1` at level 0 and `T1S2` at level 1, each with its agent and its dependencies

#### Scenario: A plan step that did not start

- **GIVEN** run `r1` whose plan has step `T1S2`, and no ledger row of `T1S2`
- **WHEN** a client reads run `r1`
- **THEN** `plan.steps` has `T1S2`, and `steps` does not have it

#### Scenario: A run whose plan is gone

- **GIVEN** run `r1` with plan id `p1`, and no stored plan `p1`
- **WHEN** a client reads run `r1`
- **THEN** the server answers 200, `planId` is `p1`, and `plan` is `null`

#### Scenario: The plan id of each run of a list

- **GIVEN** run `r1` of plan `p1`, and run `r2` with no plan
- **WHEN** a client lists the runs of the analysis
- **THEN** `r1` has `planId` `p1`, and `r2` has `planId` `null`

### Requirement: The server gives one plan with its lineage and its runs

`GET {A}/plans/:planId` MUST give `{ plan, parentPlanId, supersededBy, runIds, hasMoreRuns }`:

- `plan` is the `data-plan` part of the stored plan, with the title of the plan. It is `null` when the plan document does not give a part, and the server MUST then log a warning.
- `parentPlanId` is the id of the plan that this plan revised, or `null`.
- `supersededBy` is the id of the newest plan of the analysis that revised this plan, or `null`.
- `runIds` holds the ids of the runs of the plan, newest first. It holds at most 100 ids.
- `hasMoreRuns` is `true` when the plan has more than 100 runs, else `false`.

The server MUST send at most two harness reads for each request, whatever the count of the runs of the plan.

A plan of a different analysis, and an id that names no plan, MUST get 404 `not_found`. A plan whose document does not give a part is not absent, thus it MUST get 200 with its lineage and its runs. The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`. A failed read MUST give 500 `internal_error`.

#### Scenario: A revised plan names the newer plan

- **GIVEN** plan `pln-0000000a`, and plan `pln-0000000b` that revised it
- **WHEN** a client sends `GET /api/v1/analyses/a1/plans/pln-0000000a`
- **THEN** `supersededBy` is `pln-0000000b`, and `parentPlanId` is `null`

#### Scenario: The revision names its parent

- **WHEN** a client reads plan `pln-0000000b`
- **THEN** `parentPlanId` is `pln-0000000a`, and the `plan` part has the same `parentPlanId`

#### Scenario: The runs of a plan

- **GIVEN** plan `p1` with runs `r1` and `r2`, where `r2` started later
- **WHEN** a client reads plan `p1`
- **THEN** `runIds` is `r2`, then `r1`

#### Scenario: A plan of a different analysis

- **WHEN** a client reads a plan of analysis `a2` under analysis `a1`
- **THEN** the server answers 404 `not_found`

#### Scenario: A plan whose document does not parse

- **GIVEN** plan `p1` with runs, whose document fails the stored plan schema
- **WHEN** a client reads plan `p1`
- **THEN** the server answers 200, `plan` is `null`, and `runIds` gives the runs of `p1`

#### Scenario: A plan with more runs than the limit

- **GIVEN** plan `p1` with 101 runs
- **WHEN** a client reads plan `p1`
- **THEN** `runIds` holds the 100 newest ids, and `hasMoreRuns` is `true`
