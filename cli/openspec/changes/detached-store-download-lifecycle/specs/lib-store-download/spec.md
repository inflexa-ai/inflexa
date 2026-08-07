## MODIFIED Requirements

### Requirement: The download runs in the background with a receipt

`inflexa setup` SHALL start the download, and the app SHALL start none. The
process runs detached, and `lib-store-download-process` owns its lifecycle.

The download SHALL start when the receipt is absent and the user gave the consent
at setup. No configuration value SHALL suppress the download, because the runtime
image bakes no R library and no Python library. When the receipt reports
`update_available`, the CLI SHALL report it and SHALL wait for the ask.

It SHALL obey the receipt pattern of the reference store: stage, rename, then
write the receipt. The client SHALL extract every layer into the staged root, and
it SHALL keep the symlinks. An interrupted download SHALL read back as incomplete,
and the next run SHALL repair it.

The store root is shared with `inflexa store add`, which provisions into the same
`store/` pool and writes its own farms. Thus the CLI SHALL MERGE the staged tree
into the store root, and it SHALL NOT remove locally provisioned content.

The merge obeys these rules:

- It SHALL move in only a child that the store root does not have. It SHALL leave
  an existing `store/` child and `farms/` child as it is. A store directory name
  carries the hash of its content, thus a skip is correct.
- On a farm name collision, it SHALL keep the local farm.
- When the store root has no `current`, it SHALL point `current` at the farm the
  download brought. When `current` is there, it SHALL leave it, because a download
  SHALL NOT switch the active farm of the user.

The merged root SHALL hold the published tree, so the harness check accepts it.
The download SHALL report what the merge did: the store directories added, the
farms added, the farms kept, and whether `current` moved. When the merge added a
farm and left `current` where it was, the CLI SHALL name that farm and the command
that switches to it.

#### Scenario: Setup starts the transfer

- **GIVEN** a machine with no receipt
- **WHEN** the user gives the consent at `inflexa setup`
- **THEN** setup starts the detached download, and the app starts none of its own

#### Scenario: The app is usable during the download

- **WHEN** the download runs
- **THEN** chat, the workspace read surface, and the planner respond normally

#### Scenario: A crash reads back as incomplete

- **WHEN** the process dies during a download
- **THEN** the next open reports the store incomplete and continues the work, and no half-written file is visible at the final path

#### Scenario: A download over a locally provisioned store

- **WHEN** the user provisioned packages into a farm and then a download completes
- **THEN** each local package and each local farm is still there, the published content sits beside it, and the active farm did not change

#### Scenario: No configuration value stops the download

- **GIVEN** a configuration file with no store-related key
- **WHEN** setup starts the download
- **THEN** the transfer runs, and no configuration value stops it

#### Scenario: An unreachable added farm is named

- **GIVEN** a store root whose `current` already selects a local farm
- **WHEN** the merge adds a published farm and leaves `current` alone
- **THEN** the CLI names the added farm and the command that switches to it

### Requirement: Sandbox creation waits on a complete store

Each action that makes a sandbox SHALL make sure of a complete store before it
runs. The same hold SHALL cover a missing sandbox image. The hold SHALL report its
state and its progress to the user. The CLI SHALL NOT make a sandbox against an
incomplete store, and it SHALL NOT duplicate the harness `libStoreUsable` check.

The gate SHALL read the download process state, and not the receipt alone. The
receipt decides whether the store is usable. The process state gives the reason
for a hold, and it gives the progress that the hold reports.
`lib-store-download-process` defines the states.

The gate SHALL start no download, and it SHALL open no consent. Setup owns the
consent, and setup starts the process. The gate SHALL name
`inflexa store download` as the retry.

The gate SHALL have no state in which it passes without a store. No runtime image
carries an R library or a Python library, thus a pass without a store would start
a sandbox that can import nothing.

A store the CLI cannot complete SHALL be a hard failure with a remedy. The gate
SHALL name the fault, SHALL name what to do, and SHALL offer a retry. It SHALL NOT
hold without end, and it SHALL NOT let the action through.

A row that reports `running` with no live holder SHALL read as `failed` at the
gate. Thus a downloader that a user killed SHALL NOT hold the action without end.

A state of `declined` SHALL refuse the action and SHALL name the retry. A user who
answered no at setup SHALL NOT meet that question again at app open.

On a machine with no store, the app SHALL open at once. The gate SHALL hold at the
first action that makes a sandbox. Chat, the workspace read surface, and the
planner SHALL answer while the store is absent.

The gate SHALL report, while it holds, which state it is in. It SHALL report the
transfer with its running byte total, and it SHALL report a failure with its
message. Thus a user reads the progress of a multi-gigabyte download without
leaving the app. After the store completes, the gate SHALL make sure of the
sandbox image, which asks its own consent.

#### Scenario: The first run opens the app and holds at the first analysis

- **GIVEN** a machine with no store, and a setup run that started the download
- **WHEN** the app opens and the user starts the first analysis
- **THEN** the app is usable at once, and the first analysis holds while the download runs

#### Scenario: The gate reads the process state

- **GIVEN** a live download that writes its progress to the row
- **WHEN** a sandbox action holds
- **THEN** the gate reports the state and the byte total from the row, and it starts no process

#### Scenario: The hold reports the download progress

- **WHEN** a sandbox action holds while the download runs
- **THEN** the gate reports the download state and its running byte total

#### Scenario: A dead downloader refuses at the gate

- **GIVEN** a row that reports `running`, whose holder process is gone
- **WHEN** a sandbox action arrives
- **THEN** the gate reports the failure, names `inflexa store download`, and does not hold without end

#### Scenario: A declined state refuses and names the retry

- **GIVEN** a download state of `declined` from a setup answer of no
- **WHEN** a sandbox action arrives
- **THEN** the gate refuses, names `inflexa store download`, and opens no consent

#### Scenario: A failed download leaves the app usable and the sandbox refused

- **GIVEN** a download that failed
- **WHEN** the user starts a sandbox action
- **THEN** the gate reports the failure and offers a retry, chat stays usable, and no sandbox starts against the incomplete store

#### Scenario: An early analysis holds, and does not degrade silently

- **WHEN** the user starts an analysis while the download runs
- **THEN** the action holds with a visible state, and no sandbox starts with an empty store

#### Scenario: A failed download names itself at the gate

- **WHEN** the download failed and a sandbox action arrives
- **THEN** the gate reports the failure and the remedy, and it does not hold without end

#### Scenario: The gate never passes without a store

- **GIVEN** a configuration file with no store-related key and no store on disk
- **WHEN** a sandbox action arrives
- **THEN** the gate holds or refuses, and it never lets the action start a sandbox

#### Scenario: An unusable store refuses the action

- **GIVEN** a store on disk whose active farm carries no records
- **WHEN** a sandbox action arrives
- **THEN** the gate reports the store as unusable, names the remedy, and starts no sandbox
