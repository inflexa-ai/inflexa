## ADDED Requirements

### Requirement: The CLI exposes a stable public reference-store directory

The CLI SHALL resolve a `refsDir` under the platform data home at `<data-home>/inflexa/refs`. Root help SHALL list the directory in its Paths table, and `inflexa refs path` SHALL print the exact resolved path without creating it. Deliberate setup or reference-download actions SHALL create the directory and a documented `user/` namespace for arbitrary user-provided reference data.

#### Scenario: User discovers the host path

- **WHEN** the user runs root help or `inflexa refs path`
- **THEN** the CLI displays the host directory whose contents sandboxes see at `/mnt/refs`

#### Scenario: Path inspection does not litter

- **WHEN** `inflexa refs path` runs before the store exists
- **THEN** it prints the path and creates no directory or metadata

### Requirement: Managed and user-owned namespaces have separate ownership

The CLI installer SHALL write catalog-managed datasets only beneath `managed/<dataset-id>/<version>` and its own metadata only beneath `.inflexa/`. It SHALL recommend `user/` for arbitrary additions and SHALL NOT overwrite, adopt, verify as managed, prune, or delete content under `user/` or unknown top-level paths.

#### Scenario: User-added reference survives managed update

- **WHEN** a user places files under `refs/user/custom-atlas/` and updates a catalog dataset
- **THEN** the installer changes only its managed dataset/version and receipt paths and leaves the custom atlas byte-for-byte untouched

### Requirement: Reference options come from the harness catalog

The CLI SHALL consume the harness-exported reference catalog and install-plan interface rather than defining a second list. `inflexa refs list` SHALL show each catalog dataset's id, version, description, total bytes, source and licensing links, recommendation/group metadata, and local state. The CLI's artifact adapter SHALL map plan artifact keys to the public distribution endpoint without changing their content identity or destination paths.

#### Scenario: Catalog option is visible with links

- **WHEN** `inflexa refs list` runs
- **THEN** every downloadable option from the installed harness version is shown with its upstream source/licensing links and local installation state

#### Scenario: Unknown id is rejected before download

- **WHEN** `inflexa refs download unknown-id` runs
- **THEN** the CLI reports the unknown id and available ids and performs no network or filesystem mutation

### Requirement: Downloads are verified and dataset activation is atomic

For each selected dataset, the CLI SHALL compute a missing-byte plan, download artifacts to installer-owned `.part` paths, verify each artifact's expected byte size and SHA-256 digest, stage every final file beneath one attempt directory, and activate the complete version directory only after all artifacts verify. It SHALL then atomically write a harness-compatible active receipt. A failed or interrupted attempt SHALL leave any previously active receipt/version unchanged and SHALL never expose a partially staged dataset as active managed content.

#### Scenario: Complete dataset activates

- **WHEN** every artifact downloads and matches its catalog size and digest
- **THEN** the complete immutable version appears under `managed/<id>/<version>` and its receipt records exactly those verified files

#### Scenario: Digest mismatch preserves prior version

- **WHEN** any downloaded artifact fails size or SHA-256 verification
- **THEN** the command fails, the staged version is not activated, and the prior active receipt and version remain unchanged

#### Scenario: Interrupted download is resumable but not visible

- **WHEN** a transfer stops after writing part of an artifact
- **THEN** resumable installer-owned partial state may remain, but no partial dataset appears as active managed reference data

### Requirement: Reference commands expose install, verification, and path operations

The CLI SHALL provide `inflexa refs list`, `inflexa refs download [ids...]`, `inflexa refs verify [ids...]`, and `inflexa refs path`. Interactive download with no ids SHALL offer a multi-select. Before transfer, download SHALL show total missing bytes and require confirmation unless explicit non-interactive consent is present. Verify SHALL hash active managed files against the catalog and receipt and SHALL report missing, modified, and valid states without modifying them.

#### Scenario: Interactive selection shows cost before consent

- **WHEN** an interactive user selects multiple missing datasets
- **THEN** the CLI shows the combined missing download size and begins transfer only after confirmation

#### Scenario: Verification detects manual damage

- **WHEN** an active managed file has been edited or removed
- **THEN** `inflexa refs verify` reports the affected dataset and file as invalid and changes no bytes

### Requirement: Setup reuses the reference download handler

Interactive `inflexa setup` SHALL deliberately create the reference-store and `user/` directories, inspect catalog installation state, and offer missing or updateable datasets with their sizes through the same headless download operation used by `inflexa refs download`. Declining or selecting nothing SHALL continue setup. A selected installation failure SHALL fail setup visibly.

Headless setup SHALL download no reference bytes unless dataset ids and non-interactive consent are explicit. Without them it SHALL print the reference-store path and an actionable `inflexa refs download` command and continue.

#### Scenario: Setup and explicit command share one installer

- **WHEN** setup installs a selected dataset
- **THEN** it produces the same managed layout, verification, activation, and receipt as `inflexa refs download` for that id

#### Scenario: Headless setup does not silently download

- **WHEN** setup runs without a TTY and without explicit reference ids and consent
- **THEN** it downloads nothing, prints how to install references later, and continues

#### Scenario: User declines optional references

- **WHEN** an interactive user declines or selects no catalog datasets
- **THEN** setup leaves the public store available for manual additions and continues successfully

### Requirement: Missing or inconsistent managed state is recoverable

Cheap status inspection SHALL derive managed state from the catalog, receipts, and filesystem and SHALL report at least missing, installed, update available, partial, and invalid-receipt states. Absence or inconsistency SHALL NOT crash the CLI. Re-running download for a selected dataset SHALL repair installer-owned content through normal staged verification and activation.

#### Scenario: Receipt references a deleted file

- **WHEN** a receipt names a managed file that is absent
- **THEN** list reports a partial or damaged state and download can repair it without database surgery or changes to user content
