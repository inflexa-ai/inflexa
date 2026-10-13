## MODIFIED Requirements

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- the attention read (`/api/v1/attention`): the work that waits for the person, over each analysis
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, and the asks
- the runs of `{A}`: the runs, one run, its stream, its synthesis, its cancel, and its seen mark
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

### Requirement: The server lists the artifact ledger of an analysis

`GET {A}/artifacts` MUST give one page of the artifact ledger of the analysis in the list shape, with the key `artifacts`. Each item MUST carry these fields:

- `path`, relative to the workspace folder of the analysis. `GET {A}/files?path=` takes the same form.
- `size`, in bytes
- `fileType`, or `null`
- `role`, `input` or `step_output`
- `runId` and `stepId`, or `null`
- `createdAt`, the time of the first registration of the path

The query values `runId`, `stepId`, and `fileType` MUST each select the rows with that exact value. The query value `q` MUST select the rows whose path holds the text, with no regard to case. An absent or empty value MUST select each row. The filters MUST combine with AND, and `total` MUST count the rows that they select.

The `sort` query value MUST select the order. `path` orders by the path, and it is the default. `recent` orders by `createdAt`, newest first, and the path breaks a tie. An absent or empty `sort` MUST select the default. A different value MUST give 400 `validation_error` with the field error under `sort`.

Each request MUST send one paged read of the harness ledger, with the limit and the offset of the page. The count of its statements MUST NOT depend on the page size. The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`. A failed ledger read MUST give 500 `internal_error`.

#### Scenario: The volcano figures of each run

- **GIVEN** analysis `a1` with a volcano figure in run `r1`, a volcano figure in run `r2`, and a volcano table of the type `output`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?fileType=figure&q=volcano`
- **THEN** the server answers with the two figures, each with its `runId` and its `stepId`, and `total` is 2

#### Scenario: The newest artifacts first

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?sort=recent`
- **THEN** the item with the newest `createdAt` comes first

#### Scenario: A bad sort value

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?sort=size`
- **THEN** the server answers 400 `validation_error` with a field error under `sort`

#### Scenario: One read for each page

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?page=2&perPage=50`
- **THEN** the server sends one ledger read with the limit 50 and the offset 100

### Requirement: A run summary gives the artifact count of the run

Each run of `GET {A}/runs` and the run of `GET {A}/run/:runId` MUST carry `artifactCount`, the count of the step outputs that the run registered. A run with no step output MUST give 0. This is the count of the run-completed card.

The runs of one page MUST get their counts from one grouped read of the harness, whatever the page size. A failed count read MUST NOT fail the response. Then `artifactCount` MUST be absent on each run of the response, and the failure MUST go to the log.

#### Scenario: The counts of a page of runs

- **GIVEN** run `r1` with 3 step outputs and run `r2` with none
- **WHEN** a client lists the runs of the analysis
- **THEN** `r1` has `artifactCount` 3 and `r2` has `artifactCount` 0
- **AND** the server sends one count read for the page

#### Scenario: A failed count read

- **GIVEN** a count read that fails
- **WHEN** a client lists the runs of the analysis
- **THEN** the server answers 200, and no run has `artifactCount`

### Requirement: The server gives the synthesis of a run

`GET {A}/run/:runId/synthesis` MUST give `{ status, reason, synthesis }`:

- `status` is the synthesis outcome of the run row: `produced`, `skipped_no_summaries`, `skipped_blocker`, `failed`, or `null` when the row records no outcome.
- `reason` is the synthesis reason of the run row, or `null`.
- `synthesis` is the flat `data-run-synthesis` part of the synthesis record of the run, with the references of each finding. It is the part that the run stream carries.

The run row is the authority on whether a synthesis exists. Thus the server MUST read the record only when `status` is `produced`, and `synthesis` MUST be `null` for each other status. When `status` is `produced`, `synthesis` MUST be `null` in these cases, and the server MUST log a warning:

- the workspace folder of the analysis does not resolve, or does not exist
- the record is absent, is not readable, holds more than 1 MiB, or fails the stored synthesis schema

A run of a different analysis, and an id that names no run, MUST get 404 `not_found`. The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`. A failed read of the run row MUST give 500 `internal_error`.

#### Scenario: A produced synthesis

- **GIVEN** run `r1` whose synthesis outcome is `produced`, with its record on disk
- **WHEN** a client sends `GET /api/v1/analyses/a1/run/r1/synthesis`
- **THEN** the server answers with `status` `produced` and the synthesis part, and each finding has its references

#### Scenario: A skipped synthesis

- **GIVEN** run `r1` whose synthesis outcome is `skipped_blocker` with a reason
- **WHEN** a client reads the synthesis of `r1`
- **THEN** the server answers with `status` `skipped_blocker`, the reason, and `synthesis` `null`

#### Scenario: A record in a folder that is not writable

- **GIVEN** run `r1` whose outcome is `produced`, with its record in a workspace folder that is readable but not writable
- **WHEN** a client reads the synthesis of `r1`
- **THEN** the server answers with the synthesis part

#### Scenario: A produced outcome with no record

- **GIVEN** run `r1` whose outcome is `produced`, and whose record is gone from the disk
- **WHEN** a client reads the synthesis of `r1`
- **THEN** the server answers 200 with `status` `produced` and `synthesis` `null`

#### Scenario: A run of a different analysis

- **WHEN** a client reads the synthesis of a run of analysis `a2` under analysis `a1`
- **THEN** the server answers 404 `not_found`
