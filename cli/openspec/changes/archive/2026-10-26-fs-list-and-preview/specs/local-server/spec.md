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
- the runs of `{A}`: the runs, one run, its stream, its synthesis, its cancel, its seen mark, one plan, and its approval
- the profile of `{A}`: the chat context, the data profile, the sandbox readiness, and the farm heal and link
- the records of `{A}`: the usage, the provenance, and the artifacts
- the package store: the state, the transfers, and the failed flights (retry and delete)
- the browser sign-in (`/api/v1/session`): the nonce and the sign-in link
- the file system (`/api/v1/fs`): the home folder, the list of a folder, the bytes of a file, and the preview of a file or a folder

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

### Requirement: The server gives the home folder and the entries of a folder

`GET /api/v1/fs/home` MUST give `{path}`, the canonical path of the home folder of the OS user that runs the server. When the server cannot resolve the home folder, it MUST give the home path as the operating system gives it.

`GET /api/v1/fs/list?path=<absolute path>` MUST give the entries of one folder in the list shape, with the key `entries`. The response MUST also give `folder: {path, readable}`. `folder.path` is the canonical path of the folder, with each symbolic link resolved. `folder.readable` is the verdict of the mode bits and the owner ids for the server user.

Each entry MUST give these fields:

- `name`, and `path`: the canonical folder path joined with the name
- `type`: `file`, `folder`, or `symlink`, from the folder read. Each other type of entry is `file`.
- `kind`: the kind of the file from the kind map of the file system routes. It is `null` for a folder, for a link whose `targetKind` is `folder`, and for a name that the map does not know.
- `link`: `null` for an entry that is not a link. For a link, it is `{target, broken, targetKind}`:
  - `target`: the text that the link stores, or `null` when the server cannot read it
  - `broken`: true when the read of the target fails with `ENOENT` or `ENOTDIR` (the target does not exist), or with `ELOOP` (the chain of links loops). Each other failure, for example `EACCES`, gives `false`.
  - `targetKind`: `file` or `folder`, or `null` when the server cannot read the target
- `size`: the size in bytes of a file, or `null` for a folder
- `modifiedAt`: the time of the last change, as an ISO 8601 string
- `mode`: the permission bits
- `readable` and `writable`: the verdict of the mode bits and the owner ids for the server user
- `hidden`: true when the name starts with `.`
- `itemCount`: for a folder and for a link whose `targetKind` is `folder`, the count of the names in that folder. The count obeys the `hidden` value of the request. Thus it is equal to the `total` of a list of that folder with the same value. It is `null` for each other entry, and for a folder that the server cannot read.
- `isInput`: true when the entry is a declared input of the analysis of `analysisId`, or is inside a declared input folder. The server compares the path of the entry with the canonical absolute path of each input. A declared input file marks only its own path. A declared input folder marks its own path and each path inside it, with a boundary-safe test: `/a/bc` is not inside `/a/b`. An input whose anchor folder the server cannot locate marks no entry.
- `origin`: `{runId, stepId}` of the step that wrote the file, from the artifact ledger of the analysis of `analysisId`. It is `null` when the ledger has no row for the path, or when its row has no run or no step. It is also `null` for a path outside the workspace folder of the analysis.

Without `analysisId`, each `isInput` MUST be false and each `origin` MUST be `null`. Thus one route serves the picker of an analysis and the folder browser of a new analysis.

For a link, `size`, `modifiedAt`, `mode`, `readable`, and `writable` MUST describe the target. A fact that the server cannot read MUST be `null`, and the entry MUST stay in the list. `folder.readable` MUST be `null` when the server cannot read the facts of the folder. On a platform with no POSIX user ids, `mode`, `readable`, `writable`, and `folder.readable` MUST be `null`.

The sort MUST use the type from the folder read: each `folder` first, then each other entry. Each group MUST be in case-insensitive name order, with a fixed order for two names that differ only in case. Thus a link to a folder sorts with the files.

The list MUST hide each hidden entry. The query value `hidden=true` MUST show them. `total` MUST count the entries after this filter.

The query value `namePrefix` MUST select the entries whose name starts with the prefix, with no regard to case. A hidden entry MUST come back only when the prefix starts with a dot. With a non-empty prefix, `hidden` does not change which entries come back. An absent or empty `namePrefix` is no prefix, and the hidden rule of the request applies. `total` MUST count the entries after the prefix filter.

