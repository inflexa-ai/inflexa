## MODIFIED Requirements

### Requirement: The API has one error body and one list shape

Each error response MUST have the body `{error, message, details?}`, and each code MUST have one status:

| Code | Status |
|-|-|
| `invalid_json`, `validation_error` | 400 |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict`, `busy`, `locked` | 409 |
| `range_not_satisfiable` | 416 |
| `internal_error` | 500 |
| `unavailable`, `draining` | 503 |

A `validation_error` MUST carry the zod flatten output in `details`. A 500 MUST carry a generic message, and the cause MUST go only to the log. An unknown path MUST get 404 `not_found`.

Each list MUST take the query values `page` (zero-based, default 0) and `perPage` (default 100, cap 200). A bad value MUST fall back to the default, and it MUST NOT give a 400. A `page` whose offset, the page times `perPage`, is not a safe integer is a bad value. The response MUST be `{<resource>: T[], total, page, perPage, hasMore}`, where the key names the resource. A list MUST add a different field to this shape only when its own requirement names that field, for example `folder` of the folder list.

The transcript read `GET {T}/messages` is the one list that pages by a cursor. It takes `before` and `limit` in place of `page` and `perPage`, as its own requirement states.

The recent-file read `GET /api/v1/fs/recents` is the one list with no page. It takes `limit` in place of `page` and `perPage`, and it gives `{entries}` only, as its own requirement states.

#### Scenario: A body that is not JSON

- **WHEN** a client sends `POST /api/v1/projects` with a body that is not JSON
- **THEN** the server answers 400 with the error `invalid_json`

#### Scenario: A bad page value

- **WHEN** a client sends `GET /api/v1/projects?perPage=abc`
- **THEN** the server answers with `perPage` 100

#### Scenario: A page past the safe integers falls back

- **WHEN** a client sends `GET /api/v1/projects?page=99999999999999999999`
- **THEN** the server answers 200 with `page` 0

#### Scenario: The recent-file read has no page

- **WHEN** a client sends `GET /api/v1/fs/recents?page=2`
- **THEN** the server answers 200 with `{entries}` and no paging fields, and `page` changes nothing

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the desktop of the machine (`/api/v1/sandbox` and `/api/v1/open-directory`): the sandbox readiness of the machine, and the folder open
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- the attention read (`/api/v1/attention`): the work that waits for the person, over each analysis
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, the asks, and the access of a report-session page
- the runs of `{A}`: the runs, one run, its stream, its synthesis, its cancel, its seen mark, one plan, and its approval
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

### Requirement: The file system routes read each path with no root limit

Each route under `/api/v1/fs` MUST take each path as an absolute path. The client MUST expand `~` with the home path before it sends a path. The server MUST remove each `.` and `..` segment of a path as text, before it resolves a symbolic link. Each path that a route gives MUST be absolute, with each symbolic link of its folders resolved. The one exception is `link.target` of a list entry, because it is the text that the link stores. The server MUST change a path to a relative path only inside its own code.

The routes MUST NOT limit a path to a root. A person can browse and preview each place on the machine. The routes give what the same OS user can read with `ls -l` and `cat`. The routes MUST NOT write to the disk, with two exceptions. The guard of `analysisId` writes the lock file of the instance lock. The routes of the pins and of the recent files write their rows in the database of the server. The folder list, the recent-file read, and the input entries of the places read read the artifact ledger through the harness runtime for `origin` only. The places read also reads the run ledger, for the runs of an analysis only. Each route MUST answer while the boot of the runtime is not ready.

#### Scenario: A folder outside each analysis

- **WHEN** a client lists `/` before the runtime boot is ready
- **THEN** the server answers 200 with the entries of `/`, and no entry carries the content of a file

#### Scenario: A file outside each analysis

- **GIVEN** a file outside each workspace and outside each declared input
- **WHEN** a client reads the absolute path of the file before the runtime boot is ready
- **THEN** the server answers 200 with the bytes of the file

#### Scenario: A path with a parent segment

- **GIVEN** the file `/data/study/counts.csv`
- **WHEN** a client reads `/data/study/raw/../counts.csv`
- **THEN** the server answers 200 with the bytes of `/data/study/counts.csv`

#### Scenario: A pin writes a row and no file

- **WHEN** a client pins the folder `/data/study`
- **THEN** the database of the server holds the pin, and no file or folder on the disk changes

## ADDED Requirements

### Requirement: The server gives the pins of the picker for the machine

`GET /api/v1/fs/pins` MUST give the pins in the list shape with the key `pins`, oldest pin first. A pin is a fact of the machine, thus the list MUST NOT depend on `analysisId`. Each pin MUST give `id`, `createdAt`, `updatedAt`, `path`, `label`, `isDir`, and `absolutePath`. `absolutePath` is the real path of `path`, or `null` when the server cannot resolve it. Such a pin MUST stay in the list, and the route MUST still answer 200. The server MUST resolve the paths of a page in a queue of fixed width.

#### Scenario: A pin shows in each analysis

- **GIVEN** a pin of `/Volumes/lab-share/references` that a client made with `analysisId=a1`
- **WHEN** a client lists the pins with `analysisId=a2`
- **THEN** the list holds the pin

#### Scenario: A pin of a deleted folder

- **GIVEN** a pin of the folder `/data/old`, and the folder is then deleted
- **WHEN** a client lists the pins
- **THEN** the server answers 200, and the pin has `path` `/data/old` and `absolutePath` `null`

#### Scenario: The order of the pins

- **GIVEN** a pin of `/b`, and then a pin of `/a`
- **WHEN** a client lists the pins
- **THEN** the pin of `/b` comes first

### Requirement: A client pins a path and removes a pin

`POST /api/v1/fs/pins` with the body `{path, label?}` MUST store a pin of the real path of `path`, with `isDir` from the disk. It MUST answer 201 with the pin. A second pin of the same real path MUST keep the first pin, and it MUST answer 200 with that pin. A blank `label` is no label. `DELETE /api/v1/fs/pins/:id` MUST remove the pin and answer 200 with `{deleted: true}`. It MUST answer 404 `not_found` when no pin has the id.

The route MUST answer 400 `validation_error` when `path` is absent, is not absolute, or holds a NUL byte, and when `label` holds more than 256 characters. It MUST answer 404 `not_found` when no entry is at the path. Each other failure of the read of the path MUST give 403 `forbidden`, with the error code of the operating system in `details.code`.

#### Scenario: A pin of a folder

- **GIVEN** the folder `/data/study`
- **WHEN** a client sends `POST /api/v1/fs/pins` with `{path: "/data/study", label: "Study"}`
- **THEN** the server answers 201 with a pin whose `path` is `/data/study`, `label` is `Study`, and `isDir` is true

#### Scenario: A second pin of the same folder

- **GIVEN** a pin of `/data/study`
- **WHEN** a client pins `/data/study/raw/..`
- **THEN** the server answers 200 with the first pin, and the list holds one pin of the folder

#### Scenario: A pin through a link

- **GIVEN** a link `/data/latest` to the folder `/data/study`
- **WHEN** a client pins `/data/latest`
- **THEN** the pin has the `path` `/data/study`

#### Scenario: A pin of a path that does not exist

- **WHEN** a client pins an absolute path at which no entry exists
- **THEN** the server answers 404 `not_found`, and it stores no pin

#### Scenario: A pin of a relative path

- **WHEN** a client sends `POST /api/v1/fs/pins` with `{path: "data"}`
- **THEN** the server answers 400 `validation_error`

#### Scenario: A removal of a pin

- **GIVEN** the pin `p1`
- **WHEN** a client sends `DELETE /api/v1/fs/pins/p1`, and then sends it again
- **THEN** the first answer is 200 with `{deleted: true}`, and the second answer is 404 `not_found`

### Requirement: The server records a recent file of the picker

`POST /api/v1/fs/recents` with the body `{path, analysisId?}` MUST record the real path of `path` as a recent file of one scope. The row MUST take `isDir` from the disk, and the route MUST answer 200 with `{recorded: true}`. The scope is the analysis of `analysisId`, or the machine when the body has no `analysisId`. A second post of the same real path in the same scope MUST move its time and add no row. The row MUST hold no kind and no origin. The server MUST NOT record a file without a post of the client.

The path checks and their errors MUST be those of `POST /api/v1/fs/pins`. A body `analysisId` MUST get the guard steps of a query `analysisId`: 404 `not_found` for an unknown analysis, and 409 `locked` when a different live process holds its instance lock. An empty `analysisId` is no analysis.

#### Scenario: A second post moves the file to the top

- **GIVEN** the recent files `a.csv` and then `b.csv` of the machine scope
- **WHEN** a client posts `a.csv` again
- **THEN** a read of the machine scope gives `a.csv` and then `b.csv`, with one entry for each file

#### Scenario: An unknown analysis

- **WHEN** a client posts a file with `analysisId` `nope`, and no analysis has the id `nope`
- **THEN** the server answers 404 `not_found`, and it records nothing

#### Scenario: A deleted analysis

- **GIVEN** analysis `a1` with two recent files
- **WHEN** the analysis row is deleted
- **THEN** the database holds no recent file of `a1`

### Requirement: The server bounds the recent files of each scope

The server MUST keep at most 100 recent files in each scope. A post that records a file MUST then remove the oldest recent files of its scope past that count. A post MUST NOT remove a recent file of a different scope.

#### Scenario: The oldest file goes

- **GIVEN** 100 recent files of analysis `a1`, and 1 recent file of the machine scope
- **WHEN** a client posts a new file with `analysisId=a1`
- **THEN** the scope of `a1` holds 100 files without its oldest file, and the machine scope still holds its file

### Requirement: The server gives the recent files of a scope

`GET /api/v1/fs/recents?analysisId=&limit=` MUST give `{entries}`: the recent files of the scope as list entries, newest first. With no `analysisId`, the scope is the machine. `limit` is a positive integer, with the default 20 and the cap 100. A bad value MUST fall back to the default. The response MUST hold `limit` entries when the scope holds that many files that exist now.

Each entry MUST give the fields of an entry of the folder list, read from the disk at the request. `itemCount` obeys the hidden rule of a list with no `hidden` value. `isInput` and `origin` MUST obey the rules of the folder list. For each request, the server MUST read the inputs one time and the ledger at most one time.

A path at which no entry exists now MUST leave the list. The read MUST NOT delete its row, thus the entry comes back when the path exists again. Only the cap of a post removes a row. An entry whose facts the server cannot read for a different reason MUST stay, with `null` facts.

#### Scenario: The newest file first

- **GIVEN** the recent files `a.csv`, then `b.csv`, of the machine scope
- **WHEN** a client sends `GET /api/v1/fs/recents`
- **THEN** the entries are `b.csv` and then `a.csv`, each with the `kind` `table`

#### Scenario: The scopes stay apart

- **GIVEN** the recent file `a.csv` of analysis `a1`, and the recent file `b.csv` of the machine scope
- **WHEN** a client reads the recent files with `analysisId=a1`
- **THEN** the one entry is `a.csv`

#### Scenario: A deleted file

- **GIVEN** the recent files `a.csv` and `b.csv` of the machine scope, and `b.csv` is then deleted
- **WHEN** a client reads the recent files of the machine scope
- **THEN** the one entry is `a.csv`, and the database still holds the row of `b.csv`
- **WHEN** `b.csv` exists again, and the client reads the recent files again
- **THEN** the entries are `b.csv` and then `a.csv`

#### Scenario: A limit

- **GIVEN** 30 recent files of the machine scope
- **WHEN** a client reads them with `limit=5`, and then with `limit=abc`
- **THEN** the first answer holds the 5 newest files, and the second answer holds the 20 newest files

### Requirement: The server gives the places of the picker sidebar

`GET /api/v1/fs/places?analysisId=` MUST give `{sections}`. Each section is `{id, items}`, in this order: `analysis` (only with `analysisId`), `favorites`, `locations`, `otherAnalyses`, and `drives`. A section with no item MUST stay, with an empty `items`. Each item MUST give `kind`, `label`, and an absolute canonical `path`. The one exception is the `inputs` item, which has no path. The client takes its words from `kind`, and `label` is the data of the place.

The kinds are `workspace`, `inputs`, `run`, `step`, `pin`, `home`, `desktop`, `documents`, `downloads`, `analysis`, and `drive`. The server MUST read the places in queues of fixed width.

#### Scenario: The sections without an analysis

- **WHEN** a client sends `GET /api/v1/fs/places` with no `analysisId`
- **THEN** the sections are `favorites`, `locations`, `otherAnalyses`, and `drives`, in this order

#### Scenario: The sections with an analysis

- **GIVEN** analysis `a1`
- **WHEN** a client sends `GET /api/v1/fs/places?analysisId=a1`
- **THEN** the sections are `analysis`, `favorites`, `locations`, `otherAnalyses`, and `drives`, in this order

#### Scenario: An unknown analysis

- **WHEN** a client sends `GET /api/v1/fs/places?analysisId=nope`, and no analysis has the id `nope`
- **THEN** the server answers 404 `not_found`

### Requirement: The places of an analysis

The `analysis` section MUST give these items, in this order:

- the `workspace` item, when the workspace folder of the analysis exists. Its `label` is the name of the analysis.
- the `inputs` item. `count` is the count of the declared inputs. The server reads the first 200 declared inputs, in the order of the inputs. `entries` holds a list entry for each of them that the server can locate and that exists. Each entry has `isInput` true.
- a `run` item for each of the newest 10 runs, from one ledger read, newest start first, whose folder `runs/<runId>` exists. A `step` item for each folder in the run folder whose name does not start with a dot comes after its run, in name order, at most 50. The `label` is the run id or the folder name.

Before the runtime boot is ready, and after a failed ledger read, the section MUST give no run item, and the route MUST still answer. A failed read of the inputs or of the workspace folder in the database of the server MUST give 500 `internal_error`.

#### Scenario: A run with its step

- **GIVEN** analysis `a1` whose workspace `<W>` holds `runs/r1/s1`, and the ledger run `r1`
- **WHEN** a client reads the places with `analysisId=a1`, after the runtime boot is ready
- **THEN** the section gives the `workspace` item `<W>`, the `inputs` item, the `run` item `<W>/runs/r1`, and the `step` item `<W>/runs/r1/s1`, in this order

#### Scenario: The inputs of the analysis

- **GIVEN** analysis `a1` with the declared inputs `/data/a.csv` and `/data/gone.csv`, and `/data/gone.csv` does not exist
- **WHEN** a client reads the places with `analysisId=a1`
- **THEN** the `inputs` item has `count` 2 and one entry `/data/a.csv`, with `isInput` true and the `kind` `table`

#### Scenario: The runs before the runtime boot is ready

- **GIVEN** analysis `a1` whose workspace holds `runs/r1/s1`, and a server whose runtime boot is not ready
- **WHEN** a client reads the places with `analysisId=a1`
- **THEN** the server answers 200, and the section gives no `run` item and no `step` item

### Requirement: The places of the machine

The other sections MUST give these items:

- `favorites`: a `pin` item for each of the first 50 pins, in the order of the pins, with its `pinId`. `label` is the label of the pin, or the name of its path. `lost` is true when the server cannot resolve the path, and `path` is then the stored path.
- `locations`: the `home` item, then `desktop`, `documents`, and `downloads` when `Desktop`, `Documents`, or `Downloads` exists as a folder in the home folder. `label` is the name of the folder.
- `otherAnalyses`: an `analysis` item for each of the newest 20 analyses by activity, other than the analysis of `analysisId`. An analysis gives an item only when its workspace folder exists at the cached path of its anchor. `label` is the name of the analysis. The server MUST NOT send a query for each analysis.
- `drives`: a `drive` item for each mounted volume, at most 20, in name order. `label` is the name of the volume entry, or the drive letter on Windows.

#### Scenario: A missing Downloads folder

- **GIVEN** a home folder that holds `Desktop` and `Documents`, and no `Downloads`
- **WHEN** a client reads the places
- **THEN** `locations` gives the items `home`, `desktop`, and `documents`, and no `downloads` item

#### Scenario: A lost pin

- **GIVEN** a pin of the folder `/data/old`, and the folder is then deleted
- **WHEN** a client reads the places
- **THEN** `favorites` gives the pin with `lost` true and the `path` `/data/old`

#### Scenario: The other analyses

- **GIVEN** the analyses `a1` and `a2`, each with a workspace folder
- **WHEN** a client reads the places with `analysisId=a1`
- **THEN** `otherAnalyses` gives one `analysis` item, with the name of `a2` and the path of its workspace folder

#### Scenario: The drives of macOS

- **GIVEN** a macOS machine whose `/Volumes` holds `Macintosh HD`, a link to `/`, and the folder `lab-share`
- **WHEN** a client reads the places
- **THEN** `drives` gives one `drive` item, `/Volumes/lab-share`

### Requirement: The server finds the mounted volumes of each platform

The server MUST find the mounted volumes in these folders:

- macOS: each entry of `/Volumes` whose real path is a folder and is not `/`.
- Linux: each folder in `/media/<user>`, in `/run/media/<user>`, and in `/mnt`, where `<user>` is the OS user that runs the server.
- Windows: the root of each drive letter that exists.

An absent folder of this list gives no item and no error.

#### Scenario: A Linux machine with no mount folder

- **GIVEN** a Linux machine with no `/media/<user>`, no `/run/media/<user>`, and an empty `/mnt`
- **WHEN** a client reads the places
- **THEN** the server answers 200, and `drives` has an empty `items`
