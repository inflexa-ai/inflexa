# lib-store-download-process Specification

## Purpose

This capability is the lifecycle of the detached process that downloads the package
store catalog. `inflexa setup` starts the process, and the process outlives both
setup and the app. The download has six states, and one database row records the
progress.

The instance lock reports whether a downloader is live, and one downloader runs at
a time. The receipt on disk owns what the store holds, and the row owns what the
process does.

`inflexa store download` starts a run or reports the live one. `inflexa store
cancel` stops a live transfer. The sidebar reports the transfer with the run meter,
and the agent reads the state to continue the conversation.

## Requirements

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

### Requirement: The lifecycle has six states

The download SHALL be in exactly one of these states: `pending`, `running`,
`installed`, `failed`, `declined`, or `canceled`.

The permitted transitions are:

- `pending` to `running`, when the process takes the lock and starts the transfer
- `running` to `installed`, when the receipt lands
- `running` to `failed`, when the transfer stops for any reason
- `running` to `canceled`, when the user stops the transfer
- `failed` to `pending`, on a retry
- `declined` to `pending`, on a retry
- `canceled` to `pending`, on a retry

`declined` SHALL record a consent of no at setup. That answer starts no transfer,
thus a declined run writes no staged tree.

`canceled` SHALL record a transfer that started and that the user stopped. Such a
run leaves a partial staged tree, and the CLI SHALL remove that tree.

The state SHALL NOT change by itself. Only a retry SHALL leave `failed`,
`declined`, or `canceled`.

#### Scenario: A refused consent records a declined state

- **WHEN** the user answers no to the download consent of setup
- **THEN** the state is `declined`, and no process starts

#### Scenario: A declined run leaves no staged tree

- **GIVEN** a state of `declined`
- **WHEN** a reader inspects the staging path
- **THEN** no staged tree is there, because the run started none

#### Scenario: A stopped transfer records a canceled state

- **GIVEN** a live transfer
- **WHEN** the user runs `inflexa store cancel`
- **THEN** the state is `canceled`, and the partial staged tree is gone

#### Scenario: A retry leaves a terminal state

- **GIVEN** a state of `failed`
- **WHEN** the user retries the download
- **THEN** the state is `pending`, then `running`

#### Scenario: A retry leaves the canceled state

- **GIVEN** a state of `canceled`
- **WHEN** the user runs `inflexa store download`
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

The manifest declares the size of every layer before the first byte arrives. Thus
the total bytes and the total layers SHALL be exact when the manifest resolves.
Neither total SHALL grow after that moment.

The two totals SHALL be absent only before the manifest resolves. A reader that
meets an absent total SHALL report the resolve step, and it SHALL NOT report an
estimate. The CLI SHALL NOT compute a total that grows as the transfer advances.

#### Scenario: A second process reads the progress

- **GIVEN** a live download that writes the row
- **WHEN** the app reads the row
- **THEN** it obtains the state and the byte totals, and the write is not blocked

#### Scenario: A failure names its remedy

- **GIVEN** a download that stopped because the registry was unreachable
- **WHEN** a reader reads the row
- **THEN** the state is `failed` and the message names the fault and the remedy

#### Scenario: The totals are exact from the resolved manifest

- **GIVEN** a manifest that declares the size of every layer
- **WHEN** the transfer advances through the layers
- **THEN** the total bytes and the total layers keep the values the manifest declared

#### Scenario: The totals are absent before the manifest resolves

- **GIVEN** a run that has not resolved the manifest
- **WHEN** a reader reads the row
- **THEN** the totals are absent, the reader reports the resolve step, and it gives no estimate

### Requirement: An exhausted disk names the byte counts and leaves no partial tree

A transfer that exhausts the disk SHALL move the state to `failed`. The message
SHALL name the bytes necessary and the bytes available. A bare "no space left"
tells a user nothing about how much disk to free.

The CLI SHALL remove the partial transfer on that failure. The staged tree SHALL
NOT stay on disk, and the store root SHALL keep the content that it held before
the run. A retry SHALL start from the state that the receipt reports.

#### Scenario: A full disk names the byte counts

- **GIVEN** a transfer that cannot write its next layer, because the disk is full
- **WHEN** the run stops
- **THEN** the state is `failed`, and the message names the bytes necessary and the bytes available

#### Scenario: A full disk leaves no partial tree

- **GIVEN** a transfer that stopped because the disk was full
- **WHEN** a reader inspects the store root
- **THEN** the staged tree is gone, and the store root holds what it held before the run

### Requirement: The sidebar reports the transfer with the run meter

The sidebar SHALL report the transfer with the progress meter that the run rail
uses. The meter cell is the `bar` glyph of the design system, which is U+25AE. The
filled cells SHALL take the `success` palette role. The empty cells SHALL take the
`fgSubtle` role.

The sidebar SHALL be the one surface that carries the meter for the download. Two
surfaces must not show one figure. Thus the hold text of the sandbox gate stays
bare text, and it carries no meter.

The sidebar SHALL compute the meter from the byte totals of the row. Before the
manifest resolves the totals are absent. Then the sidebar SHALL report the resolve
step, and it SHALL render no meter.

#### Scenario: The sidebar renders the meter

- **GIVEN** a live transfer whose row carries the byte totals
- **WHEN** the sidebar renders
- **THEN** it draws the meter from the two totals, with the filled cells in the `success` role

#### Scenario: The sidebar renders no meter before the manifest resolves

- **GIVEN** a run that has not resolved the manifest
- **WHEN** the sidebar renders
- **THEN** it reports the resolve step and draws no meter

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
live, and it SHALL report the live run otherwise.

