## ADDED Requirements

### Requirement: The execId dedup survives a restart

The sandbox-server MUST keep a record of each `execId`, with the status `running`, `completed`, or `failed`, and with no TTL. A `POST /exec` for a known `execId` MUST spawn no second command, and it MUST return HTTP 202 with the status of the record. The server MUST write each record to `EXEC_RECORD_DIR` at the submit and at the end, through a temporary file and a rename. At start, it MUST read each record.

#### Scenario: Duplicate submit returns existing state without re-spawning

- **GIVEN** a previous `POST /exec` with `execId: "x1"` whose record is `running`
- **WHEN** a second `POST /exec` arrives with the same `execId: "x1"`
- **THEN** the server responds with HTTP 202 and the body `{ "execId": "x1", "status": "running" }`
- **AND** no second command process spawns for `x1`

#### Scenario: Duplicate submit after completion returns completed state

- **GIVEN** a previous `POST /exec` with `execId: "x2"` that completed
- **WHEN** a second `POST /exec` arrives with the same `execId: "x2"`, at any time later in the life of the process
- **THEN** the server responds with HTTP 202 and the status of the existing record
- **AND** no command spawns again, and a poll of `x2` gives the first result

#### Scenario: A completed record survives a restart

- **GIVEN** a sandbox-server that recorded `execId: "x3"` as completed in its record directory
- **WHEN** a new sandbox-server process starts on the same record directory
- **THEN** a `POST /exec` with `execId: "x3"` spawns no command
- **AND** a poll of `x3` gives the first result

#### Scenario: A reader never sees a part of a record

- **GIVEN** a process that stops while it writes the end of the record of `x6`
- **WHEN** a new sandbox-server process reads the directory
- **THEN** it reads the earlier whole record of `x6`, or a lost record for `x6`

### Requirement: The server does not start without a record directory

The sandbox-server MUST refuse to start when `EXEC_RECORD_DIR` is absent. The sandbox module mounts the directory of each lease into each machine of the lease.

#### Scenario: No record directory, no start

- **GIVEN** an environment with no `EXEC_RECORD_DIR`
- **WHEN** the sandbox-server starts
- **THEN** it exits with an error that names `EXEC_RECORD_DIR`, and it serves no request

### Requirement: A restart marks each running record lost

At start, the sandbox-server MUST change each `running` record into a `failed` record. The result of that record MUST carry `lost: { reason: "sandbox-replaced" }` and no exit code. The name of a record file is `base64url(execId).json`. A file that the server cannot read MUST become a lost record for the exec id of its name. A bad file MUST NOT stop the start.

#### Scenario: A running record becomes lost

- **GIVEN** a record directory that holds the record of `execId: "x4"` with the status `running`
- **WHEN** a new sandbox-server process starts on that directory
- **THEN** a poll of `x4` gives the status `failed` and a result with `lost: { reason: "sandbox-replaced" }`
- **AND** a `POST /exec` with `execId: "x4"` spawns no command

#### Scenario: An unreadable record becomes lost

- **GIVEN** a record directory that holds a file for `execId: "x5"` with bytes that do not parse
- **WHEN** a new sandbox-server process starts on that directory
- **THEN** the server starts, and a poll of `x5` gives a lost result

### Requirement: Each exec gets its own temporary directory

For each exec, the sandbox-server MUST make a new directory under `/tmp` before it spawns the command. It MUST give the directory to the command as `TMPDIR`. It MUST delete the directory when the command ends, on each exit. Thus no exec keeps state for a later exec outside the mounts.

#### Scenario: Two execs get two directories

- **WHEN** two execs run, one after the other
- **THEN** each command reads a different `TMPDIR`
- **AND** the directory of the first exec is gone when the second exec starts

#### Scenario: A failed command leaves no directory

- **GIVEN** a command that exits with code 1
- **WHEN** the sandbox-server reaps the process
- **THEN** the `TMPDIR` of the exec is gone

### Requirement: The health answer counts the running execs

`GET /health` MUST answer HTTP 200 with `{ status: "ok", runningExecs: n }`. `n` is the count of the records with the status `running`. The lease workflow reads `n` before an idle removal, thus a command that runs keeps its machine.

#### Scenario: A running command shows in the count

- **GIVEN** one command that runs
- **WHEN** a client calls `GET /health`
- **THEN** the answer is HTTP 200 with `runningExecs: 1`

#### Scenario: An idle server counts zero

- **GIVEN** a sandbox-server with no command that runs
- **WHEN** a client calls `GET /health`
- **THEN** the answer is HTTP 200 with `runningExecs: 0`

## REMOVED Requirements

### Requirement: execId idempotency dedup

**Reason**: The map of the records no longer stays in memory only, thus a record survives a restart of the server. The requirement "The execId dedup survives a restart" replaces it.

**Migration**: The sandbox module gives `EXEC_RECORD_DIR` to each machine of a lease. A caller that starts the image directly must give a writable directory in `EXEC_RECORD_DIR`.
