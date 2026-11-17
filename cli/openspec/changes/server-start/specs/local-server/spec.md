## ADDED Requirements

### Requirement: inflexa server start runs the server in the background

`inflexa server start` MUST start the server as a detached child in a session of its own. The child MUST use the home folder as its working folder, and its stdout and stderr MUST go to the end of the server log. The command MUST return when the server answers, or fail with the reason and the path of the log. When a server already answers, it MUST start no second server and say which server runs. The CLI MUST have no command that runs the server in the foreground of a terminal.

The server MUST write each step of its boot as plain lines: one line at the start of the step, and one line for its outcome. A spinner frame in the log would be one more line for each frame.

#### Scenario: The background server outlives its terminal

- **WHEN** the person runs `inflexa server start` and then closes the terminal
- **THEN** the server keeps running, and its output goes to the server log

#### Scenario: A start finds a running server

- **GIVEN** a server that answers
- **WHEN** the person runs `inflexa server start`
- **THEN** the command starts no server, and it prints the pid and the port of the running server

#### Scenario: The boot writes plain lines

- **WHEN** the server verifies the provider login during its boot
- **THEN** the server log gets one line for the start of the check and one line for its outcome, and no spinner frame

### Requirement: The server log rotates at 10 MiB

The server log is `<dataDir>/inflexa/logs/server.log`, or `server.dev.log` for a dev build. The server MUST measure its log each minute. At 10 MiB, it MUST copy the log to one old file, `<log>.1`, and then truncate the log. A rename is not permitted, because the server keeps the descriptor that it got at its start. `inflexa server start` MUST also do this step before it starts the child.

#### Scenario: A large log rotates

- **GIVEN** a server log of 10 MiB
- **WHEN** the server measures its log
- **THEN** `<log>.1` holds the old lines, and the log is empty

## MODIFIED Requirements

### Requirement: The server binds the loopback port of its build channel

The server MUST bind `127.0.0.1` only, on the fixed port of its build channel: 8431 for a production build and 8436 for a dev build. It MUST bind the port before it writes the discovery file. Thus a second server fails at the bind, and it never replaces the file of the server that holds the port. A failed bind MUST name the pid of the running server when the discovery file names a live server on that port. Otherwise the message MUST say that a different process holds the port.

#### Scenario: A second server stops at the bind

- **GIVEN** a server that holds port 8436
- **WHEN** a second server of the dev build starts
- **THEN** it exits with a message that names the pid of the first server, and the discovery file stays as it was

### Requirement: A client starts a server when none answers

An `instance` command MUST connect to the server before its action runs. The client MUST read the discovery file and probe `GET /api/v1/server` with a limit of 2 s. A server that answers in any phase counts. A file whose pid is dead is stale, and the client MUST remove it, after it reads the file again.

When no server answers, the client MUST take the `server-spawn` lock, read the file again, and run `inflexa server start`. Then it MUST probe until the server answers, up to 30 s. A client that finds the lock held MUST start nothing, and it MUST wait for the server that the holder starts. Thus two clients that find no server start one server. The client MUST tell the person that it starts the server, and it MUST name the server log.

A server whose `apiVersion` differs from the API version of the client MUST be refused, with the instruction to run `inflexa server stop`.

#### Scenario: The first command starts the server

- **GIVEN** no server runs
- **WHEN** the person runs `inflexa ls`
- **THEN** the command starts the server in the background, waits until it answers, and lists the analyses

#### Scenario: Two clients start one server

- **GIVEN** no server runs
- **WHEN** two `instance` commands start at the same time
- **THEN** one of them starts the server, and both use that server

#### Scenario: A server of a different API version

- **WHEN** the server answers with an `apiVersion` that the client does not speak
- **THEN** the command fails, names the two versions, and tells the person to run `inflexa server stop`

### Requirement: The server process runs with a large file pool

The server process MUST request a file pool of at least 64 threads, and at least 4 threads for each core, when the CLI sets the pool. The pool size comes from the variable `UV_THREADPOOL_SIZE` of the process, and the runtime clamps it to 2 to 1024. When the environment of the person already sets the variable, the server MUST keep that value and request nothing. Thus a hung mount that holds the 16 threads of one staging walk, or the reads of one folder list, leaves threads for each other file call of the server.

`inflexa server start` MUST give the value to its detached child in the environment of the child, on each platform.

The walk child of a search MUST NOT get the large pool. Its environment MUST hold no `UV_THREADPOOL_SIZE`, also when the person set one, thus it runs with the default pool. A large pool makes a walk about two times slower.

#### Scenario: A hung mount leaves threads for the other calls

- **GIVEN** a server-like process that started with the pool of the server, and at least 16 file opens that never return, 2 times the core count when that is more
- **WHEN** the process reads a folder
- **THEN** the read answers

#### Scenario: The detached child gets the pool

- **WHEN** `inflexa server start` starts its child
- **THEN** the environment of the child holds `UV_THREADPOOL_SIZE` with the value of the server

#### Scenario: A value of the person stays

- **GIVEN** an environment that sets `UV_THREADPOOL_SIZE=8`
- **WHEN** the server starts
- **THEN** the pool size of the server stays 8

#### Scenario: The walk child keeps the default pool

- **GIVEN** a server whose environment holds `UV_THREADPOOL_SIZE`
- **WHEN** the server starts a walk child
- **THEN** the environment of the child holds no `UV_THREADPOOL_SIZE`

### Requirement: The server commands start, inspect, and stop the server

The `server` commands MUST be `machine` or `standalone` commands.

- `inflexa server start` MUST start the server in the background, as the requirement "inflexa server start runs the server in the background" says.
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
- **THEN** the help lists `start`, `status`, `stop`, and `logs`, and not `walk`

## REMOVED Requirements

### Requirement: inflexa serve runs in the foreground or in the background

**Reason**: The server runs in the background only. A foreground server held a terminal open, and `inflexa server logs --follow` shows the output of the background server.

**Migration**: Use `inflexa server start`.

## RENAMED Requirements

- FROM: `### Requirement: The server commands inspect and stop the server`
- TO: `### Requirement: The server commands start, inspect, and stop the server`
