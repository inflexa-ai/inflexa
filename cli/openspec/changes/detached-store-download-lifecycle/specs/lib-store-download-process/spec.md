## ADDED Requirements

### Requirement: The catalog download runs as a detached process

`inflexa setup` SHALL start the catalog download as a process that outlives it.
The process SHALL run to completion after the command that started it exits. It
SHALL write nothing to the terminal of the starter.

A user who ends `inflexa setup` SHALL NOT lose the transfer. A user who quits the
app SHALL NOT lose it either.

The app SHALL NOT start a download. The app reads the state, and it reports the
state. No app-open trigger SHALL remain.

#### Scenario: Setup exits and the transfer continues

- **GIVEN** `inflexa setup` started the download
- **WHEN** the setup command exits
- **THEN** the process is still live, and the transfer continues

#### Scenario: The app quits and the transfer continues

- **GIVEN** a live download and an open app
- **WHEN** the user quits the app
- **THEN** the process is still live, and the transfer continues

#### Scenario: The app starts no download

- **GIVEN** a machine with no store and no live downloader
- **WHEN** the app opens
- **THEN** the app reports the absent store and starts no process

### Requirement: The lifecycle has five states

The download SHALL be in exactly one of these states: `pending`, `running`,
`installed`, `failed`, or `declined`.

The permitted transitions are:

- `pending` to `running`, when the process takes the lock and starts the transfer
- `running` to `installed`, when the receipt lands
- `running` to `failed`, when the transfer stops for any reason
- `failed` to `pending`, and `declined` to `pending`, on a retry

`declined` SHALL record a setup answer of no. The state SHALL NOT change by
itself, and only a retry SHALL leave `failed` or `declined`.

#### Scenario: A refused consent records a declined state

- **WHEN** the user answers no to the download consent of setup
- **THEN** the state is `declined`, and no process starts

#### Scenario: A retry leaves a terminal state

- **GIVEN** a state of `failed`
- **WHEN** the user retries the download
- **THEN** the state is `pending`, then `running`

### Requirement: One database row reports the progress

The CLI SHALL keep one row that records the state of the download. The row SHALL
carry these values:

- the state
- the bytes transferred, and the total bytes
- the layers completed, and the total layers
- the manifest digest
- a message
- the process identifier of the holder

The download process SHALL write the row as the transfer advances. Any other
process SHALL read it without a lock. The database runs in WAL mode, thus a read
never blocks the write.

The message SHALL name the fault and the remedy when the state is `failed`. It
SHALL be readable by a user, and it SHALL NOT be a stack trace.

#### Scenario: A second process reads the progress

- **GIVEN** a live download that writes the row
- **WHEN** the app reads the row
- **THEN** it obtains the state and the byte totals, and the write is not blocked

#### Scenario: A failure names its remedy

- **GIVEN** a download that stopped because the registry was unreachable
- **WHEN** a reader reads the row
- **THEN** the state is `failed` and the message names the fault and the remedy

### Requirement: The receipt owns what is installed, and the row owns what runs

The receipt on disk SHALL stay the one record of what the store holds. The
harness, and each reader that decides store usability, SHALL read the filesystem.
Neither SHALL read the database.

The database row SHALL describe the process only. It SHALL NOT decide whether a
sandbox can start.

A store root can arrive by a route that wrote no row, for example a manual pull or
`inflexa store add`. Such a store SHALL read as usable, and the absent row SHALL
NOT make it unusable.

#### Scenario: A store with no row is usable

- **GIVEN** a complete store root whose receipt is valid, and no download row
- **WHEN** a sandbox action runs
- **THEN** the store is usable, and the absent row changes nothing

#### Scenario: An installed row does not make a store usable

- **GIVEN** a row that reports `installed`, and a store root whose receipt is absent
- **WHEN** a sandbox action runs
- **THEN** the gate refuses, because the filesystem is what decides

### Requirement: The instance lock reports the liveness of the downloader

The download process SHALL hold the instance lock `lib-store-download` for its
whole life. The CLI SHALL read the holder of that lock to decide whether a
downloader is live.

A row that reports `running` with no live holder SHALL read as `failed`. The CLI
SHALL NOT depend on a heartbeat, and it SHALL NOT depend on a wall-clock timeout.
A killed process leaves no `failed` write, thus the lock is the only sound signal.

The probe SHALL be read-only. It SHALL NOT take the lock, because a reader that
took it would refuse the next real downloader.

#### Scenario: A killed downloader reads as failed

- **GIVEN** a row that reports `running`, whose holder process is gone
- **WHEN** the app reads the state
- **THEN** the state reads as `failed`, and the app offers a retry

#### Scenario: The probe does not take the lock

- **GIVEN** a live downloader that holds the lock
- **WHEN** a second process probes the holder
- **THEN** the probe reports the holder, and the live downloader keeps the lock

### Requirement: One downloader runs at a time

The CLI SHALL run at most one download process for one store root. A start that
finds the lock held SHALL start no second process. It SHALL report the run that is
live.

#### Scenario: A second start finds the first

- **GIVEN** a live download
- **WHEN** the user runs the download command again
- **THEN** no second process starts, and the command reports the live run

### Requirement: `inflexa store download` starts a run or reports one

The CLI SHALL give `inflexa store download`. It SHALL start a run when none is
live, and it SHALL report the live run otherwise. `--force` SHALL start a transfer
over a receipt that pins the current manifest.

The command SHALL take the `approval` policy, because it writes the store root.
Thus the conversation agent can retry the download after the user confirms.

`inflexa store ls` SHALL report the download state beside the farms. It SHALL stay
prompt-free, and it SHALL gain no option.

#### Scenario: A retry after a failure

- **GIVEN** a state of `failed`
- **WHEN** `inflexa store download` runs
- **THEN** a new process starts, and the state moves to `running`

#### Scenario: A retry over a complete store does nothing

- **GIVEN** a receipt that pins the current manifest
- **WHEN** `inflexa store download` runs without `--force`
- **THEN** the command reports the store as up to date, and it starts no process

#### Scenario: The agent retries after the user confirms

- **GIVEN** a state of `failed`, and a user who asks the agent to retry
- **WHEN** the agent runs the command
- **THEN** the CLI asks the user to approve, and the run starts after the approval

#### Scenario: The listing reports the download state

- **WHEN** `inflexa store ls` runs during a transfer
- **THEN** the output names the state and the byte totals, and it prompts for nothing
