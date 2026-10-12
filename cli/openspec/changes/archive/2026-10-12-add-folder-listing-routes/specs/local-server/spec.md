# Spec Delta

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
| `internal_error` | 500 |
| `unavailable`, `draining` | 503 |

A `validation_error` MUST carry the zod flatten output in `details`. A 500 MUST carry a generic message, and the cause MUST go only to the log. An unknown path MUST get 404 `not_found`.

Each list MUST take the query values `page` (zero-based, default 0) and `perPage` (default 100, cap 200). A bad value MUST fall back to the default, and it MUST NOT give a 400. The response MUST be `{<resource>: T[], total, page, perPage, hasMore}`, where the key names the resource. A list MUST add a different field to this shape only when its own requirement names that field, for example `folder` of the folder list.

#### Scenario: A body that is not JSON

- **WHEN** a client sends `POST /api/v1/projects` with a body that is not JSON
- **THEN** the server answers 400 with the error `invalid_json`

#### Scenario: A bad page value

- **WHEN** a client sends `GET /api/v1/projects?perPage=abc`
- **THEN** the server answers with `perPage` 100

### Requirement: The routes group by domain and keep the Cortex path tail

The routes MUST be under `/api/v1`, in these groups:

- the server: its state, a new boot, the activity, and the stop
- the machine: the account, the agents and their models, the models of the connection, the settings, and the embedding models
- the projects, the anchors (repair, relocate, prune), and the analyses (resolve, list, make)
- one analysis `{A}` (`/api/v1/analyses/:analysisId`): the analysis itself, its output folder, and its inputs
- the conversation of `{A}`: the threads, the chat, the turns, and the asks
- the runs of `{A}`: the runs, one run, its stream, and its cancel
- the profile of `{A}`: the chat context, the data profile, the sandbox readiness, and the farm heal and link
- the records of `{A}`: the usage, the provenance, and the artifacts
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

A route that can work for longer than 10 s before its response, and that a client calls with no request body, MUST lift the idle timeout of the connection for that request. `Bun.serve` closes a silent connection at 10 s only when its request has no body.

#### Scenario: A thread route keeps the Cortex tail

- **WHEN** a client lists the threads of analysis `a1`
- **THEN** the path is `/api/v1/analyses/a1/threads`, the Cortex tail with no organization segment

#### Scenario: The server gives no reclaim route

- **WHEN** a client sends `POST /api/v1/store/reclaim`
- **THEN** the server answers 404 `not_found`

## ADDED Requirements

### Requirement: The server gives the home folder and the entries of a folder

`GET /api/v1/fs/home` MUST give `{path}`, the home folder of the OS user that runs the server.

`GET /api/v1/fs/list?path=<absolute path>` MUST give the entries of one folder in the list shape, with the key `entries`. The response MUST also give `folder: {path, readable}`. `folder.path` is the canonical path of the folder, with each symbolic link resolved. `folder.readable` is the verdict of the mode bits and the owner ids for the server user.

Each entry MUST give these fields:

- `name`, and `path`: the canonical folder path joined with the name
- `kind`: `file`, `folder`, or `symlink`, from the folder read. Each other type of entry is `file`.
- `link`: `null` for an entry that is not a link. For a link, it is `{target, broken, targetKind}`:
  - `target`: the text that the link stores, or `null` when the server cannot read it
  - `broken`: true when the read of the target fails with `ENOENT` or `ENOTDIR` (the target does not exist), or with `ELOOP` (the chain of links loops). Each other failure, for example `EACCES`, gives `false`.
  - `targetKind`: `file` or `folder`, or `null` when the server cannot read the target
- `size`: the size in bytes of a file, or `null` for a folder
- `modifiedAt`: the time of the last change, as an ISO 8601 string
- `mode`: the permission bits
- `readable` and `writable`: the verdict of the mode bits and the owner ids for the server user
- `hidden`: true when the name starts with `.`

For a link, `size`, `modifiedAt`, `mode`, `readable`, and `writable` MUST describe the target. A fact that the server cannot read MUST be `null`, and the entry MUST stay in the list. `folder.readable` MUST be `null` when the server cannot read the facts of the folder. On a platform with no POSIX user ids, `mode`, `readable`, `writable`, and `folder.readable` MUST be `null`.

