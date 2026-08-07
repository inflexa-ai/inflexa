## ADDED Requirements

### Requirement: `inflexa store download` joins the store command family

The CLI SHALL give `inflexa store download`, beside `store add`, `store ls`,
`store use`, `store remove-farm`, and `store reclaim`. The command obtains the
published catalog for the one store root that the CLI owns.

The command SHALL start a detached download when no run is live. It SHALL report
the live run otherwise, and it SHALL start no second process. The command SHALL
exit after it starts the process. It SHALL NOT wait for the transfer.

The command SHALL take `--force`, and `--force` SHALL start a transfer over a
receipt that pins the current manifest. Without `--force`, such a receipt SHALL
make the command report the store as up to date and start nothing.

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
- **WHEN** `inflexa store download` runs without `--force`
- **THEN** the command reports the store as up to date, and it starts no process

#### Scenario: `--force` downloads over a current receipt

- **GIVEN** a receipt that pins the current manifest
- **WHEN** `inflexa store download --force` runs
- **THEN** a detached process starts and the transfer runs again

#### Scenario: The command asks for approval

- **GIVEN** a user who asks the conversation agent to retry the download
- **WHEN** the agent runs `inflexa store download`
- **THEN** the CLI asks the user to approve, and the run starts after the approval

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
SHALL name `inflexa store download` as the retry. When no row exists, it SHALL say
that no download ran, because a store can arrive by a route that wrote no row.

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

#### Scenario: A store with no download row is reported plainly

- **GIVEN** a complete store root that a manual pull made, and no download row
- **WHEN** `inflexa store ls` runs
- **THEN** the output reports the farms and says that no download ran
