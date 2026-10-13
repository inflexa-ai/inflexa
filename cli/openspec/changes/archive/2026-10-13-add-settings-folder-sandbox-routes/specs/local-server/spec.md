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
- the runs of `{A}`: the runs, one run, its stream, its synthesis, its cancel, and its seen mark
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

### Requirement: The settings give the data folder and the server log

The body of `GET` and `PATCH /api/v1/settings` MUST give two absolute paths on the server machine:

- `dataDir`: the data folder of inflexa, `<data dir>/inflexa`. The database, the logs, and the package store are in it.
- `serverLogPath`: the log file of a background server of this build channel. `inflexa server logs` reads the same file.

The two paths come from the data home of the platform (`XDG_DATA_HOME`, or `LOCALAPPDATA` on Windows). They are absolute when the data home is absolute or unset. The XDG Base Directory specification does not permit a relative data home.

A `PATCH` body cannot change the two paths. The server MUST ignore them in a `PATCH` body.

#### Scenario: The settings name the data folder

- **WHEN** a client sends `GET /api/v1/settings`
- **THEN** `dataDir` is the absolute path of `<data dir>/inflexa`
- **AND** `serverLogPath` is the absolute path of the server log of this build channel

#### Scenario: A patch does not move the data folder

- **WHEN** a client sends `PATCH /api/v1/settings` with `{ "telemetry": true, "dataDir": "/tmp/x" }`
- **THEN** the server saves `telemetry`, and the answer gives the same `dataDir` as before

### Requirement: The server gives the sandbox readiness of the machine

`GET /api/v1/sandbox` MUST give the parts of the sandbox readiness that do not depend on an analysis:

- `image`: the state of the configured sandbox image in the container engine, with the type of `image` in `GET {A}/sandbox-readiness`
- `store`: the state of the content of the package store, with the type of `store` in `GET {A}/sandbox-readiness`
- `catalogFarmPresent`: true when the catalog farm exists. It is equal to `farm.catalogPresent` of `GET {A}/sandbox-readiness`.

The read MUST change no state. It MUST NOT pull an image, write the configuration, or clear a recorded failure of a farm composition. It MUST NOT change a transfer row or a flight row. The route MUST answer when the runtime did not boot. The engine read can take more than 10 s, thus the route MUST lift the idle timeout of the connection.

A container engine that does not answer is a state of `image`, not an error of the route. The route MUST answer 200 with `image.state` `engine_error` and the message of the engine.

#### Scenario: A machine with no sandbox image

- **GIVEN** a container engine that does not hold the published sandbox image, an installed package store, and no catalog farm
- **WHEN** a client sends `GET /api/v1/sandbox`
- **THEN** the server answers 200 with `image.state` `absent`, `store` `installed`, and `catalogFarmPresent` `false`

#### Scenario: The machine read leaves the farm failure

- **GIVEN** a recorded failure of the farm composition of analysis `a1`
- **WHEN** a client sends `GET /api/v1/sandbox`, and then sends `GET /api/v1/analyses/a1/sandbox-readiness`
- **THEN** the readiness of `a1` gives the failure in `farm.failure`

#### Scenario: An engine that does not answer

- **GIVEN** a container engine that does not answer
- **WHEN** a client sends `GET /api/v1/sandbox`
- **THEN** the server answers 200 with `image.state` `engine_error` and the message of the engine

### Requirement: A page opens a known folder through the server

`POST /api/v1/open` MUST open a known folder of the server machine in the file manager of the OS user. A browser page cannot open a folder. The server listens on the loopback address only, thus the desktop of the server is the desktop of the page.

The body MUST name the folder by a target, never by a path or a URL:

- `{ "target": "data_dir" }`: the data folder, the `dataDir` of the settings
- `{ "target": "output_dir", "analysisId": "<id>" }`: the output folder of the analysis that has the id

The server MUST NOT read a path or a URL from the body. Thus a page cannot make the server open a file of its choice.

The server MUST refuse a body that names no known target with 400 `validation_error`, and open nothing. An `output_dir` body with no `analysisId` is such a body. When no analysis has the `analysisId`, the server MUST answer 404 `not_found` and open nothing.

The server MUST resolve the output folder as `POST {A}/output-dir` does. It gives an existing folder as it is. It makes an absent folder, which needs a writable anchor folder. A failure MUST give the answer of `POST {A}/output-dir`, and the server MUST open nothing:

- The anchor folder of the analysis cannot be found, or it is not writable for a make: 409 `conflict` with the reason.
- Each other failure, for example a failed make of the folder: 500 `internal_error`.

The answer MUST be 200 `{ "opened": boolean }`. `opened` is true when the server started the opener of the OS. It is false when the server cannot start an opener, for example on a machine with no opener program. A failed open MUST NOT give an error status.

#### Scenario: A page opens the data folder

- **WHEN** a page sends `POST /api/v1/open` with `{ "target": "data_dir" }`
- **THEN** the server opens the data folder in the file manager, and answers `{ "opened": true }`

#### Scenario: A page opens an output folder that does not exist yet

- **GIVEN** analysis `a1` in a writable folder, with no output folder
- **WHEN** a page sends `POST /api/v1/open` with `{ "target": "output_dir", "analysisId": "a1" }`
- **THEN** the server makes the output folder of `a1`, opens it, and answers `{ "opened": true }`

#### Scenario: An output folder with no analysis id

- **WHEN** a page sends `POST /api/v1/open` with `{ "target": "output_dir" }`
- **THEN** the server answers 400 `validation_error`, and it opens nothing

#### Scenario: A path in place of a target

- **WHEN** a page sends `POST /api/v1/open` with `{ "target": "/etc" }`
- **THEN** the server answers 400 `validation_error`, and it opens nothing

#### Scenario: An unknown analysis

- **WHEN** a page sends `POST /api/v1/open` with `{ "target": "output_dir", "analysisId": "nope" }`, and no analysis has the id `nope`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: An analysis whose folder is gone

- **GIVEN** analysis `a1` whose anchor folder was deleted
- **WHEN** a page sends `POST /api/v1/open` with `{ "target": "output_dir", "analysisId": "a1" }`
- **THEN** the server answers 409 `conflict` with the reason, and it opens nothing

#### Scenario: A machine with no opener

- **GIVEN** a server machine with no opener program
- **WHEN** a page sends `POST /api/v1/open` with `{ "target": "data_dir" }`
- **THEN** the server answers 200 with `{ "opened": false }`