The list MUST take the paging values of the other lists. The server MUST read the facts, the item count, the input mark, and the origin only for the entries of the page. It MUST read the facts and the item counts in a queue of fixed width.

The server MUST read the declared inputs and locate the workspace folder at most one time for each request. It MUST send at most one read of the artifact ledger for each page. It MUST send no ledger read when no entry of the page is inside the workspace folder.

The server MUST read the artifact ledger only when the runtime boot is ready. Before that, each `origin` MUST be `null`, and the list MUST still answer. A failed ledger read MUST give `null` for each `origin`, and the list MUST still answer. A failed read of the declared inputs or of the workspace folder of the analysis in the database of the server MUST give 500 `internal_error`.

The server MUST run each read of the list off the event loop. A folder on a hung mount MUST stop only its own request.

#### Scenario: The home folder

- **WHEN** a client sends `GET /api/v1/fs/home`
- **THEN** the server answers 200 with the canonical path of the home folder of the server user in `path`

#### Scenario: A home folder behind a link

- **GIVEN** a server user whose home path holds a symbolic link
- **WHEN** a client sends `GET /api/v1/fs/home`
- **THEN** `path` is the real path of the home folder, with each link resolved

#### Scenario: A folder lists folders first

- **GIVEN** a folder that holds the folder `beta`, the files `alpha.txt` and `Zeta.txt`, and the file `.env`
- **WHEN** a client lists the folder
- **THEN** the entries are `beta`, `alpha.txt`, and `Zeta.txt`, in this order, and `total` is 3
- **AND** `beta` has the type `folder`, the kind `null`, and a `null` size
- **AND** `alpha.txt` has the kind `table`, its size, its time, its mode, and `readable` true

#### Scenario: The hidden entries show on request

- **GIVEN** the same folder
- **WHEN** a client lists it with `hidden=true`
- **THEN** the entries include `.env` with `hidden` true, and `total` is 4

#### Scenario: A link gives its target

- **GIVEN** a folder that holds a link `data` to a folder, and a link `gone` to a path that does not exist
- **WHEN** a client lists the folder
- **THEN** `data` has the type `symlink`, its stored target, `broken` false, `targetKind` `folder`, and the kind `null`
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

#### Scenario: The item count of a folder

- **GIVEN** a folder that holds the folder `sub` with the files `a.csv` and `.hidden`, and the file `b.csv`
- **WHEN** a client lists the folder
- **THEN** `sub` has `itemCount` 1, and `b.csv` has `itemCount` `null`
- **AND** with `hidden=true`, `sub` has `itemCount` 2

#### Scenario: A folder that the server cannot read

- **GIVEN** a folder that holds the folder `locked` with mode 000, and a server that does not run as root
- **WHEN** a client lists the folder
- **THEN** `locked` stays in the list with `itemCount` `null`

#### Scenario: A name prefix

- **GIVEN** a folder that holds `Counts.csv`, `counts-raw.csv`, `meta.json`, and `.counts`
- **WHEN** a client lists it with `namePrefix=cou`
- **THEN** the entries are `counts-raw.csv` and `Counts.csv`, in the order of the sort, and `total` is 2

#### Scenario: A name prefix with a dot

- **GIVEN** the same folder
- **WHEN** a client lists it with `namePrefix=.c` and no `hidden`
- **THEN** the one entry is `.counts`

#### Scenario: No analysis

- **GIVEN** a folder that is a declared input of analysis `a1`, with a file that a step of `a1` wrote
- **WHEN** a client lists the folder with no `analysisId`
- **THEN** each entry has `isInput` false and `origin` `null`

#### Scenario: A declared input folder

- **GIVEN** analysis `a1` with the declared input folder `/data/study`
- **WHEN** a client lists `/data` with `analysisId=a1`
- **THEN** the entry `study` has `isInput` true, and the entry `study-old` has `isInput` false
- **AND** a list of `/data/study` with `analysisId=a1` gives `isInput` true for each entry

#### Scenario: The step that wrote a file

- **GIVEN** analysis `a1` whose workspace folder is `<W>`, and the ledger row `runs/r1/s1/output/de.csv` of run `r1` and step `s1`
- **WHEN** a client lists `<W>/runs/r1/s1/output` with `analysisId=a1`, after the runtime boot is ready
- **THEN** the entry `de.csv` has `origin` `{runId: "r1", stepId: "s1"}`
- **AND** an entry with no ledger row has `origin` `null`

