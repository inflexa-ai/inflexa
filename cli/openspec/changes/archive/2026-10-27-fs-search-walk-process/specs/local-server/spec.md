# Spec Delta

## ADDED Requirements

### Requirement: The walk of a search runs in a child process

The server MUST run the walk of a search in a child process. The server MUST start the child as the CLI binary itself, with the hidden command `inflexa server walk <scope>`. The start uses the self-invocation of the detached server and the transfers. A read that hangs in the kernel then holds a thread of the child, and never a thread of the server. Each other request of the server MUST answer while a walk child hangs.

The child MUST walk with the rules of the walk. These are one read of the names and the types of each folder, no `stat`, and no entry into a symbolic link. The hidden filter, the depth cap, and the skip of an unreadable folder also apply. It MUST write one compact binary record for each entry to its stdout, in large buffers. A record holds the parent index, the type, and the name bytes. A failed read of the scope itself MUST be a record that carries the error code, thus the search keeps its 404, 400, and 403 answers. The child MUST write a record when the read of the scope lands, and a record at the end of the walk. A stream that ends without the end record MUST leave the index truncated.

The server MUST build the name index from the stream, with no full path and no string for each entry. The server MUST own each cap. The caps are the count of entries of one index, the total across the indexes, the time budget, the TTL, and the eviction. When a cap cuts a walk, or when the server evicts its index, the server MUST kill the child with `SIGKILL` at once. The same applies when the cache stops. It MUST NOT wait for the exit of the child. A child that does not die MUST hold no resource of the server.

The child MUST exit when the server is gone: a write to the closed pipe, or a check of the parent process, ends it.

The server MUST bound the count of walk children that it reads. A child frees its slot at the end of its stream or at its kill. A walk beyond the bound MUST wait in a queue for a free slot, in the order of the searches. A search on a walk in the queue MUST wait for the start of its child at most the short bound (500 ms). When the child starts in that time, the search MUST wait for the read of the scope, as each search does. When it does not, the search MUST answer with no hit and `truncated` true, and a later search gives the scope error.

A failed start of the child MUST give 500 `internal_error` to the search.

#### Scenario: A hung read stalls no other request

- **GIVEN** a walk child whose reads never return
- **WHEN** a client sends `GET /api/v1/fs/list` for a different folder
- **THEN** the server answers the list

#### Scenario: The time budget kills the child

- **GIVEN** a walk child that writes nothing
- **WHEN** the time budget of the walk passes
- **THEN** the server sends `SIGKILL` to the child, and the next search answers with `truncated` true

#### Scenario: The entry cap kills the child

- **GIVEN** a server whose entry cap for one index is 10, and a child that streams 100 records
- **WHEN** a client searches the scope
- **THEN** the server sends `SIGKILL` to the child, the index holds at most 10 entries, and `truncated` is true

#### Scenario: An eviction kills the child

- **GIVEN** a walk child that still runs
- **WHEN** the server evicts its index
- **THEN** the server sends `SIGKILL` to the child

#### Scenario: A failed scope read keeps its answer

- **GIVEN** a scope that does not exist
- **WHEN** a client searches it
- **THEN** the child writes the error record, and the server answers 404 `not_found`

#### Scenario: The records build the same index

- **GIVEN** a temp tree with folders, files, a symbolic link, and a hidden entry
- **WHEN** the child walks it and the server reads the records
- **THEN** the index holds the same entries, parents, types, and names as a walk of the tree in the server process

#### Scenario: A walk waits for a slot

- **GIVEN** a server whose bound on walk children is 1, and a walk child that runs
- **WHEN** a client searches a second scope
- **THEN** the second child starts after the first child ends, and the second search answers with `truncated` true after the short bound

#### Scenario: A stream that ends early leaves the index truncated

- **GIVEN** a walk child that exits after some records and before the end record
- **WHEN** a client searches the scope after the exit
- **THEN** the hits come from the records that landed, and `truncated` is true

## MODIFIED Requirements

### Requirement: A search walks a scope one time and keeps a name index

