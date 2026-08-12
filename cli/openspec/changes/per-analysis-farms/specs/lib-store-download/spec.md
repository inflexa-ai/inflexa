# lib-store-download Delta — Per-Analysis Farms

## MODIFIED Requirements

### Requirement: The download runs as a detached process with a receipt

`inflexa setup` SHALL start the download, and the app SHALL start none. The
process runs detached, and `lib-store-download-process` owns its lifecycle.

The download SHALL start when the receipt is absent and the user gave the consent
at setup. No configuration value SHALL suppress the download, because the runtime
image bakes no R library and no Python library.

A receipt that pins a different manifest SHALL give the outcome
`update_available`, and the run SHALL transfer nothing. `inflexa store ls` and the
sidebar SHALL report that an update is available. The user SHALL then run
`inflexa store download --update`, which is the consent to apply the moved tag. No
surface SHALL open a prompt for that consent.

It SHALL obey the receipt pattern of the reference store: stage, rename, then
write the receipt. The client SHALL extract every layer into the staged root, and
it SHALL keep the symlinks. An interrupted download SHALL read back as incomplete,
and the next run SHALL repair it.

The store root is shared with `inflexa store add`, which provisions into the same
`store/` pool. Thus the CLI SHALL MERGE the staged tree into the store root, and
it SHALL NOT remove locally provisioned content.

The merge obeys these rules:

- It SHALL move in only a child that the store root does not have. It SHALL leave
  an existing `store/` child and `farms/` child as it is. A store directory name
  carries the hash of its content, thus a skip is correct.
- On a farm name collision, it SHALL keep the local farm.
- It SHALL NOT write a `current` symlink. The catalog farm arrives as the
  template: composition reads its lock for the default closure and links its
  warm caches.
- `deps.json` SHALL merge as a store record. On `--update`, the graph of the new
  catalog replaces the old graph under the store-level metadata mutex.

The merged root SHALL hold the published tree, so the harness check accepts it.
The download SHALL report what the merge did: the store directories added, the
farms added, and the farms kept.

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

- **WHEN** the user provisioned packages into the pool and then a download completes
- **THEN** each local package and each local farm is still there, and the published content sits beside it

#### Scenario: The merge writes no pointer

- **WHEN** the merge completes on a fresh store root
- **THEN** no `current` symlink exists at the store root, and the catalog farm is present as the template

#### Scenario: The graph arrives with the catalog

- **WHEN** the merge completes
- **THEN** `deps.json` sits at the store root, and composition can walk it with no further download

#### Scenario: No configuration value stops the download

- **GIVEN** a configuration file with no store-related key
- **WHEN** setup starts the download
- **THEN** the transfer runs, and no configuration value stops it

#### Scenario: A moved tag reports an update and transfers nothing

- **GIVEN** a receipt that pins an older manifest
- **WHEN** the download resolves the moved tag
- **THEN** the outcome is `update_available`, and no layer transfers

#### Scenario: The update ask has one owner

- **GIVEN** an outcome of `update_available`
- **WHEN** the user reads `inflexa store ls` or the sidebar
- **THEN** both report the available update and name `inflexa store download --update`, and neither opens a prompt