#### Scenario: One ledger read for each page

- **GIVEN** analysis `a1`, and a folder of its workspace that holds 150 files
- **WHEN** a client lists the folder with `analysisId=a1` and `perPage=100`
- **THEN** the server sends one ledger read with the 100 relative paths of the page

#### Scenario: A folder outside the workspace

- **GIVEN** analysis `a1`, and a folder outside its workspace folder
- **WHEN** a client lists the folder with `analysisId=a1`
- **THEN** the server sends no ledger read, and each `origin` is `null`

#### Scenario: The origin before the runtime boot is ready

- **GIVEN** analysis `a1`, and a server whose runtime boot is not ready
- **WHEN** a client lists a folder of the workspace of `a1` with `analysisId=a1`
- **THEN** the server answers 200, and each `origin` is `null`

### Requirement: The file system routes read each path with no root limit

Each route under `/api/v1/fs` MUST take each path as an absolute path. The client MUST expand `~` with the home path before it sends a path. The server MUST remove each `.` and `..` segment of a path as text, before it resolves a symbolic link. Each path that a route gives MUST be absolute, with each symbolic link of its folders resolved. The one exception is `link.target` of a list entry, because it is the text that the link stores. The server MUST change a path to a relative path only inside its own code.

The routes MUST NOT limit a path to a root. A person can browse and preview each place on the machine. The routes give what the same OS user can read with `ls -l` and `cat`. The routes MUST NOT write to the disk. The one exception is the lock file of the instance lock that the guard of `analysisId` takes. The folder list reads the artifact ledger through the harness runtime for `origin` only. Each route MUST answer while the boot of the runtime is not ready.

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

## ADDED Requirements

### Requirement: The server gives a preview of a file or a folder

`GET /api/v1/fs/preview?path=<absolute path>` MUST give one member of the preview union for the file or the folder at the path. The path can name each file and each folder of the machine. The query value `analysisId` MUST NOT change the preview.

The server MUST remove each `.` and `..` segment of the path as text. It MUST resolve each symbolic link of the path, and preview the real path. Thus a link gives the preview of its target. A symbolic link that replaces the last part of the real path after this resolve MUST NOT give a preview of its target. For a folder, the server MUST make sure after the read that the real path is still the folder that it opened. Otherwise it MUST answer 403 `forbidden`.

The kind of a file comes from the name of the real path, through the kind map of the file system routes. The members are:

- `figure`, for a regular file of the kind `figure`: `{kind, src, alt}`. `src` is the URL of the read route for the real path, `/api/v1/fs/read?path=<the encoded real path>`, relative to the origin of the server. `alt` is the name of the file. The server MUST NOT read the bytes of a figure.
- `folder`, for a folder: `{kind, items, kinds, names}`. `items` is the count of the entries that are not hidden, in one level of the folder. `kinds` gives `{kind, count}` for each kind with a count above 0: `folder` first, then the order of the kind map. An entry whose name has no kind counts in `items` only. `names` gives `{name, dir, kind}` for the first 10 entries in the order of the folder list. `dir` is true for a folder, and `kind` is `null` for a folder. The kind and `dir` come from the folder read. Thus the server takes no `stat` of an entry, and a link to a folder counts as a file.
- `table`, for a file of the kind `table` whose head holds the full header record, and whose header holds a tab or a comma: `{kind, text, separator, columnCount, rowCount}`. The header record is the text before the first line end outside double quotes. `text` is the text of the head. `separator` is a tab when the header holds one, and a comma otherwise. `columnCount` is the count of the fields of the header. A separator inside double quotes does not split a field. `rowCount` is the count of the records after the header when the head holds the full file, and `null` otherwise. A line end inside double quotes does not end a record. An empty last line does not count.
- `text`, for each other file whose head is text: `{kind, language, code}`. `code` is the text of the head. `language` comes from the extension of the name: `python`, `r`, `bash`, `toml`, `json`, `markdown`, `yaml`, `csv`, `tsv`, or `log`. It is `text` for an extension that the server does not map.
- `card`, for a file whose head holds a NUL byte, or a byte sequence that is not UTF-8: `{kind, format}`. `format` is the extension of the name in lower case, or `null` for a name with no extension.