`--update` SHALL be the consent to apply a moved tag. With a receipt present and
no flag, a manifest digest that matches the receipt SHALL give `up_to_date`. A
manifest digest that differs SHALL give `update_available`, and the run SHALL
transfer nothing. With `--update`, the run SHALL transfer the layers of the newer
manifest.

`--update` SHALL NOT be a way to transfer a healthy store a second time. A store
that already pins the current manifest stays as it is under the flag.

The command SHALL take the `approval` policy, because it writes the store root.
Thus the conversation agent can retry the download after the user confirms.

`inflexa store ls` SHALL report the download state beside the farms. It SHALL stay
prompt-free, and it SHALL gain no option.

`inflexa store cancel` SHALL be the command that stops a live run. It is a
separate subcommand, and it is not a flag on `inflexa store download`.

#### Scenario: A retry after a failure

- **GIVEN** a state of `failed`
- **WHEN** `inflexa store download` runs
- **THEN** a new process starts, and the state moves to `running`

#### Scenario: A current receipt reports up to date

- **GIVEN** a receipt whose manifest digest matches the resolved manifest
- **WHEN** `inflexa store download` runs without `--update`
- **THEN** the command reports the store as up to date, and it starts no transfer

#### Scenario: A moved tag reports an available update

- **GIVEN** a receipt whose manifest digest differs from the resolved manifest
- **WHEN** `inflexa store download` runs without `--update`
- **THEN** the command reports that an update is available, and it transfers nothing

#### Scenario: `--update` applies the moved tag

- **GIVEN** a receipt whose manifest digest differs from the resolved manifest
- **WHEN** `inflexa store download --update` runs
- **THEN** a detached process starts, and it transfers the layers of the newer manifest

#### Scenario: `--update` over a current receipt starts nothing

- **GIVEN** a receipt whose manifest digest matches the resolved manifest
- **WHEN** `inflexa store download --update` runs
- **THEN** the command reports the store as up to date, and it starts no transfer

#### Scenario: The agent retries after the user confirms

- **GIVEN** a state of `failed`, and a user who asks the agent to retry
- **WHEN** the agent runs the command
- **THEN** the CLI asks the user to approve, and the run starts after the approval

#### Scenario: The listing reports the download state

- **WHEN** `inflexa store ls` runs during a transfer
- **THEN** the output names the state and the byte totals, and it prompts for nothing

### Requirement: `inflexa store cancel` stops a live transfer

The CLI SHALL give `inflexa store cancel`. It SHALL stop the live transfer, it
SHALL record the state `canceled`, and it SHALL remove the partial staged tree.

The download process is detached, thus it outlives both `inflexa setup` and the
app. A command reaches that process from any terminal. Setup SHALL open no prompt
for the cancel, and it SHALL only name the command.

The cancel SHALL remove no installed content. It touches the staged tree only,
thus each child that the store root holds stays where it is.

When no run is live, the command SHALL report that fact and SHALL change nothing.
It SHALL write no row, it SHALL remove no tree, and it SHALL stop no process.

The command SHALL take the `blocked` policy, thus the conversation agent SHALL NOT
run it. The reason is that the cancel throws away a transfer that is part done.
The user runs the command.

The cancel is a separate subcommand and not a flag on `inflexa store download`. A
policy binds to a command, thus a flag cannot carry a policy of its own.

#### Scenario: The cancel stops a live transfer

- **GIVEN** a live download that `inflexa setup` started
- **WHEN** `inflexa store cancel` runs in a different terminal
- **THEN** the transfer stops, the state is `canceled`, and the partial staged tree is gone

#### Scenario: The cancel removes no installed content

- **GIVEN** a store root with content, and a live download
- **WHEN** `inflexa store cancel` runs
- **THEN** the staged tree is gone, and each child of the store root stays

#### Scenario: A cancel with no live run changes nothing

- **GIVEN** a machine with no live download
- **WHEN** `inflexa store cancel` runs
- **THEN** the command reports that no run is live, and it changes nothing

#### Scenario: The agent cannot run the cancel

- **GIVEN** a live download, and a user who asks the agent to stop it
- **WHEN** the agent reads the policy of the command
- **THEN** the CLI refuses the call, gives the reason, and names the command for the user

### Requirement: The agent reads the state and continues the conversation

The conversation agent SHALL read the download state with `inflexa store ls`. That
command carries the `auto` policy, thus the agent runs it with no approval. The
CLI SHALL add no command and no tool for this readout.

When the state is `pending` or `running`, the agent SHALL report the wait to the
user. It SHALL name the state and the byte totals that the listing gives. Then it
SHALL continue the conversation.

The agent SHALL NOT hold the turn until the transfer completes. Chat, the
workspace read surface, and the planner answer with no store. Thus the
conversation continues while the catalog arrives.

When the state is `failed`, `declined`, or `canceled`, the agent SHALL report the
message and SHALL name `inflexa store download`. That command carries the
`approval` policy, thus the user confirms the retry.

#### Scenario: The agent reads the state with no approval

- **GIVEN** a live transfer and a user who asks whether the packages are ready
- **WHEN** the agent runs `inflexa store ls`
- **THEN** the CLI asks for no approval, and the output gives the state and the byte totals

#### Scenario: The agent reports the wait and continues

- **GIVEN** a state of `running`
- **WHEN** the agent answers the user
- **THEN** it names the state and the byte totals, and the conversation continues

#### Scenario: The agent names the retry after a failure

- **GIVEN** a state of `failed`
- **WHEN** the agent answers the user
- **THEN** it reports the message and names `inflexa store download`, and it starts no sandbox action
