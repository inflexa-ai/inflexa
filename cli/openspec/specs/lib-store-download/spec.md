# lib-store-download Specification

## Purpose

The CLI pulls the CI-built package store from GHCR as an OCI artifact, with a
receipt on disk. It gates sandbox creation on a complete store. The app itself
never waits: chat, the workspace read surface, and the planner start at once.

## Requirements

### Requirement: The CLI pulls the store artifact from GHCR

The CLI SHALL pull the package store from GHCR as an OCI artifact, for the host
architecture. The pull SHALL be anonymous: a token GET, then a manifest GET, then
one blob GET for each layer, all over https. The CLI SHALL make sure that each
blob matches the sha256 digest of its descriptor. It SHALL refuse a blob whose
hash differs, and it SHALL NOT install that blob. The pull SHALL work without a
container engine.

#### Scenario: A layer verifies against its descriptor

- **WHEN** a blob download completes
- **THEN** the computed sha256 equals the descriptor digest, or the CLI discards the layer and the store stays incomplete

#### Scenario: No credentials are necessary

- **WHEN** the CLI pulls a published store artifact
- **THEN** the pull succeeds with an anonymous registry token and no account

### Requirement: The download runs in the background with a receipt

The download SHALL start at app open, in the background. It SHALL start only
when a store root is configured, the receipt is absent, and the user gave the
consent. When the receipt reports `update_available`, the CLI SHALL report it
and SHALL wait for the ask. It SHALL obey the receipt pattern of the reference
store: stage, rename, then write the receipt. The client SHALL extract every
layer into the staged root, and it SHALL keep the symlinks. The reassembled
root SHALL equal the store exactly, so the harness check accepts it. An
interrupted download SHALL read back as incomplete, and the next run SHALL
repair it. When no store root is configured, the CLI SHALL NOT download.

#### Scenario: The app is usable during the download

- **WHEN** the download runs
- **THEN** chat, the workspace read surface, and the planner respond normally

#### Scenario: A crash reads back as incomplete

- **WHEN** the process dies during a download
- **THEN** the next open reports the store incomplete and continues the work, and no half-written file is visible at the final path

### Requirement: Sandbox creation waits on a complete store

Each action that makes a sandbox SHALL wait until the receipt reports a complete
store, and the same hold SHALL cover a missing sandbox image. The hold SHALL
report its state and its progress to the user. The CLI SHALL NOT create a sandbox
against an incomplete store, and it SHALL NOT duplicate the harness
`libStoreUsable` check.

#### Scenario: An early analysis holds, and does not degrade silently

- **WHEN** the user starts an analysis while the download runs
- **THEN** the action holds with a visible state, and no sandbox starts with an empty store

#### Scenario: A failed download names itself at the gate

- **WHEN** the download failed and a sandbox action arrives
- **THEN** the gate reports the failure and the remedy, and it does not hold without end
