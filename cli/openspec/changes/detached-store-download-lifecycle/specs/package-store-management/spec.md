## ADDED Requirements

### Requirement: `inflexa store download` joins the store command family

The CLI SHALL give `inflexa store download`, beside `store add`, `store ls`,
`store use`, `store remove-farm`, `store reclaim`, and `store cancel`. The command
obtains the published catalog for the one store root that the CLI owns.

The command SHALL start a detached download when no run is live. It SHALL report
the live run otherwise, and it SHALL start no second process. The command SHALL
exit after it starts the process. It SHALL NOT wait for the transfer.

The command SHALL take `--update`, which is the consent to apply a moved tag.
Without the flag, a receipt that pins the current manifest SHALL make the command
report the store as up to date. Without the flag, a receipt that pins a different
manifest SHALL make the command report an available update. In both of those two
cases the command SHALL transfer nothing.

`--update` SHALL NOT transfer a healthy store a second time. Over a receipt that
pins the current manifest, the flag SHALL leave the store as it is.

The command SHALL take the `approval` policy, because it writes the store root.
Thus the conversation agent can retry the download after the user confirms.

The command SHALL name the command that reports the progress. A detached process
writes nothing to the terminal of the starter, thus the user needs that pointer.

`lib-store-download-process` owns the lifecycle that this command starts.

#### Scenario: A start with no live run

- **GIVEN** a store root with no receipt and no live downloader
- **WHEN** `inflexa store download` runs
- **THEN** a detached process starts, the command exits, and it names the command that reports the progress

#### Scenario: A second start reports the live run

- **GIVEN** a live download
- **WHEN** `inflexa store download` runs again
- **THEN** no second process starts, and the command reports the live run

#### Scenario: A complete store starts nothing

- **GIVEN** a receipt that pins the current manifest
- **WHEN** `inflexa store download` runs without `--update`
- **THEN** the command reports the store as up to date, and it starts no process

#### Scenario: A moved tag starts nothing without the flag

- **GIVEN** a receipt that pins a different manifest
- **WHEN** `inflexa store download` runs without `--update`
- **THEN** the command reports an available update, and it transfers nothing

#### Scenario: `--update` applies the moved tag

- **GIVEN** a receipt that pins a different manifest
- **WHEN** `inflexa store download --update` runs
- **THEN** a detached process starts, and it transfers the newer manifest

#### Scenario: `--update` over a current receipt starts nothing

- **GIVEN** a receipt that pins the current manifest
- **WHEN** `inflexa store download --update` runs
- **THEN** the command reports the store as up to date, and it starts no process

#### Scenario: The command asks for approval

- **GIVEN** a user who asks the conversation agent to retry the download
- **WHEN** the agent runs `inflexa store download`
- **THEN** the CLI asks the user to approve, and the run starts after the approval

### Requirement: `inflexa store cancel` joins the store command family

The CLI SHALL give `inflexa store cancel`, beside `store add`, `store ls`,
`store use`, `store remove-farm`, `store reclaim`, and `store download`. The
command stops the live catalog transfer.

The command SHALL record the state `canceled`, and it SHALL remove the partial
staged tree. It SHALL remove no installed content, thus each child that the store
root holds stays where it is.

When no run is live, the command SHALL report that fact and SHALL change nothing.

The command SHALL take the `blocked` policy. The reason is that the cancel throws
away a transfer that is part done. Thus the conversation agent names the command,
and the user runs it.

The cancel is a subcommand and not a flag on `inflexa store download`. A policy
binds to a command, thus a flag on a command of `approval` cannot carry a
`blocked` policy of its own.

`lib-store-download-process` owns the lifecycle that this command ends.

#### Scenario: The cancel stops the live run

- **GIVEN** a live download
- **WHEN** `inflexa store cancel` runs
- **THEN** the transfer stops, the state is `canceled`, and the partial staged tree is gone

#### Scenario: The cancel removes no installed content

- **GIVEN** a store root with content, and a live download
- **WHEN** `inflexa store cancel` runs
- **THEN** the staged tree is gone, and each child of the store root stays

#### Scenario: A cancel with no live run changes nothing

- **GIVEN** no live download
- **WHEN** `inflexa store cancel` runs
- **THEN** the command reports that no run is live, and it changes nothing

#### Scenario: The agent cannot run the cancel

- **GIVEN** a user who asks the conversation agent to stop the transfer
- **WHEN** the agent reads the policy of the command
- **THEN** the CLI refuses the call, gives the reason, and names the command for the user

### Requirement: `inflexa store add` refuses while a download is live

`inflexa store add` SHALL refuse while a store download is live, exactly as
`inflexa store use` does. The command SHALL name the live download, and it SHALL
name the command that reports the progress. It SHALL write nothing to the store
root.

The published artifact is not one blob. It is a set of layers. The CLI extracts
them into a staged root. It then merges that staged root into the store root one
child at a time. A provisioning run that writes into the same pool during the
merge can meet a half-merged store root.