The server MUST read at most a fixed maximum count of bytes from the start of a file, the head. When the file is longer than the head, the text of the head MUST end at its last line end. A head with no line end keeps its text, and it ends at its last whole character. A head holds the full header record when it holds the full file, or when it holds a line end outside double quotes. A head that does not hold the full header record never gives `table`.

The server MUST read one level of a folder, with no `stat` for an entry. Its memory MUST NOT grow with the count of the entries.

The server MUST run each disk operation of the route off the event loop. A file or a folder on a hung mount MUST stop only its own request. The route MUST lift the idle timeout of its connection.

#### Scenario: A table

- **GIVEN** the file `counts.csv` with the text `gene,"a,b",c\nTP53,1,2\nEGFR,3,4\n`
- **WHEN** a client asks for the preview of the file
- **THEN** the server answers 200 with `kind` `table`, the full text, the separator `,`, `columnCount` 3, and `rowCount` 2

#### Scenario: A table longer than the head

- **GIVEN** a TSV file that is longer than the head
- **WHEN** a client asks for its preview
- **THEN** the member is `table` with the separator tab, the text ends with a line end, and `rowCount` is `null`

#### Scenario: A text file

- **GIVEN** the file `analysis.py`
- **WHEN** a client asks for its preview
- **THEN** the member is `text` with the language `python` and the text of the file

#### Scenario: A table file with no separator

- **GIVEN** the file `notes.txt` whose first line holds no tab and no comma
- **WHEN** a client asks for its preview
- **THEN** the member is `text`

#### Scenario: A binary file

- **GIVEN** the file `matrix.h5ad`, whose head holds a NUL byte
- **WHEN** a client asks for its preview
- **THEN** the member is `card` with the format `h5ad`

#### Scenario: A figure

- **GIVEN** the file `<P>/volcano.png`
- **WHEN** a client asks for its preview
- **THEN** the member is `figure` with `src` `/api/v1/fs/read?path=<the encoded path of the file>` and `alt` `volcano.png`

#### Scenario: A folder

- **GIVEN** a folder that holds the folder `raw`, the files `a.csv`, `b.csv`, `plot.png`, and `README`, and the file `.cache`
- **WHEN** a client asks for its preview
- **THEN** the member is `folder` with `items` 5
- **AND** `kinds` is `[{kind: "folder", count: 1}, {kind: "table", count: 2}, {kind: "figure", count: 1}]`
- **AND** `names` starts with `raw`, with `dir` true

#### Scenario: A link to a file

- **GIVEN** a symbolic link `latest.csv` to the file `run7.csv`
- **WHEN** a client asks for the preview of the link
- **THEN** the member is the preview of `run7.csv`

#### Scenario: A folder that is not the opened folder after the read

- **GIVEN** a folder whose real path names a different folder after the server opened it
- **WHEN** the server ends the read of the folder
- **THEN** the server answers 403 `forbidden`

#### Scenario: A link that replaces the file after the resolve

- **GIVEN** a file whose last part becomes a symbolic link after the server resolved the path
- **WHEN** the server opens the real path
- **THEN** the server answers 403 `forbidden`, and the response holds no byte of the target

### Requirement: The preview route refuses a bad request with a named error

The preview route MUST give these errors:

- 400 `validation_error` when `path` is absent or empty, is not absolute, or holds a NUL byte
- 404 `not_found` when the path does not exist. A symbolic link to a path that does not exist also gets 404. A loop of symbolic links, and a path with a part that is not a folder, also get 404.
- 400 `validation_error` when the path names an entry that is not a regular file and not a folder. A platform can fail the real path of a socket. Then the socket gets 403 by the last rule.
- 403 `forbidden` when a symbolic link replaces the last part of the real path after the server resolved it
- 403 `forbidden` for each other failure of the resolve, of the open, of the facts, or of the read. The message names the cause, and `details.code` holds the error code of the operating system.

The errors of the query value `analysisId` come from the guard of the file system routes.

#### Scenario: A relative path

- **WHEN** a client sends `GET /api/v1/fs/preview?path=data/counts.csv`
- **THEN** the server answers 400 `validation_error`

#### Scenario: A path that does not exist

- **WHEN** a client asks for the preview of an absolute path that does not exist
- **THEN** the server answers 404 `not_found`

#### Scenario: An unreadable file

- **GIVEN** a file whose mode is 000, and a server that does not run as root
- **WHEN** a client asks for its preview
- **THEN** the server answers 403 `forbidden`, and `details.code` is `EACCES`
