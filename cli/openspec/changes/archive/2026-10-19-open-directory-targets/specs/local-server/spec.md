# Spec Delta

## MODIFIED Requirements

### Requirement: A page opens a known folder through the server

`POST /api/v1/open-directory` MUST open a known folder of the server machine in the file manager of the OS user. A browser page cannot open a folder. The server listens on the loopback address only, thus the desktop of the server is the desktop of the page. The endpoint opens directories only; it MUST NOT open a file. The server MUST apply this rule to the resolved path of every target before the open: a resolved path that names nothing on disk MUST give 404 `not_found`, and one that names a file MUST give 409 `conflict`.

The body MUST name the folder by a target, never by a path or a URL that the server opens outside a jail:

- `{ "target": "data_dir" }`: the data folder, the `dataDir` of the settings
- `{ "target": "output_dir", "analysisId": "<id>" }`: the output folder of the analysis that has the id
- `{ "target": "workspace", "analysisId": "<id>", "path": "<relative path>" }`: the folder at `path` inside the workspace of the analysis
- `{ "target": "input", "analysisId": "<id>", "path": "<reference path>", "anchorId": "<anchor id> or null" }`: the folder of one registered input of the analysis; inputs live outside the workspace. The body MUST carry `anchorId`; `null` names an unanchored reference
- `{ "target": "logs_dir" }`: the log folder of the server
- `{ "target": "reference_store" }`: the folder of the reference datasets
- `{ "target": "package_store" }`: the folder of the packages

The server MUST NOT open a path or a URL that the body names outside these jails. A `workspace` path names a location only inside the workspace of the analysis the page already views, and an `input` reference names a folder only when the analysis already registers it. Thus a page cannot make the server open a folder that the viewed analysis does not already name in its workspace or in its registered inputs.

The server MUST resolve a `workspace` path with the same rule as the `workspace-file` kind of `POST {A}/artifacts/resolve`: the path MUST be relative, with no `..` segment, and the server tests the real path of the target, with each symbolic link resolved, against the real path of the workspace root. A path of `.` names the workspace root itself. A path whose form is not a valid relative path MUST give 400 `validation_error`. A path that resolves outside the workspace, also through a symbolic link, MUST give 404 `not_found`, and the server MUST open nothing. A path that resolves inside the workspace but names nothing on disk MUST give 404 `not_found`. A path that names a file MUST give 409 `conflict`, because the endpoint opens directories only. A `workspace` target whose workspace root cannot be resolved, for example an anchor folder that is gone, MUST give 409 `conflict` with the reason.

The server MUST resolve an `input` reference by an exact comparison of the reference pair: the `path` and `anchorId` of the body MUST equal the stored `path` and `anchorId` of one registered input of the analysis. The server MUST NOT match a resolved absolute path, a name, or any other form. An anchored reference path is relative to its anchor. An unanchored reference path is an absolute path, and the server accepts it only because it opens the path when the analysis registers that exact reference. A reference that matches no registered input MUST give 404 `not_found`. An input whose reference is a file (`isDir` false) MUST give 409 `conflict` without a disk probe, because the endpoint opens directories only. A resolved input path that names a file on disk MUST give 409 `conflict`. An input whose anchor folder cannot be found MUST give 409 `conflict` with the reason. A resolved input path that names nothing on disk MUST give 404 `not_found`.

The server MUST refuse a body that names no known target with 400 `validation_error`, and open nothing. An `output_dir` or `workspace` or `input` body with no `analysisId` is such a body. A body that is not JSON gives the `invalid_json` answer of the server's error table. The server MUST match the `analysisId` exactly, the same way for every target that carries one: a name or a slug of an analysis is not the id. When no analysis has the `analysisId`, the server MUST answer 404 `not_found` and open nothing.

The server MUST resolve the output folder as `POST {A}/output-dir` does. It gives an existing folder as it is. It makes an absent folder, which needs a writable anchor folder. A failure MUST give the answer of `POST {A}/output-dir`, and the server MUST open nothing:

- The anchor folder of the analysis cannot be found, or it is not writable for a make: 409 `conflict` with the reason.
- Each other failure, for example a failed make of the folder: 500 `internal_error`.

The server MUST resolve `logs_dir` as it is, because the log of the server is in it while the server runs. An absent `logs_dir` MUST give 404 `not_found`, and a file at that path MUST give 409 `conflict`. The server MUST resolve `reference_store` and `package_store` as an existing folder as it is, and MUST make an absent folder before the open. A file where a store folder belongs MUST give 409 `conflict`. A failed make MUST give 500 `internal_error`. In each case the server MUST open nothing.

Each 409 `conflict` answer MUST carry a reason that names the case.

The answer MUST be 200 `{ "opened": boolean }`. `opened` is true when the server started the opener of the OS. It is false when the server cannot start an opener, for example on a machine with no opener program. A failed open MUST NOT give an error status.

#### Scenario: A page opens the data folder

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "data_dir" }`
- **THEN** the server opens the data folder in the file manager, and answers `{ "opened": true }`

#### Scenario: A page opens an output folder that does not exist yet

- **GIVEN** analysis `a1` in a writable folder, with no output folder
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "output_dir", "analysisId": "a1" }`
- **THEN** the server makes the output folder of `a1`, opens it, and answers `{ "opened": true }`

