## MODIFIED Requirements

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the desktop of the machine (`/api/v1/sandbox` and `/api/v1/open-directory`): the sandbox readiness of the machine, and the folder open
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- the attention read (`/api/v1/attention`): the work that waits for the person, over each analysis
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, the asks, and the access of a report-session page
- the runs of `{A}`: the runs, one run, its stream, its synthesis, its cancel, its seen mark, the plans, one plan, and its approval
- the profile of `{A}`: the chat context, the data profile, the sandbox readiness, and the farm heal and link
- the records of `{A}`: the usage, the provenance, and the artifacts
- the package store: the state, the transfers, and the failed flights (retry and delete)
- the browser sign-in (`/api/v1/session`): the nonce and the sign-in link
- the file system (`/api/v1/fs`): the home folder, the list of a folder, the bytes of a file, and the preview of a file or a folder
- the picker of the file system (`/api/v1/fs`): the pins, the recent files, and the places of the sidebar

These routes MUST be in the file system group: each folder list, each read of the bytes of a file, each preview, and each search of the file system. A route of a different group can read the disk for its own work, for example `POST {A}/artifacts/resolve`. No route under `/api/v1/analyses/:analysisId` gives the bytes of a file.

The page of a report session (`/report-sessions/...`) is the one route of data outside `/api/v1`. A page grant guards it, and no API credential does.

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

#### Scenario: The access route keeps the tail of the managed mint

- **WHEN** a client asks for the access of the page of report session `t1` of analysis `a1`
- **THEN** the path is `/api/v1/analyses/a1/report-sessions/t1/access`

#### Scenario: The server gives no reclaim route

- **WHEN** a client sends `POST /api/v1/store/reclaim`
- **THEN** the server answers 404 `not_found`

#### Scenario: The server gives no file route of an analysis

- **WHEN** a client sends `GET /api/v1/analyses/a1/files?path=runs/R/A/figures/volcano.png`
- **THEN** the server answers 404 `not_found`, because no route has the path

#### Scenario: The picker routes are in the file system group

- **WHEN** a client reads the pins, the recent files, or the places of the picker
- **THEN** the paths are `/api/v1/fs/pins`, `/api/v1/fs/recents`, and `/api/v1/fs/places`

### Requirement: The server lists the artifact ledger of an analysis

`GET {A}/artifacts` MUST give one page of the artifact ledger of the analysis in the list shape, with the key `artifacts`. Each item MUST carry these fields:

- `path`, relative to the workspace folder of the analysis. The query value `path` takes the same form.
- `absolutePath`: the canonical path of the workspace folder joined with `path`. `GET /api/v1/fs/read?path=` takes this form. It is `null` when the server cannot locate the workspace folder. When the located folder does not exist on disk, the server joins the path of the folder as it located it.
- `size`, in bytes
- `fileType`, or `null`
- `kind` and `language`: the kind and the highlighter language of the file name of `path`, from the map of the file system routes. `kind` is `null` and `language` is `text` for a name that the map does not know.
- `role`, `input` or `step_output`
- `runId` and `stepId`, or `null`
- `createdAt`, the time of the first registration of the path

The server MUST locate the workspace folder one time for each request, not one time for each item. The search MUST NOT make a folder, and it MUST NOT record an anchor sighting. It can repair the stored path of a moved anchor, as each workspace lookup does. A workspace folder that the server cannot locate MUST NOT fail the request. A failed read of the database MUST give 500 `internal_error`.

The query values `runId`, `stepId`, and `fileType` MUST each select the rows with that exact value. The query value `path` MUST select the row whose path is equal to the value, and case is significant. The query value `q` MUST select the rows whose path holds the text, with no regard to case. An absent or empty value MUST select each row. The filters MUST combine with AND, and `total` MUST count the rows that they select.

The extension of a path is the text after the last dot of its file name, in lower case. A file name has no extension in each of these cases:

- It has no dot.
- Its only dot is its first character.
- It ends with a dot.

The query value `extension` MUST be a list of extensions with a comma between them, for example `png,svg`. It MUST select the rows whose path has one of these extensions, with no regard to case. The server MUST remove the spaces at the start and the end of each member, and it MUST ignore an empty member. A value with no member MUST select each row.