The server MUST keep one name index for each canonical scope and `hidden` value. The first search of a scope MUST start the walk of the scope. A later search of the same scope MUST score the index in memory, while the walk runs or after it. It MUST NOT start a second walk. Two concurrent searches of one scope MUST share one walk.

A search during the walk MUST score the entries that the walk reached so far, with `truncated` true. A search MUST wait for the read of the scope itself. Then it MUST wait for the walk only until a short bound (500 ms) after the start of the walk. Thus a search of a small scope answers complete in one request, and a later keystroke during the walk answers at once.

The walk MUST read each folder with one read of its names and types. It MUST take no `stat` of an entry. It MUST NOT enter a symbolic link. It MUST skip a folder that it cannot read, and the search MUST still answer. The walk MUST read folders in a queue of fixed width. The walk MUST run in a child process of the server.

The index MUST keep the name and the parent of each entry. It MUST NOT keep a full path string for each entry. The server MUST build the full path of a hit only for the hits of a response.

A client disconnect MUST NOT stop the walk. The walk belongs to the index, and the next keystroke of the same picker reads the same index. The walk stops only at a cap, at the end of the scope, or when the server evicts the index.

#### Scenario: A second search scores the index

- **GIVEN** a scope whose walk is complete
- **WHEN** a client searches the scope a second time with a different `q`
- **THEN** the server reads no folder of the scope, and it answers from the index

#### Scenario: Concurrent searches share one walk

- **WHEN** two clients search one scope at the same time
- **THEN** the server starts one walk child for the scope

#### Scenario: An unreadable folder is skipped

- **GIVEN** a scope that holds the folder `locked` with mode 000 and the file `open.csv`
- **WHEN** a client searches the scope for `open`
- **THEN** the server answers 200 with `open.csv`, and `locked` is an entry of the index
- **AND** `truncated` is false after the walk ends

#### Scenario: A symbolic link is not entered

- **GIVEN** a scope that holds a link `ext` to a folder that holds `deep.csv`
- **WHEN** a client searches the scope for `deep`
- **THEN** the hits are empty, and a search for `ext` gives the link entry

#### Scenario: A disconnect keeps the walk

- **GIVEN** a search whose walk runs
- **WHEN** the client closes the connection before the response
- **THEN** the walk continues, and the next search of the scope finds the index more complete

### Requirement: The server commands inspect and stop the server

The `server` commands MUST be `machine` or `standalone` commands: none of them starts a server.

- `inflexa server status` MUST show if a server runs. For a running server, it MUST show the pid, the port, the phase, the start time, the versions, the active work, and the log path. `--json` MUST give the same data as one JSON document. It MUST write nothing: a stale discovery file stays for `server stop`.
- `inflexa server stop` MUST send the stop request with the mode `now`, or `drain` with `--drain`. Then it MUST wait for the exit of the pid, up to 60 s for `now` and 120 s for `drain`. With no server, it MUST say so and succeed. A stale discovery file MUST be removed. A live pid that does not answer MUST fail with the pid to end.
- `inflexa server logs` MUST print the path of the server log and its last lines, 50 by default or `--lines <n>`. `--follow` MUST then print each line that the server appends, also across a rotation, until Ctrl+C. Its cost MUST follow the count of lines, not the size of the file.
- `inflexa server walk <scope> [--hidden] [--depth <n>] [--width <n>]` MUST walk the scope and write the binary records of the walk to stdout. It MUST be hidden from the help. It is the child of a search, and it is not a command for a person.

#### Scenario: A stop with no server

- **GIVEN** no discovery file
- **WHEN** the person runs `inflexa server stop`
- **THEN** the command prints that no server runs and exits 0

#### Scenario: The status of a running server

- **WHEN** the person runs `inflexa server status --json` and a server answers
- **THEN** the document has the state `running`, the pid, the port, the phase, the versions, the activity, and the log path

#### Scenario: The walk command is hidden

- **WHEN** the person runs `inflexa server --help`
- **THEN** the help lists `status`, `stop`, and `logs`, and not `walk`
