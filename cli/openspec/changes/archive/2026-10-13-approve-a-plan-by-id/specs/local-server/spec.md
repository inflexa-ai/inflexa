# Spec Delta

## MODIFIED Requirements

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the desktop of the machine (`/api/v1/sandbox` and `/api/v1/open`): the sandbox readiness of the machine, and the folder open
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- the attention read (`/api/v1/attention`): the work that waits for the person, over each analysis
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, and the asks
- the runs of `{A}`: the runs, one run, its stream, its synthesis, its cancel, its seen mark, one plan, and its approval
- the profile of `{A}`: the chat context, the data profile, the sandbox readiness, and the farm heal and link
- the records of `{A}`: the usage, the provenance, the artifacts, and the bytes of a file
- the package store: the state, the transfers, and the failed flights (retry and delete)
- the browser sign-in (`/api/v1/session`): the nonce and the sign-in link
- the file system (`/api/v1/fs`): the home folder and the list of a folder

The `store` and `sandbox` commands run in their own process, with no server. Thus the server MUST NOT give a route for these operations:

- the inventory of the store
- an add
- a cancel of the catalog transfer
- a reclamation
- the report of `inflexa sandbox status`: the images with their digests, the transfers, and the store summary

The sandbox readiness of the machine (`GET /api/v1/sandbox`) is not that report. A page reads it, and the `sandbox status` command does not use it.

A route that does the same work as a Cortex route MUST keep the path tail of Cortex without the organization segment. Path segments MUST be kebab-case, a run list MUST be `runs`, and one run MUST be `run/:runId`. JSON fields MUST be camelCase, and timestamps MUST be ISO 8601 strings. The server MUST map each harness row to its wire type, and a client MUST never get a harness row type.

A client can call a route with no request body. If such a route can work for longer than 10 s before its response, it MUST lift the idle timeout of the connection for that request. `Bun.serve` closes a silent connection at 10 s only when its request has no body.

#### Scenario: A thread route keeps the Cortex tail

- **WHEN** a client lists the threads of analysis `a1`
- **THEN** the path is `/api/v1/analyses/a1/threads`, the Cortex tail with no organization segment

#### Scenario: The server gives no reclaim route

- **WHEN** a client sends `POST /api/v1/store/reclaim`
- **THEN** the server answers 404 `not_found`

## ADDED Requirements

### Requirement: The server approves a plan by its id

`POST {A}/plans/:planId/approve` MUST approve the plan through the approval of the harness runtime, with the body `{ threadId }`. The server gives the local identity and the local auth, as the chat turn does. The route MUST NOT call a model.

The route MUST answer in this order:

1. 503 `draining` while the server stops, before it reads the body.
2. 400 `validation_error` for a body with no non-empty `threadId`.
3. 409 `busy` while a chat turn of the registry runs on the thread. The details carry `reasons: ["chat_turn"]`.
4. The outcome of the approval, below.

A success MUST answer 201 with `{ planId, runId, started, message }`. `started: false` means that a run of the plan is already active. The approval then records nothing, and `message` is `null`. Otherwise `message` is the record of the approval, with the shape of a message of `GET {T}/messages` and with no creation time. A success that started the run MUST note the activity of the analysis.

A refusal MUST answer as follows:

- 404 `not_found` for an unknown thread, an archived thread, or a thread of a different analysis
- 404 `not_found` for an unknown plan, or a plan of a different analysis
- 409 `conflict` with `details.reason` for each other refusal: `superseded`, `plan_invalid`, `packages_missing`, `not_authorized`, and `suspended`
- 500 `internal_error` for a failed store read or write, and for a failed start of the workflow

A `superseded` refusal MUST carry `details.supersededBy`, the id of the newest plan that revised the plan. A `plan_invalid` refusal carries `details.errors`. A `packages_missing` refusal carries `details.missing` and `details.collisions`, and `details.unavailable` when the store cannot answer.

The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`.

#### Scenario: A click on Approve starts the run

- **GIVEN** plan `pln-0000000a` of analysis `a1`, a live thread `t1`, and no active run of the plan
- **WHEN** a client sends `POST /api/v1/analyses/a1/plans/pln-0000000a/approve` with `{ "threadId": "t1" }`
- **THEN** the server answers 201 with the plan id, a new run id, `started: true`, and the record message

#### Scenario: A second click names the active run

- **GIVEN** plan `pln-0000000a` with the active run `r1`
- **WHEN** a client approves `pln-0000000a`
- **THEN** the server answers 201 with the run id `r1`, `started: false`, and `message: null`

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