#### Scenario: An output folder with no analysis id

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "output_dir" }`
- **THEN** the server answers 400 `validation_error`, and it opens nothing

#### Scenario: A path in place of a target

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "/etc" }`
- **THEN** the server answers 400 `validation_error`, and it opens nothing

#### Scenario: An unknown analysis

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "output_dir", "analysisId": "nope" }`, and no analysis has the id `nope`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: An analysis whose folder is gone

- **GIVEN** analysis `a1` whose anchor folder was deleted
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "output_dir", "analysisId": "a1" }`
- **THEN** the server answers 409 `conflict` with the reason, and it opens nothing

#### Scenario: A machine with no opener

- **GIVEN** a server machine with no opener program
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "data_dir" }`
- **THEN** the server answers 200 with `{ "opened": false }`

#### Scenario: A page opens the folder of a run

- **GIVEN** analysis `a1` whose workspace holds the folder `runs/r1`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "runs/r1" }`
- **THEN** the server opens the folder `runs/r1` of the workspace of `a1`, and answers `{ "opened": true }`

#### Scenario: A workspace path with a `..` segment

- **GIVEN** analysis `a1` with a workspace root at `/home/u/ws`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "../elsewhere" }`
- **THEN** the server answers 400 `validation_error`, and it opens nothing

#### Scenario: A workspace path that escapes through a symbolic link

- **GIVEN** analysis `a1` whose workspace holds a symbolic link `link` that points to `/etc`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "link" }`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: A workspace path that names nothing on disk

- **GIVEN** analysis `a1` whose workspace holds no folder `runs/r9`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "runs/r9" }`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: A workspace path that names a file

- **GIVEN** analysis `a1` whose workspace holds the file `runs/r1/synthesis.json`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "runs/r1/synthesis.json" }`
- **THEN** the server answers 409 `conflict`, and it opens nothing

#### Scenario: A workspace whose anchor folder is gone

- **GIVEN** analysis `a1` whose anchor folder was deleted
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "runs/r1" }`
- **THEN** the server answers 409 `conflict` with the reason, and it opens nothing

#### Scenario: A page opens the folder of a step output

- **GIVEN** analysis `a1` whose workspace holds the folder `runs/r1/s1/output`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "workspace", "analysisId": "a1", "path": "runs/r1/s1/output" }`
- **THEN** the server opens that folder, and answers `{ "opened": true }`

#### Scenario: A page opens the folder of a registered input

- **GIVEN** analysis `a1` with a registered folder input under the anchor `an1`
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "input", "analysisId": "a1", "path": "<the reference path of the input>", "anchorId": "an1" }`
- **THEN** the server opens the folder of that input outside the workspace, and answers `{ "opened": true }`

#### Scenario: An input reference that names a file

- **GIVEN** analysis `a1` with an unanchored registered input whose reference is a file
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "input", "analysisId": "a1", "path": "<the absolute reference path of that input>", "anchorId": null }`
- **THEN** the server answers 409 `conflict` without a disk probe, and it opens nothing

#### Scenario: An input whose folder became a file

- **GIVEN** analysis `a1` with a registered input whose record names a folder, and the path on disk holds a file now
- **WHEN** a page sends `POST /api/v1/open-directory` with the reference of that input
- **THEN** the server answers 409 `conflict`, and it opens nothing

#### Scenario: A reference with a wrong anchor

- **GIVEN** analysis `a1` with a registered input under the anchor `an1`
- **WHEN** a page sends `POST /api/v1/open-directory` with the `path` of that input and the anchor `an2`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: An input reference that matches no registered input

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "input", "analysisId": "a1", "path": "/not/registered", "anchorId": null }`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: An input whose anchor folder is gone

- **GIVEN** analysis `a1` with a registered folder input under the anchor `an1`, and the folder of the anchor `an1` was deleted
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "input", "analysisId": "a1", "path": "<the reference path of the input>", "anchorId": "an1" }`
- **THEN** the server answers 409 `conflict` with the reason, and it opens nothing

#### Scenario: A page opens the log folder

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "logs_dir" }`
- **THEN** the server opens the log folder, and answers `{ "opened": true }`

#### Scenario: A log folder that is absent

- **GIVEN** a server whose log folder was removed
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "logs_dir" }`
- **THEN** the server answers 404 `not_found`, and it opens nothing

#### Scenario: A page opens the reference store that does not exist yet

- **GIVEN** a server whose reference-dataset folder was never made
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "reference_store" }`
- **THEN** the server makes the folder, opens it, and answers `{ "opened": true }`

#### Scenario: A page opens the package store

- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "package_store" }`
- **THEN** the server opens the package-store folder, and answers `{ "opened": true }`

#### Scenario: A file where a store folder belongs

- **GIVEN** a server whose package-store path holds a file, not a folder
- **WHEN** a page sends `POST /api/v1/open-directory` with `{ "target": "package_store" }`
- **THEN** the server answers 409 `conflict`, and it opens nothing

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the desktop of the machine (`/api/v1/sandbox` and `/api/v1/open-directory`): the sandbox readiness of the machine, and the folder open
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