The sort MUST use the kind from the folder read: each `folder` first, then each other entry. Each group MUST be in case-insensitive name order, with a fixed order for two names that differ only in case. Thus a link to a folder sorts with the files.

The list MUST hide each hidden entry. The query value `hidden=true` MUST show them. `total` MUST count the entries after this filter.

The list MUST take the paging values of the other lists. The server MUST read the facts of an entry only for the entries of the page that it gives.

The server MUST run each read of the list off the event loop. A folder on a hung mount MUST stop only its own request.

#### Scenario: The home folder

- **WHEN** a client sends `GET /api/v1/fs/home`
- **THEN** the server answers 200 with the home folder of the server user in `path`

#### Scenario: A folder lists folders first

- **GIVEN** a folder that holds the folder `beta`, the files `alpha.txt` and `Zeta.txt`, and the file `.env`
- **WHEN** a client lists the folder
- **THEN** the entries are `beta`, `alpha.txt`, and `Zeta.txt`, in this order, and `total` is 3
- **AND** `beta` has the kind `folder` and a `null` size, and `alpha.txt` has its size, its time, its mode, and `readable` true

#### Scenario: The hidden entries show on request

- **GIVEN** the same folder
- **WHEN** a client lists it with `hidden=true`
- **THEN** the entries include `.env` with `hidden` true, and `total` is 4

#### Scenario: A link gives its target

- **GIVEN** a folder that holds a link `data` to a folder, and a link `gone` to a path that does not exist
- **WHEN** a client lists the folder
- **THEN** `data` has the kind `symlink`, its stored target, `broken` false, and `targetKind` `folder`
- **AND** `gone` has `broken` true, `targetKind` `null`, and `null` facts
- **AND** both links sort after each `folder` entry

#### Scenario: A page of a large folder

- **GIVEN** a folder that holds 250 files
- **WHEN** a client lists it with `page=1` and `perPage=100`
- **THEN** the entries are the 101st to the 200th entry of the sort, `total` is 250, and `hasMore` is true

#### Scenario: The canonical path of a folder

- **GIVEN** a link `l` to a folder `f`
- **WHEN** a client lists the path of `l`
- **THEN** `folder.path` is the canonical path of `f`, and the path of each entry starts with it

### Requirement: The folder list refuses a bad path with a named error

The list route MUST answer 400 `validation_error` when `path` is absent, is not absolute, or holds a NUL byte. It MUST also answer 400 `validation_error` when `hidden` is present and is not `true` or `false`. It MUST answer 404 `not_found` when the folder does not exist. It MUST answer 400 `validation_error` when the path names a file. Each other failure of the folder read MUST give 403 `forbidden`. The message MUST name the cause, and `details.code` MUST hold the error code of the operating system, for example `EACCES`.

#### Scenario: No path

- **WHEN** a client sends `GET /api/v1/fs/list` with no `path`
- **THEN** the server answers 400 `validation_error`

#### Scenario: A relative path

- **WHEN** a client sends `GET /api/v1/fs/list?path=data`
- **THEN** the server answers 400 `validation_error`

#### Scenario: An absent folder

- **WHEN** a client lists an absolute path that does not exist
- **THEN** the server answers 404 `not_found`

#### Scenario: A path that names a file

- **WHEN** a client lists the absolute path of a file
- **THEN** the server answers 400 `validation_error`

#### Scenario: An unreadable folder

- **GIVEN** a folder whose mode is 000, and a server that does not run as root
- **WHEN** a client lists the folder
- **THEN** the server answers 403 `forbidden`, the message names the denied permission, and `details.code` is `EACCES`

### Requirement: The file system routes give metadata only

The file system routes MUST NOT give the content of a file. They MUST NOT limit a path to a root, because the facts of an entry are what `ls -l` shows to the same OS user. They MUST NOT write to the disk. They use no harness runtime, thus they MUST answer while the boot of the runtime is not ready.

#### Scenario: A folder outside each analysis

- **WHEN** a client lists `/` before the runtime boot is ready
- **THEN** the server answers 200 with the entries of `/`, and no entry carries the content of a file