The response MUST add `extensionCounts` to the list shape. It MUST give one entry `{ extension, count }` for each extension that a selected row has, in the order of the extension. It MUST give one last entry with `extension` `null` for the selected rows that have no extension. It MUST give no entry with a count of 0. The counts MUST sum to `total`, and they MUST NOT depend on the page.

The query value `role` MUST select the rows with that role, `input` or `step_output`. An absent or empty `role` MUST select each row. A different value MUST give 400 `validation_error` with the field error under `role`, and the server MUST then send no ledger read. The filter applies to `total` and to `extensionCounts`, as each filter does. Each `step_output` row carries its run. Thus with `role=step_output` and no `runId`, `total` is equal to the sum of the `artifactCount` of the runs of the analysis.

The `sort` query value MUST select the order. `path` orders by the path, and it is the default. `recent` orders by `createdAt`, newest first, and the path breaks a tie. An absent or empty `sort` MUST select the default. A different value MUST give 400 `validation_error` with the field error under `sort`.

Each request MUST send one paged read of the harness ledger, with the limit and the offset of the page. The count of its statements MUST NOT depend on the page size. The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`. A failed ledger read MUST give 500 `internal_error`.

#### Scenario: The volcano figures of each run

- **GIVEN** analysis `a1` with a volcano figure in run `r1`, a volcano figure in run `r2`, and a volcano table of the type `output`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?fileType=figure&q=volcano`
- **THEN** the server answers with the two figures, each with its `runId` and its `stepId`, and `total` is 2

#### Scenario: An absolute path for each item

- **GIVEN** analysis `a1` whose workspace folder has the canonical path `<W>`, and the ledger row `runs/r1/s1/figures/volcano.png`
- **WHEN** a client lists the artifacts of `a1`
- **THEN** the item has `path` `runs/r1/s1/figures/volcano.png` and `absolutePath` `<W>/runs/r1/s1/figures/volcano.png`
- **AND** `GET /api/v1/fs/read?path=<W>/runs/r1/s1/figures/volcano.png` gives the bytes of the figure

#### Scenario: A workspace folder that the server cannot locate

- **GIVEN** analysis `a1` whose anchor folder is gone, and a ledger with rows for `a1`
- **WHEN** a client lists the artifacts of `a1`
- **THEN** the server answers 200, and each item has `absolutePath` `null`

#### Scenario: The newest artifacts first

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?sort=recent`
- **THEN** the item with the newest `createdAt` comes first

#### Scenario: A bad sort value

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?sort=size`
- **THEN** the server answers 400 `validation_error` with a field error under `sort`

#### Scenario: The run outputs of an analysis

- **GIVEN** analysis `a1` with one `input` row, two run outputs of run `r1`, and one run output of run `r2`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?role=step_output`
- **THEN** the server sends one ledger read with the role `step_output`
- **AND** it answers with the three run outputs, and `total` is 3

#### Scenario: A bad role value

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?role=output`
- **THEN** the server answers 400 `validation_error` with a field error under `role`
- **AND** the server sends no ledger read

#### Scenario: One read for each page

- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?page=2&perPage=50`
- **THEN** the server sends one ledger read with the limit 50 and the offset 100

#### Scenario: A link finds the run of a file

- **GIVEN** analysis `a1` with `runs/r1/s1/output/de.csv` and `runs/r2/s1/output/de.csv.bak`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?path=runs/r1/s1/output/de.csv`
- **THEN** the server answers with that one item, with `runId` `r1` and `stepId` `s1`, and `total` is 1

#### Scenario: The figures of a run by their extensions