The refusal SHALL key on a live lock holder. A run is live when the row reports
`pending` or `running`, and a process holds the download lock. A row of `running`
with no live holder reads as `failed`, thus a dead downloader SHALL NOT refuse the
command.

A `pending` row carries no holder until the child takes the lock. That window
starts no merge, because the merge comes after the transfer. Thus the window is
safe, and a provisioning run inside it meets no half-merged store root. A
`pending` row also shows nothing about the health of the starter. As a result, a
refusal on the row alone would block the command with no transfer in flight.

#### Scenario: A live download refuses the provisioning run

- **GIVEN** a live store download
- **WHEN** `inflexa store add <spec>` runs
- **THEN** the command refuses, names the live download, and writes nothing to the store root

#### Scenario: A dead downloader does not refuse the provisioning run

- **GIVEN** a row that reports `running`, whose holder process is gone
- **WHEN** `inflexa store add <spec>` runs
- **THEN** the state reads as `failed`, and the command runs

#### Scenario: A pending row with no holder does not refuse the provisioning run

- **GIVEN** a row that reports `pending`, and no holder of the download lock
- **WHEN** `inflexa store add <spec>` runs
- **THEN** the command runs, because no merge starts before the child takes the lock

## MODIFIED Requirements

### Requirement: The store can be inspected and reclaimed

The CLI SHALL report what a store holds — its packages, the farms defined against it, and the disk each occupies. It SHALL give a way to remove a farm, and a way to remove store content that no farm references. Reclamation SHALL never run implicitly as a side effect of another command.

The inspection SHALL also report the state of the active-farm pointer and the
track set of each farm. It SHALL say when the pointer resolves to nothing, because
that state makes every sandbox unusable and the user cannot see it otherwise. It
SHALL say which tracks each farm carries. A farm with fewer tracks than another is
the reason an import fails after a switch.

The inspection SHALL report the state of the download beside the farms. It SHALL
name the state, and it SHALL name the bytes transferred and the total bytes while
a transfer runs. When the state is `failed`, it SHALL report the message and it
SHALL name `inflexa store download` as the retry. When the state is `canceled`, it SHALL
say that the user stopped the transfer, and it SHALL name the same retry. When no
row exists, it SHALL say that no download ran, because a store can arrive by a
route that wrote no row.

The inspection SHALL report an available update when the recorded resolve differs
from the receipt. The row records the digest of the last resolve, and the receipt
pins the digest that is installed. The inspection SHALL name `inflexa store
download --update`, and it SHALL open no prompt. The user owns that decision.

A resolve happens only when `inflexa store download` or `inflexa setup` runs.
`inflexa store ls` stays local, and it opens no network call. Thus the two
surfaces report no update between a moved tag and the next resolve. The sidebar
obeys the same rule, because it reads the same two records.

The inspection command SHALL stay prompt-free and SHALL gain no option, because a
passive diagnostic stays passive. A new option on an `auto` command is unsafe
until the user says otherwise.

#### Scenario: Inspection reports contents and size

- **GIVEN** a populated store
- **WHEN** the user inspects it
- **THEN** the output lists the packages, the farms, and the disk used

#### Scenario: Reclamation spares referenced content

- **GIVEN** a store whose content is referenced by at least one farm
- **WHEN** reclamation runs
- **THEN** referenced content is retained and only unreferenced content is removed

#### Scenario: Reclamation is never implicit

- **WHEN** any command other than the reclamation command runs
- **THEN** no store content is removed

#### Scenario: A pointer that resolves to nothing is reported

- **GIVEN** a store whose active-farm pointer names a farm that is gone
- **WHEN** the user inspects the store
- **THEN** the output says the pointer resolves to nothing, and names the command that switches to a farm

#### Scenario: Each farm reports its tracks

- **GIVEN** a store holding one farm with a Python track and one farm with a Python track and an R track
- **WHEN** the user inspects the store
- **THEN** the output names the track set of each farm

#### Scenario: The listing reports a live transfer

- **WHEN** `inflexa store ls` runs during a transfer
- **THEN** the output names the state and the byte totals, and it prompts for nothing

#### Scenario: The listing reports a failure and its retry

- **GIVEN** a download state of `failed`
- **WHEN** `inflexa store ls` runs
- **THEN** the output names the state, reports the message, and names `inflexa store download`

#### Scenario: The listing reports an available update

- **GIVEN** a recorded resolve whose digest differs from the digest that the receipt pins
- **WHEN** `inflexa store ls` runs
- **THEN** the output says that an update is available, names `inflexa store download --update`, and opens no prompt

#### Scenario: A moved tag that no resolve saw reports no update

- **GIVEN** a receipt that matches the last recorded resolve, and a tag that moved after that resolve
- **WHEN** `inflexa store ls` runs
- **THEN** the output reports no update, and the listing opens no network call

#### Scenario: A store with no download row is reported plainly

- **GIVEN** a complete store root that a manual pull made, and no download row
- **WHEN** `inflexa store ls` runs
- **THEN** the output reports the farms and says that no download ran
