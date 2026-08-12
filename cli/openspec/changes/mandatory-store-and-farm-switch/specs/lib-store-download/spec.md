## MODIFIED Requirements

### Requirement: The download runs in the background with a receipt

No configuration value SHALL suppress the download, because the runtime image
bakes no R library and no Python library. When the receipt reports
`update_available`, the CLI SHALL report it and SHALL wait for the ask.

The trigger and the lifecycle of the download belong to
`detached-store-download-lifecycle`. That change moves the start to
`inflexa setup`, and it makes the download a detached process.

It SHALL obey the receipt pattern of the reference store: stage, rename, then
write the receipt. The client SHALL extract every layer into the staged root, and
it SHALL keep the symlinks. An interrupted download SHALL read back as incomplete,
and the next run SHALL repair it.

The store root is shared with `inflexa store add`, which provisions into the
same `store/` pool and writes its own farms. Thus the CLI SHALL MERGE the staged
tree into the store root, and it SHALL NOT remove locally provisioned content.

The merge obeys these rules:

- It SHALL move in only a child that the store root does not have. It SHALL
  leave an existing `store/` child and `farms/` child as it is. A store directory
  name carries the hash of its content, thus a skip is correct.
- On a farm name collision, it SHALL keep the local farm.
- It SHALL NOT write a `current` symlink. The catalog farm arrives as the
  template: composition reads its lock for the default closure and links its
  warm caches.

The merged root SHALL hold the published tree, so the harness check accepts it.
The download SHALL report what the merge did: the store directories added, the
farms added, and the farms kept.

#### Scenario: The app is usable during the download

- **WHEN** the download runs
- **THEN** chat, the workspace read surface, and the planner respond normally

#### Scenario: A crash reads back as incomplete

- **WHEN** the process dies during a download
- **THEN** the next open reports the store incomplete and continues the work, and no half-written file is visible at the final path

#### Scenario: A download over a locally provisioned store

- **WHEN** the user provisioned packages into the pool and then a download completes
- **THEN** each local package and each local farm is still there, and the published content sits beside it

#### Scenario: No configuration value stops the download

- **GIVEN** a configuration file with no store-related key
- **WHEN** the download runs
- **THEN** the transfer completes, because no configuration value suppresses it

#### Scenario: The merge writes no pointer

- **WHEN** the merge completes on a fresh store root
- **THEN** no `current` symlink exists at the store root, and the catalog farm is present as the template

### Requirement: Sandbox creation waits on a complete store

Each action that makes a sandbox SHALL make sure of a complete store before it
runs. The same hold SHALL cover a missing sandbox image. The hold SHALL report
its state and its progress to the user. The CLI SHALL NOT make a sandbox against an
incomplete store, and it SHALL NOT duplicate the harness `libStoreUsable` check.

The gate SHALL have no state in which it passes without a store. No runtime image
carries an R library or a Python library, thus a pass without a store would start
a sandbox that can import nothing.

A store the CLI cannot complete SHALL be a hard failure with a remedy. The gate
SHALL name the fault, SHALL name what to do, and SHALL offer a retry. It SHALL NOT
hold without end, and it SHALL NOT let the action through.

On a machine with no store, the app SHALL open at once and the gate SHALL hold at
the first action that makes a sandbox. Chat, the workspace read surface, and the
planner SHALL answer while the store is absent.

The gate SHALL report, while it holds, which state it is in. It SHALL report the
download with its running byte total, and it SHALL report the failure with its
message. Thus a user reads the progress of a multi-gigabyte download without
leaving the app. After the store completes, the gate SHALL make sure of the
sandbox image, which asks its own consent.

A failed download SHALL leave a usable app and a refused sandbox action. The gate
SHALL report the message and SHALL offer a retry at the next action. It SHALL NOT
hold without end, and it SHALL NOT start a sandbox against an incomplete store.

#### Scenario: The first run opens the app and holds at the first analysis

- **GIVEN** a machine with no store and no receipt, and a download that runs
- **WHEN** the app opens and the user then starts the first analysis
- **THEN** the app is usable at once, and the first analysis holds while the download runs

#### Scenario: The hold reports the download progress

- **WHEN** a sandbox action holds while the download runs
- **THEN** the gate reports the download state and its running byte total

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

- **GIVEN** a store on disk whose mounted farm carries no records
- **WHEN** a sandbox action arrives
- **THEN** the gate reports the store as unusable, names the remedy, and starts no sandbox