- **GIVEN** run `r1` of analysis `a1` with `runs/r1/s1/figures/a.PNG`, `runs/r1/s1/figures/b.svg`, and `runs/r1/s1/output/c.csv`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?runId=r1&extension=png,%20SVG,`
- **THEN** the server sends one ledger read with the extensions `png` and `svg`
- **AND** it answers with the two figures, and `total` is 2

#### Scenario: The count of each extension of a run

- **GIVEN** run `r1` of analysis `a1` with two PNG files, one CSV file, and the file `README`
- **WHEN** a client sends `GET /api/v1/analyses/a1/artifacts?runId=r1&perPage=1`
- **THEN** the server answers with one item, and `total` is 4
- **AND** `extensionCounts` is `[{ "extension": "csv", "count": 1 }, { "extension": "png", "count": 2 }, { "extension": null, "count": 1 }]`

#### Scenario: The kind and the language of each row

- **GIVEN** analysis `a1` with the rows `runs/r1/s1/scripts/de.R`, `runs/r1/s1/figures/a.webp`, and `runs/r1/s1/output/notes.xyz`
- **WHEN** a client lists the artifacts of `a1`
- **THEN** `de.R` has the kind `code` and the language `r`
- **AND** `a.webp` has the kind `figure` and the language `text`
- **AND** `notes.xyz` has the kind `null` and the language `text`


## ADDED Requirements

### Requirement: The server lists the plans of an analysis

`GET {A}/plans` MUST give one page of the plans of the analysis in the list shape, with the key `plans`. The items MUST be in the order of the creation time, newest first, and the plan id MUST break a tie, highest first. Thus the first item of page 0 is the latest plan of the analysis. Each item MUST carry these fields:

- `planId`, the id of the plan
- `createdAt`, the creation time of the plan, ISO 8601
- `title`, the title of the plan with the spaces at the start and the end removed. It is `null` when the plan has no title or an empty title. This is the rule of the `planTitle` of a run summary.
- `parentPlanId`, the plan that this plan revised, or `null` for a first plan
- `supersededBy`, the newest plan of the analysis that revised this plan, or `null`. It is the `supersededBy` of `GET {A}/plans/:planId`.
- `newestRunId`, the id of the newest run of the plan, or `null` for a plan with no run. It is the first id of the `runIds` of `GET {A}/plans/:planId`.

`total` MUST count each plan of the analysis. The list MUST give each plan of the analysis, also a plan whose document gives no `data-plan` part. The list has no filter by thread. A plan of a different analysis MUST NOT be an item.

Each request MUST send one paged read of the harness plan store, with the limit and the offset of the page. The count of its statements MUST NOT depend on the page size. The route needs the harness runtime, thus it MUST answer 503 `unavailable` before the phase is `ready`. A failed read MUST give 500 `internal_error`.

#### Scenario: The latest plan in one request

- **GIVEN** plan `pln-0000000a` of analysis `a1`, and plan `pln-0000000b` that revised it later
- **WHEN** a client sends `GET /api/v1/analyses/a1/plans?perPage=1`
- **THEN** the one item is `pln-0000000b`, with `parentPlanId` `pln-0000000a` and `supersededBy` `null`
- **AND** `total` is 2, and `hasMore` is `true`

#### Scenario: An older plan carries its superseded mark

- **GIVEN** the plans of the scenario above
- **WHEN** a client sends `GET /api/v1/analyses/a1/plans?page=1&perPage=1`
- **THEN** the one item is `pln-0000000a`, with `supersededBy` `pln-0000000b`
- **AND** `hasMore` is `false`

#### Scenario: The newest run of each plan

- **GIVEN** plan `p1` with runs `r1` and `r2`, where `r2` started later, and plan `p2` with no run
- **WHEN** a client lists the plans of the analysis
- **THEN** `p1` has `newestRunId` `r2`, and `p2` has `newestRunId` `null`

#### Scenario: The title of a plan

- **GIVEN** a plan with the stored title `  Liver DE  `, and a plan with no title
- **WHEN** a client lists the plans of the analysis
- **THEN** the first plan has the title `Liver DE`, and the second plan has the title `null`

#### Scenario: One read for each page

- **WHEN** a client sends `GET /api/v1/analyses/a1/plans?page=2&perPage=50`
- **THEN** the server sends one read of the plan store with the limit 50 and the offset 100

#### Scenario: The list before the runtime is ready

- **WHEN** a client sends `GET /api/v1/analyses/a1/plans` before the phase is `ready`
- **THEN** the server answers 503 `unavailable`, and it sends no read
